import { spawn, spawnSync } from 'node:child_process';
import { open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { age, check, emptyReading, FORMAT_CHANGED, parseAmp, parseAmpDetails, parseClaude, parseCodex, parseCursor, parseKimi, parseOpencode, parseOpencodeV2, sources, TOOL_ORDER } from './parsers.ts';
import type { Tool, Reading } from './parsers.ts';
import { ADMIN_INTERVAL_MS, ADMIN_REJECTED, cursorReading, defaultAdmin, fetchCursor, validState } from './cursor.ts';
import type { AdminDeps, CursorState } from './cursor.ts';

export const SNAPSHOT = '/var/lib/factory-usage/usage.json';
export const CLAUDE_ARGS = ['-p', '/usage', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--prompt-suggestions', 'false'];
type Details = { attempted_at_ms: number | null; reason: string | null; cli_version: string | null };
export type Snapshot = { schema_version: 1; generated_at_ms: number; amp_details: Details; cursor_admin: CursorState | null; tools: Tool[] };
type Previous = { amp_details: Details; cursor_admin?: CursorState | null; tools: Pick<Tool, 'tool' | 'observed_at_ms'>[] };
const reasons = [FORMAT_CHANGED, 'timeout', 'CLI missing', 'unknown, format changed', 'CLI timed out', 'CLI failed', 'CLI output too large', 'last good reading older than 45 minutes', 'not logged in', ADMIN_REJECTED];
function reason(error: unknown): string {
  if (!(error instanceof Error) || !reasons.includes(error.message)) return FORMAT_CHANGED;
  if (error.message === 'unknown, format changed') return FORMAT_CHANGED;
  return error.message === 'CLI timed out' ? 'timeout' : error.message;
}

// Never expose raw stdout/stderr or exception text. One process group per probe
// ensures timeout cleanup cannot signal a runner or an unrelated CLI process.
function kimiPort(): number {
  const raw = process.env.FACTORY_KIMI_PORT;
  if (raw == null || raw === '') return 58627;
  if (!/^\d+$/.test(raw)) throw new Error('CLI failed');
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error('CLI failed');
  return port;
}
function kimiTokenPath(): string {
  const root = process.env.KIMI_CODE_HOME;
  if (root != null && root !== '') {
    if (!root.startsWith('/') || root.includes('\0')) throw new Error('CLI failed');
    return join(root, 'server.token');
  }
  const home = process.env.HOME;
  if (!home?.startsWith('/') || home.includes('\0')) throw new Error('CLI failed');
  return join(home, '.kimi-code', 'server.token');
}
function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 200 });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
async function readKimiToken(): Promise<string> {
  let info;
  try { info = await lstat(kimiTokenPath()); } catch { throw new Error('CLI failed'); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid() || info.size < 16 || info.size > 128) throw new Error('CLI failed');
  const token = (await readFile(kimiTokenPath(), 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error('CLI failed');
  return token;
}
function httpGet(port: number, token: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: 'http:', hostname: '127.0.0.1', port, method: 'GET', path: '/api/v1/oauth/usage',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, Connection: 'close' },
      timeout: timeoutMs,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('CLI failed')); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > 65_536) { req.destroy(); reject(new Error('CLI output too large')); }
      });
      res.on('end', () => resolve(body));
      res.on('error', () => reject(new Error('CLI failed')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', () => reject(new Error('CLI failed')));
    req.end();
  });
}
// `kimi usage` is not a real subcommand. Talk only to 127.0.0.1, discard the
// banner (it prints the bearer token), and never call the upstream quota URL.
async function kimiUsage(program: string, timeoutMs: number): Promise<string> {
  const port = kimiPort();
  const deadline = Date.now() + timeoutMs;
  const left = () => { const value = deadline - Date.now(); if (value <= 0) throw new Error('timeout'); return value; };
  let child: ReturnType<typeof spawn> | undefined;
  let owns = false;
  try {
    if (!(await canConnect(port))) {
      owns = true;
      let spawnError: string | undefined;
      child = spawn(program, ['web', '--no-open', '--port', String(port)], { detached: true, stdio: 'ignore' });
      child.on('error', error => { spawnError = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'CLI missing' : 'CLI failed'; });
      const ready = Date.now() + Math.min(left(), 8_000);
      while (Date.now() < ready && !(await canConnect(port))) {
        if (spawnError) throw new Error(spawnError);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (spawnError) throw new Error(spawnError);
      if (!(await canConnect(port))) throw new Error('timeout');
    }
    return await httpGet(port, await readKimiToken(), left());
  } finally {
    if (owns && child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  }
}
export function command(program: string, args: string[], timeoutMs = 20_000, rpc = false): Promise<string> {
  if (args.length === 1 && args[0] === 'usage' && program.split(/[/\\]/).pop() === 'kimi') return kimiUsage(program, timeoutMs);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', pending = '', phase = 1, done = false;
    const finish = (error?: string, value = output) => {
      if (done) return;
      done = true; clearTimeout(timer);
      child.stdin.destroy();
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
      if (error) reject(new Error(error)); else resolve(value);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const send = (value: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
    child.on('error', error => finish((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'CLI missing' : 'CLI failed'));
    child.stdin.on('error', () => finish('CLI failed'));
    child.on('close', code => finish(code === 0 && !rpc ? undefined : 'CLI failed'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 2_000_000) { finish('CLI output too large'); return; }
      if (!rpc || done) return;
      pending += chunk;
      while (pending.includes('\n') && !done) {
        const end = pending.indexOf('\n');
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (phase === 1 && message.id === 1) {
            check(message.result && !message.error);
            phase = 2;
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'account/rateLimits/read' });
          } else if (phase === 2 && message.id === 2) finish(undefined, line);
        } catch { finish(FORMAT_CHANGED); }
      }
    });
    if (rpc) send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'factory_usage_collector', title: 'Factory Usage Collector', version: '0.1.0' } } });
    else child.stdin.end();
  });
}
type Run = typeof command;
function version(program: string, value: string): string {
  const patterns: Record<string, RegExp> = {
    amp: /^(0\.0\.\d+-g[a-f0-9]+) \(released [0-9T:.Z-]+, [^)]+\)\s*$/,
    claude: /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/,
    codex: /^codex-cli (\d+\.\d+\.\d+)\s*$/,
    agent: /^(\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+)\s*$/,
    kimi: /^(\d+\.\d+\.\d+)\s*$/,
    opencode: /^(?:opencode v)?(\d+\.\d+\.\d+)\s*$/,
  };
  const match = value.match(patterns[program]); check(match); return match[1];
}
const programs: Record<string, string> = { amp: 'amp', cursor: 'agent', 'claude-code': 'claude', codex: 'codex', kimi: 'kimi', opencode: 'opencode' };

