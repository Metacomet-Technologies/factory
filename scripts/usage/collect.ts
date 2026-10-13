import { spawn, spawnSync } from 'node:child_process';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { age, check, emptyReading, FORMAT_CHANGED, parseAmp, parseAmpDetails, parseClaude, parseCodex, sources } from './parsers.ts';
import type { Tool, Reading } from './parsers.ts';

export const SNAPSHOT = '/var/lib/factory-usage/usage.json';
export const CLAUDE_ARGS = ['-p', '/usage', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--prompt-suggestions', 'false'];
type Details = { attempted_at_ms: number | null; reason: string | null; cli_version: string | null };
export type Snapshot = { schema_version: 1; generated_at_ms: number; amp_details: Details; tools: Tool[] };
type Previous = { amp_details: Details; tools: Pick<Tool, 'tool' | 'observed_at_ms'>[] };
const reasons = [FORMAT_CHANGED, 'timeout', 'CLI missing', 'unknown, format changed', 'CLI timed out', 'CLI failed', 'CLI output too large', 'last good reading older than 45 minutes'];
function reason(error: unknown): string {
  if (!(error instanceof Error) || !reasons.includes(error.message)) return FORMAT_CHANGED;
  if (error.message === 'unknown, format changed') return FORMAT_CHANGED;
  return error.message === 'CLI timed out' ? 'timeout' : error.message;
}

// Never expose raw stdout/stderr or exception text. One process group per probe
// ensures timeout cleanup cannot signal a runner or an unrelated CLI process.
export function command(program: string, args: string[], timeoutMs = 20_000, rpc = false): Promise<string> {
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
  const patterns: Record<string, RegExp> = { amp: /^(0\.0\.\d+-g[a-f0-9]+) \(released [0-9T:.Z-]+, [^)]+\)\s*$/, claude: /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/, codex: /^codex-cli (\d+\.\d+\.\d+)\s*$/ };
  const match = value.match(patterns[program]); check(match); return match[1];
}

export async function collect(previous: Previous | null, run: Run = command, now = Date.now()): Promise<Snapshot> {
  let details: Details = previous?.amp_details ?? { attempted_at_ms: null, reason: null, cli_version: null };
  const tools = await Promise.all(Object.entries(sources).map(async ([tool, source]): Promise<Tool> => {
    let cli_version: string | null = null;
    try {
      const program = tool === 'claude-code' ? 'claude' : tool;
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
      } else if (tool === 'claude-code') reading = parseClaude(await run('claude', CLAUDE_ARGS));
      else reading = parseCodex(JSON.parse(await run('codex', ['app-server'], 20_000, true)));
      return { tool, source, cli_version, status: 'ok', reason: null, note: null, observed_at_ms: now, ...reading };
    } catch (error) {
      // A failed probe has no live values. Only the last good timestamp survives.
      const observed_at_ms = previous?.tools.find(value => value.tool === tool)?.observed_at_ms ?? null;
      return age({ tool, source, cli_version, status: 'unknown', reason: reason(error), note: null, observed_at_ms, ...emptyReading() }, now);
    }
  }));
  for (const tool of ['cursor', 'kimi']) tools.push({ tool, source: null, cli_version: null, status: 'not_tracked', reason: null, note: null, observed_at_ms: null, ...emptyReading() });
  tools.sort((a, b) => ['amp', 'cursor', 'claude-code', 'codex', 'kimi'].indexOf(a.tool) - ['amp', 'cursor', 'claude-code', 'codex', 'kimi'].indexOf(b.tool));
  return { schema_version: 1, generated_at_ms: now, amp_details: details, tools };
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
    }, tools: tools.filter(t => Object.hasOwn(sources, t.tool)).map(t => ({ tool: t.tool, observed_at_ms: t.observed_at_ms })) };
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let fd: number | undefined;
  try {
    if (process.versions.node !== '24.21.0') throw new Error('Unsupported runtime');
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
  } catch {
    console.error('Usage collector failed: check runtime, arguments, lock and snapshot permissions.');
    process.exitCode = 1;
  } finally { if (fd !== undefined) closeSync(fd); }
}