export async function collect(previous: Previous | null, run: Run = command, now = Date.now(), admin: () => AdminDeps = defaultAdmin): Promise<Snapshot> {
  let details: Details = previous?.amp_details ?? { attempted_at_ms: null, reason: null, cli_version: null };
  let cursorAdmin: CursorState | null = previous?.cursor_admin ?? null;
  const tools = await Promise.all(Object.entries(sources).map(async ([tool, source]): Promise<Tool> => {
    let cli_version: string | null = null;
    try {
      const program = programs[tool];
      cli_version = version(program, await run(program, ['--version']));
      let reading: Reading;
      if (tool === 'amp') {
        reading = parseAmp(await run('amp', ['usage']));
        if (details.cli_version !== cli_version || details.attempted_at_ms === null || now - details.attempted_at_ms >= 3_600_000) {
          // A new CLI needs fresh validation. Every attempt restarts hourly backoff,
          // including failures, so an update does not add a second hourly allowance.
          details = { attempted_at_ms: now, reason: null, cli_version };
          try { parseAmpDetails(await run('amp', ['usage', '--details'])); }
          catch (error) { details.reason = reason(error); }
        }
        if (details.reason) throw new Error(details.reason);
      } else if (tool === 'cursor') {
        reading = parseCursor(await run('agent', ['about', '--format', 'json']));
        const deps = admin();
        const key = await deps.readKey();
        // One logical Admin fetch per hour, whatever the key file: failures, a removed
        // key and a replaced key all count against the same hourly attempt.
        const due = cursorAdmin === null || now - cursorAdmin.attempted_at_ms >= ADMIN_INTERVAL_MS;
        if (key === null) { if (due) cursorAdmin = null; }
        else {
          if (due) {
            cursorAdmin = { attempted_at_ms: now, key_id: key.id, reason: null, data: null };
            try { cursorAdmin.data = await fetchCursor(deps, key.key, now); }
            catch (error) { cursorAdmin.reason = reason(error); }
          }
          // A result fetched with another key file is never shown or used to validate
          // this one; until the next hourly fetch the row stays plan-only.
          if (cursorAdmin!.key_id === key.id) {
            const observed_at_ms = previous?.tools.find(value => value.tool === tool)?.observed_at_ms ?? null;
            // A rejected key keeps the plan visible; other Admin failures fail closed.
            if (cursorAdmin!.reason === ADMIN_REJECTED) return age({ tool, source, cli_version, status: 'unknown', reason: ADMIN_REJECTED, note: null, observed_at_ms, ...emptyReading(), plan: reading.plan }, now);
            if (cursorAdmin!.reason) throw new Error(cursorAdmin!.reason);
            const data = cursorAdmin!.data!;
            reading = cursorReading(reading, data, now);
            if (reading.balances.length > 0) return { tool, source, cli_version, status: 'ok', reason: null, note: null, observed_at_ms: data.fetched_at_ms, ...reading };
          }
        }
      }
      else if (tool === 'claude-code') reading = parseClaude(await run('claude', CLAUDE_ARGS));
      else if (tool === 'codex') reading = parseCodex(JSON.parse(await run('codex', ['app-server'], 20_000, true)));
      else if (tool === 'kimi') reading = parseKimi(await run('kimi', ['usage']));
      else if (Number(cli_version.split('.')[0]) >= 2) reading = parseOpencodeV2(await run('opencode', ['stats', '--all', '--cost'], 35_000));
      else reading = parseOpencode(await run('opencode', ['stats']));
      return { tool, source, cli_version, status: 'ok', reason: null, note: null, observed_at_ms: now, ...reading };
    } catch (error) {
      // A failed probe has no live values. Only the last good timestamp survives.
      const observed_at_ms = previous?.tools.find(value => value.tool === tool)?.observed_at_ms ?? null;
      return age({ tool, source, cli_version, status: 'unknown', reason: reason(error), note: null, observed_at_ms, ...emptyReading() }, now);
    }
  }));
  tools.sort((a, b) => TOOL_ORDER.indexOf(a.tool as typeof TOOL_ORDER[number]) - TOOL_ORDER.indexOf(b.tool as typeof TOOL_ORDER[number]));
  return { schema_version: 1, generated_at_ms: now, amp_details: details, cursor_admin: cursorAdmin, tools };
}

export async function readPrevious(path: string, now = Date.now()): Promise<Previous | null> {
  try {
    const text = await readFile(path, 'utf8'); check(text.length < 100_000);
    const data = JSON.parse(text); check(data.schema_version === 1 && Array.isArray(data.tools));
    const timestamp = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= now);
    check(timestamp(data.amp_details?.attempted_at_ms));
    check(data.amp_details.reason === null || reasons.includes(data.amp_details.reason));
    check(data.amp_details.cli_version === null || (typeof data.amp_details.cli_version === 'string' && /^0\.0\.\d+-g[a-f0-9]+$/.test(data.amp_details.cli_version)));
    const tools: Previous['tools'] = data.tools;
    check(tools.every(t => typeof t.tool === 'string' && timestamp(t.observed_at_ms)));
    // Only scheduling and last-good timestamps are read; never copy stored text.
    return { amp_details: {
      attempted_at_ms: data.amp_details.attempted_at_ms, reason: data.amp_details.reason, cli_version: data.amp_details.cli_version,
    }, cursor_admin: data.cursor_admin == null ? null : validState(data.cursor_admin, now), tools: tools.filter(t => Object.hasOwn(sources, t.tool)).map(t => ({ tool: t.tool, observed_at_ms: t.observed_at_ms })) };
  } catch { return null; }
}

export async function writeSnapshot(path: string, snapshot: Snapshot): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o640);
    try {
      await file.chmod(0o640);
      await file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`);
      await file.sync();
    }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

export function supportedNode(version: string): boolean {
  const match = version.match(/^24\.(\d+)\.(\d+)$/);
  return match !== null && Number(match[1]) >= 12;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let fd: number | undefined;
  try {
    if (!supportedNode(process.versions.node)) throw new Error(`Use Node 24.x (>= 24.12.0); found ${process.versions.node}`);
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) throw new Error('Invalid arguments');
    // Same lock from all worktrees once deployed; a fresh worktree uses its own
    // existing inode before the main checkout contains this collector.
    const mainLock = '/home/agent/work/factory/scripts/usage/collect.lock';
    try { fd = openSync(mainLock, 'r'); } catch { fd = openSync(new URL('./collect.lock', import.meta.url), 'r'); }
    check(spawnSync('flock', ['--exclusive', '--timeout', '60', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status === 0);
    const path = process.env.FACTORY_USAGE_SNAPSHOT ?? SNAPSHOT;
    const snapshot = await collect(await readPrevious(path));
    if (args[0] === '--dry-run') console.log(JSON.stringify(snapshot, null, 2));
    else await writeSnapshot(path, snapshot);
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith('Use Node 24.x')
      ? error.message
      : 'Usage collector failed: check runtime, arguments, lock and snapshot permissions.';
    console.error(message);
    process.exitCode = 1;
  } finally { if (fd !== undefined) closeSync(fd); }
}
