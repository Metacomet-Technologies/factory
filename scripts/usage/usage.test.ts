import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, chown, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collect, command, readPrevious, writeSnapshot, CLAUDE_ARGS, supportedNode } from './collect.ts';
import { age, FORMAT_CHANGED, parseAmp, parseAmpDetails, parseClaude, parseCodex, parseCursor, parseKimi, parseOpencode, parseOpencodeV2, STALE_MS } from './parsers.ts';
import { cursorReading, fetchCursor, nextCycle, readAdminKey } from './cursor.ts';
import type { AdminDeps } from './cursor.ts';
import { cursorCycleStart, cursorEventPages, cursorSpendPages, cursorTeams } from './fixtures.ts';
import { amp, ampAutoReload, ampNew, details, detailsAutoReload, detailsNew, claude, codex, cursorAbout, cursorLoggedOut, kimiLive, kimiLoggedOut, kimiUsage, opencodeStats, opencodeV2ShareCard, opencodeV2Stats, opencodeV2Zero, fixtureRun, versions } from './fixtures.ts';
const now = 1791800000000;
// Never read a real Cursor admin key from this host during tests.
process.env.FACTORY_CURSOR_ADMIN_KEY_FILE = '/nonexistent/factory-usage-test/cursor-admin-key';

test('supported Node versions require Node 24.12.0 or newer', () => {
  for (const version of ['24.12.0', '24.21.0', '24.22.0']) assert.equal(supportedNode(version), true);
  for (const version of ['24.11.1', '22.18.0', '25.0.0', '26.1.0', '24.12', 'v24.12.0', '24.12.0-beta']) assert.equal(supportedNode(version), false);
});

test('verified projections preserve units, percentages, scope and UTC milliseconds', async () => {
  const snapshot = await collect(null, fixtureRun, now);
  assert.deepEqual(snapshot.tools.map(t => t.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(snapshot.tools.map(t => t.tool), ['amp', 'cursor', 'claude-code', 'codex', 'kimi', 'opencode']);
  const cursor = snapshot.tools[1], kimi = snapshot.tools[4], opencode = snapshot.tools[5];
  assert.equal(cursor.plan, 'pro'); assert.deepEqual(cursor.windows, []); assert.deepEqual(cursor.balances, []);
  assert.deepEqual(kimi.windows.map(w => [w.name, w.used_percent, w.window_minutes]), [['five_hour', 20, 300], ['weekly', 8, 10080], ['monthly', 35, null]]);
  assert.equal(kimi.balance?.amount, '12.5'); assert.equal(kimi.balance?.total, '50');
  assert.equal(opencode.balances[0].label, 'session cost'); assert.equal(opencode.balances[0].amount, '12.50'); assert.deepEqual(opencode.windows, []);
  const [a, , c, x] = snapshot.tools;
  assert.deepEqual(a.balances, [
    { amount: '171.27', remaining: '171.27', total: '200', unit: 'usd' },
    { amount: '998.1', remaining: '998.1', total: '1000', unit: 'orb_hours' },
  ]);
  assert.deepEqual(a.windows.map(w => [w.used_percent, w.resets_at_ms]), [[14, 1794268800000], [0, 1794268800000]]);
  assert.deepEqual(c.windows.map(w => [w.name, w.used_percent, w.resets_at_ms, w.window_minutes]), [
    ['five_hour', 13, 1791774600988, 300], ['weekly', 12, 1792105200988, 10080], ['weekly_fable', 0, 1792105200000, 10080],
  ]);
  assert.equal(c.plan, null);
  assert.deepEqual(x.windows, [{ name: 'weekly', used_percent: 17, resets_at_ms: 1792299781000, window_minutes: 10080 }]);
  assert.equal(x.balance?.unit, 'codex_credits'); assert.equal(x.balance?.amount, '62500'); assert.equal(x.reset_credits_available, 3);
  assert.doesNotMatch(JSON.stringify(snapshot), /redacted@|private-|tokens|prompt|accountId|request_id|1,234|1\.2K|12\.5K|1\.0M|kimi-code/);
});

test('Amp plain summaries preserve workspace balance without identity or invented total', async () => {
  const snapshot = await collect(null, async (program, args) => {
    if (program !== 'amp') return fixtureRun(program, args);
    if (args[0] === '--version') return '0.0.1791864325-g52e626 (released 2026-10-13T04:05:25.000Z, 2h ago)';
    return args.includes('--details') ? detailsNew : ampNew;
  }, now);
  const a = snapshot.tools[0];
  assert.equal(a.status, 'ok');
  assert.equal(a.plan, 'Gigawatt');
  assert.deepEqual(a.balances, [
    { amount: '170.30', remaining: '170.30', total: '200', unit: 'usd' },
    { amount: '997.4', remaining: '997.4', total: '1000', unit: 'orb_hours' },
    { amount: '0', remaining: '0', total: null, unit: 'usd', label: 'workspace metacomet' },
  ]);
  assert.deepEqual(a.balance, a.balances[0]);
  assert.deepEqual(a.windows.map(w => [w.used_percent, w.resets_at_ms]), [[15, 1794268800000], [0, 1794268800000]]);
  assert.doesNotMatch(JSON.stringify(snapshot), /redacted|@|Signed in as/);
  for (const text of [ampNew.replace('a1.xxlarge ', '').replace('upon renewal ', ''), ampNew.split('\n').slice(1).join('\n')]) {
    assert.deepEqual(parseAmp(text), parseAmp(ampNew));
  }
  assert.equal(parseAmp(ampNew.replace('$0 remaining', '$12.34 remaining')).balances[2].amount, '12.34');
  const bounded = ampNew + Array.from({ length: 5 }, (_, i) => `Workspace test-${i}: $1 remaining - https://ampcode.com/workspaces/test-${i}\n`).join('');
  assert.equal(parseAmp(bounded).balances.length, 8);
  for (const text of [
    `${bounded}Workspace overflow: $1 remaining - https://ampcode.com/workspaces/overflow\n`,
    `${ampNew}unexpected extra line\n`,
    ampNew.replace('/workspaces/metacomet', '/workspaces/other'),
    `${ampNew}${ampNew.split('\n')[2]}\n`,
    ampNew.replace('a1.xxlarge', 'unknown-size'),
    ampNew.replace('resets upon renewal', 'resets maybe'),
  ]) {
    const failed = await collect(snapshot, async (program, args) => program === 'amp' && args[0] === 'usage' ? text : fixtureRun(program, args), now + STALE_MS + 1);
    assert.equal(failed.tools[0].status, 'stale');
    assert.equal(failed.tools[0].reason, FORMAT_CHANGED);
    assert.deepEqual(failed.tools[0].balances, []);
    const unknown = await collect(null, async (program, args) => program === 'amp' && args[0] === 'usage' ? text : fixtureRun(program, args), now);
    assert.equal(unknown.tools[0].status, 'unknown');
    assert.equal(unknown.tools[0].reason, FORMAT_CHANGED);
  }
});

test('Amp accepts only the exact optional auto-reload note and validates new-version details', async () => {
  const previous = await collect(null, fixtureRun, now);
  const snapshot = await collect(previous, async (program, args) => {
    if (program !== 'amp') return fixtureRun(program, args);
    if (args[0] === '--version') return versions.ampAutoReload;
    return args.includes('--details') ? detailsAutoReload : ampAutoReload;
  }, now + 15 * 60_000);
  const a = snapshot.tools[0];
  assert.equal(a.status, 'ok');
  assert.equal(a.cli_version, '0.0.1792108872-gab0eb7');
  assert.deepEqual(a.balances, [
    { amount: '170.29', remaining: '170.29', total: '200', unit: 'usd' },
    { amount: '997.2', remaining: '997.2', total: '1000', unit: 'orb_hours' },
    { amount: '0', remaining: '0', total: null, unit: 'usd', label: 'workspace metacomet' },
  ]);
  assert.deepEqual(a.windows.map(w => w.used_percent), [15, 0]);
  assert.doesNotThrow(() => parseAmpDetails(detailsAutoReload));
  for (const text of [
    ampAutoReload.replace('(set up auto-reload to avoid running out)', '(auto-reload on)'),
    ampAutoReload.replace(' - https://ampcode.com/settings', ' (set up auto-reload to avoid running out) - https://ampcode.com/settings'),
  ]) assert.throws(() => parseAmp(text), { message: FORMAT_CHANGED });
});

test('new Claude and Codex versions stay ok unless the version or usage format changes', async () => {
  const newer = { claude: '2.1.297 (Claude Code)', codex: 'codex-cli 0.163.0' };
  for (const change of ['none', 'version', 'usage']) {
    const snapshot = await collect(null, async (program, args) => {
      if (!Object.hasOwn(newer, program)) return fixtureRun(program, args);
      if (args[0] === '--version') return newer[program] + (change === 'version' ? ' unexpected' : '');
      const output = await fixtureRun(program, args);
      return change === 'usage' ? output.replaceAll(program === 'claude' ? '"percent"' : '"usedPercent"', '"percentage"') : output;
    }, now);
    for (const [index, expectedVersion] of [[2, '2.1.297'], [3, '0.163.0']] as const) {
      const tool = snapshot.tools[index];
      assert.equal(tool.status, change === 'none' ? 'ok' : 'unknown');
      assert.equal(tool.reason, change === 'none' ? null : FORMAT_CHANGED);
      assert.equal(tool.cli_version, change === 'version' ? null : expectedVersion);
      assert.equal(tool.windows.length > 0, change === 'none');
    }
    assert.equal(snapshot.tools[0].status, 'ok');
  }
});

test('format drift and nonzero Claude inference fail closed, with nullable resets retained', () => {
  assert.throws(() => parseAmp(amp.replace('remaining (86%)', 'left (86%)')), { message: FORMAT_CHANGED });
  assert.throws(() => parseAmp(amp.replace('$171.27', '$201')), { message: FORMAT_CHANGED });
  assert.throws(() => parseAmpDetails(details.replace('Recorded cost |', 'Cost |')), { message: FORMAT_CHANGED });
  assert.throws(() => parseClaude(claude.replace('"num_turns":0', '"num_turns":1')), { message: FORMAT_CHANGED });
  assert.throws(() => parseClaude(claude.replace('"percent":13', '"percent":101')), { message: FORMAT_CHANGED });
  assert.throws(() => parseClaude(claude.replace('2026-10-12T03', '2026-02-30T03')), { message: FORMAT_CHANGED });
  assert.equal(parseClaude(claude.replace('2026-10-12T03:10:00.988448+00:00', '2026-10-11T23:10:00.988448-04:00')).windows[0].resets_at_ms, 1791774600988);
  assert.equal(parseClaude(claude.replace('"2026-10-12T03:10:00.988448+00:00"', 'null')).windows[0].resets_at_ms, null);
  assert.throws(() => parseCodex({ ...codex, id: 1 }), { message: FORMAT_CHANGED });
  assert.throws(() => parseCodex({ ...codex, error: { message: 'private-secret' } }), { message: FORMAT_CHANGED });
});

test('one failure never blanks other sources; last-good timestamp ages strictly after 45 minutes', async () => {
  const good = await collect(null, fixtureRun, now);
  const run = async (p, a) => { if (p === 'claude' && a[0] !== '--version') throw new Error('private-token@example.invalid'); return fixtureRun(p, a); };
  const failed = await collect(good, run, now + STALE_MS);
  assert.deepEqual(failed.tools.map(t => t.status), ['ok', 'ok', 'unknown', 'ok', 'ok', 'ok']);
  assert.equal(failed.tools[2].observed_at_ms, now);
  assert.deepEqual(failed.tools[2].windows, []);
  assert.equal(age(failed.tools[2], now + STALE_MS + 1).status, 'stale');
  assert.equal(age(good.tools[0], now + STALE_MS + 1).status, 'stale');
  assert.doesNotMatch(JSON.stringify(failed), /private-token/);
  const oldFailure = await collect(failed, run, now + STALE_MS + 1);
  assert.equal(oldFailure.tools[2].status, 'stale');
  assert.equal(oldFailure.tools[2].observed_at_ms, now);
});

test('Amp details attempts are at most hourly, including failures', async () => {
  let calls = 0;
  const run = async (p, a) => { if (p === 'amp' && a.includes('--details')) { calls++; throw new Error('CLI timed out'); } return fixtureRun(p, a); };
  let snapshot = await collect(null, run, now);
  assert.equal(snapshot.tools[0].status, 'unknown');
  for (const minutes of [15, 30, 45, 59]) snapshot = await collect(snapshot, run, now + minutes * 60_000);
  assert.equal(calls, 1);
  snapshot = await collect(snapshot, run, now + 60 * 60_000);
  assert.equal(calls, 2);
  assert.equal(snapshot.amp_details.attempted_at_ms, now + 3_600_000);
});

test('Amp CLI updates refresh details immediately and restart hourly backoff, including failures', async () => {
  const previous = await collect(null, fixtureRun, now);
  const cliVersion = '0.0.1791864325-g52e626';
  for (const output of [detailsNew, 'unexpected details format']) {
    let calls = 0;
    const run = async (program, args) => {
      if (program !== 'amp') return fixtureRun(program, args);
      if (args[0] === '--version') return `${cliVersion} (released 2026-10-13T04:05:25.000Z, 2h ago)`;
      if (args.includes('--details')) { calls++; return output; }
      return ampNew;
    };
    const refreshedAt = now + 15 * 60_000;
    let snapshot = await collect(previous, run, refreshedAt);
    assert.equal(calls, 1);
    assert.equal(snapshot.amp_details.cli_version, cliVersion);
    assert.equal(snapshot.amp_details.attempted_at_ms, refreshedAt);
    const a = snapshot.tools[0];
    assert.equal(a.status, output === detailsNew ? 'ok' : 'unknown');
    assert.equal(a.reason, output === detailsNew ? null : FORMAT_CHANGED);
    assert.deepEqual(a.balances, output === detailsNew ? [
      { amount: '170.30', remaining: '170.30', total: '200', unit: 'usd' },
      { amount: '997.4', remaining: '997.4', total: '1000', unit: 'orb_hours' },
      { amount: '0', remaining: '0', total: null, unit: 'usd', label: 'workspace metacomet' },
    ] : []);
    // The forced attempt counts against scheduling, not an extra hourly allowance.
    for (const minutes of [15, 45, 59]) snapshot = await collect(snapshot, run, refreshedAt + minutes * 60_000);
    assert.equal(calls, 1);
    snapshot = await collect(snapshot, run, refreshedAt + 60 * 60_000);
    assert.equal(calls, 2);
    assert.equal(snapshot.amp_details.attempted_at_ms, refreshedAt + 3_600_000);
  }
});

test('process timeout and output cap return fixed diagnostics', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100), { message: 'timeout' });
  await assert.rejects(command('/missing-private-cli', []), { message: 'CLI missing' });
  await assert.rejects(command(process.execPath, ['-e', 'console.error("private-secret"); process.exit(1)']), { message: 'CLI failed' });
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("x".repeat(2100000))']), { message: 'CLI output too large' });
  const good = await collect(null, fixtureRun, now);
  for (const reason of ['timeout', 'CLI missing']) {
    const run = async (program, args) => {
      if (program === 'claude') throw new Error(reason);
      return fixtureRun(program, args);
    };
    const failed = await collect(good, run, now + STALE_MS);
    assert.equal(failed.tools[2].status, 'unknown');
    assert.equal(failed.tools[2].reason, reason);
    const stale = await collect(failed, run, now + STALE_MS + 1);
    assert.equal(stale.tools[2].status, 'stale');
    assert.equal(stale.tools[2].reason, reason);
  }
});

test('Codex handshake waits for id 1 then id 2, ignores notifications, and keeps stdin open', async () => {
  const script = `
    const readline = require('node:readline'); let stage=0;
    readline.createInterface({input:process.stdin}).on('line', line=>{
      const m=JSON.parse(line); if(m.jsonrpc!=='2.0') process.exit(1);
      if(stage===0 && m.id===1 && m.method==='initialize') {
        stage++; setTimeout(()=>console.log(JSON.stringify({id:1,result:{}})),30);
      } else if(stage===1 && m.method==='initialized') stage++;
      else if(stage===2 && m.id===2 && m.method==='account/rateLimits/read') {
        stage++; console.log(JSON.stringify({method:'notification',accountId:'private-account'}));
        setTimeout(()=>{const s=${JSON.stringify(JSON.stringify(codex))}; process.stdout.write(s.slice(0,17)); setTimeout(()=>process.stdout.write(s.slice(17)+'\\n'),20);},40);
      } else process.exit(1);
    }); process.stdin.on('end',()=>process.exit(1));
  `;
  const result = await command(process.execPath, ['-e', script], 2000, true);
  assert.deepEqual(parseCodex(JSON.parse(result)), parseCodex(codex));
});

test('atomic replacement inherits the setgid directory group and preserves owner, 0640 and complete JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-test-'));
  try {
    // Use a non-primary group when available without requiring root or service accounts in CI.
    const gid = process.getgroups().find(group => group !== process.getgid()) ?? process.getgid();
    await chown(dir, -1, gid);
    await chmod(dir, 0o2750);
    assert.equal((await stat(dir)).mode & 0o7777, 0o2750);
    const path = join(dir, 'usage.json');
    const snapshot = await collect(null, fixtureRun, now);
    await writeSnapshot(path, snapshot);
    const checkPermissions = async () => {
      const file = await stat(path);
      assert.equal(file.uid, process.getuid());
      assert.equal(file.gid, gid);
      assert.equal(file.mode & 0o7777, 0o640);
    };
    await checkPermissions();
    const original = await open(path, 'r');
    let reading = true;
    const reads = (async () => { while (reading) assert.equal(JSON.parse(await readFile(path, 'utf8')).schema_version, 1); })();
    try {
      for (let i = 0; i < 10; i++) {
        await writeSnapshot(path, { ...snapshot, generated_at_ms: now + i });
        await checkPermissions();
      }
      // An open reader keeps the old contents; inode numbers may be reused after unlink.
      assert.deepEqual(JSON.parse(await original.readFile('utf8')), snapshot);
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...snapshot, generated_at_ms: now + 9 });
    } finally {
      reading = false;
      try { await reads; } finally { await original.close(); }
    }
    assert.deepEqual(await readdir(dir), ['usage.json']);
    assert.equal((await readPrevious(path, now + 100))?.tools[0].observed_at_ms, now);
    await writeFile(path, '{"tools":"private-secret"}'); assert.equal(await readPrevious(path), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Fake binaries for all six CLIs; each prints decoy secrets on stderr.
async function writeFakeClis(dir: string) {
  const scripts: Record<string, string> = {
    amp: `const o=${JSON.stringify({ version: '0.0.1791763306-ged595a (released 2026-10-12T00:01:46.000Z, 1d ago)', summary: amp, details })}; console.error('private-secret'); console.log(process.argv[2]==='--version'?o.version:process.argv.includes('--details')?o.details:o.summary);`,
    claude: `const o=${JSON.stringify({ version: '2.1.296 (Claude Code)', summary: claude })}; console.error('private-secret'); console.log(process.argv[2]==='--version'?o.version:o.summary);`,
    codex: `if(process.argv[2]==='--version') console.log('codex-cli 0.162.1'); else {require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l); if(m.id===1) console.log(JSON.stringify({id:1,result:{}})); if(m.id===2) console.log(${JSON.stringify(JSON.stringify(codex))});});}`,
    agent: `const body=${JSON.stringify(JSON.stringify(cursorAbout))}; console.error('redacted@example.invalid'); console.log(process.argv[2]==='--version'?'2026.10.16-e3cb207':body);`,
    opencode: `console.error('12.5K'); console.log(process.argv[2]==='--version'?'1.19.3':${JSON.stringify(opencodeStats)});`,
    kimi: `const http=require('node:http'),fs=require('node:fs'),path=require('node:path'); if(process.argv[2]==='--version'){console.log('2.2.0');process.exit(0)} if(process.argv[2]!=='web'||process.argv[3]!=='--no-open'||process.argv[4]!=='--port') process.exit(1); const token='fixturetokenvalue0001'; const dir=path.join(process.env.HOME,'.kimi-code'); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'server.token'),token,{mode:0o600}); fs.chmodSync(path.join(dir,'server.token'),0o600); console.log('Token: '+token); const body=${JSON.stringify(JSON.stringify(kimiUsage))}; http.createServer((req,res)=>{ if(req.url!=='/api/v1/oauth/usage'||req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end('denied');return} res.writeHead(200,{'content-type':'application/json'}); res.end(body); }).listen(Number(process.argv[5]),'127.0.0.1');`,
  };
  for (const [program, script] of Object.entries(scripts)) await writeFile(join(dir, program), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
}

test('CLI dry-run writes nothing and logs only sanitized snapshot using fake binaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-cli-'));
  try {
    await writeFakeClis(dir);
    const path = join(dir, 'usage.json');
    const env = { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, FACTORY_USAGE_SNAPSHOT: path, FACTORY_KIMI_PORT: '58941', FACTORY_CURSOR_ADMIN_KEY_FILE: join(dir, 'no-cursor-key') };
    const invoke = (args: string[]) => spawnSync(process.execPath, ['scripts/usage/collect.ts', ...args], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env, encoding: 'utf8', timeout: 5000 });
    for (const cachedVersion of [null, '0.0.1791763306-ged595a', '0.0.1791849701-g1448da']) {
      if (cachedVersion) await writeFile(path, JSON.stringify({
        schema_version: 1, tools: [],
        amp_details: { attempted_at_ms: Date.now(), reason: null, cli_version: cachedVersion },
      }));
      const before = cachedVersion ? await readFile(path, 'utf8') : null;
      const result = invoke(['--dry-run']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');       assert.doesNotMatch(result.stdout, /private-|redacted@|tokens|prompt|fixturetokenvalue0001|1\.2K|request_id/);
      assert.deepEqual(JSON.parse(result.stdout).tools.map(t => t.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
      if (before === null) assert.deepEqual((await readdir(dir)).filter(name => name !== '.kimi-code').sort(), ['agent', 'amp', 'claude', 'codex', 'kimi', 'opencode']);
      else assert.equal(await readFile(path, 'utf8'), before);
    }
    const written = invoke([]);
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stdout, '');
    assert.equal(written.stderr, '');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).tools.map(t => t.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    assert.deepEqual((await readdir(dir)).filter(name => name !== '.kimi-code').sort(), ['agent', 'amp', 'claude', 'codex', 'kimi', 'opencode', 'usage.json']);
    assert.deepEqual(CLAUDE_ARGS, ['-p', '/usage', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--prompt-suggestions', 'false']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cursor, kimi and opencode fail closed and drop identity, tokens and wallets', async () => {
  assert.equal(parseCursor(JSON.stringify(cursorAbout)).plan, 'pro');
  assert.equal(parseCursor(JSON.stringify({ ...cursorAbout, subscriptionTier: 'Pro Plus' })).plan, 'pro_plus');
  assert.equal(parseCursor(JSON.stringify({ ...cursorAbout, subscriptionTier: 'Cursor Ultra' })).plan, 'ultra');
  assert.equal(parseCursor(JSON.stringify({ ...cursorAbout, subscriptionTier: 'Ultra' })).plan, 'ultra');
  assert.equal(parseCursor(JSON.stringify({ ...cursorAbout, subscriptionTier: 'Teams' })).plan, 'team');
  assert.throws(() => parseCursor(JSON.stringify(cursorLoggedOut)), { message: 'not logged in' });
  assert.throws(() => parseCursor(JSON.stringify({ ...cursorAbout, subscriptionTier: null })), { message: 'CLI failed' });
  assert.throws(() => parseCursor(JSON.stringify({ ...cursorAbout, userEmail: null })), { message: FORMAT_CHANGED });
  assert.throws(() => parseCursor(JSON.stringify({ ...cursorAbout, subscriptionTier: 'Max' })), { message: FORMAT_CHANGED });
  const loggedOut = await collect(null, async (program, args) => program === 'agent' && args[0] !== '--version' ? JSON.stringify(cursorLoggedOut) : fixtureRun(program, args), now);
  assert.equal(loggedOut.tools[1].status, 'unknown');
  assert.equal(loggedOut.tools[1].reason, 'not logged in');
  assert.equal(loggedOut.tools[1].plan, null);
  assert.doesNotMatch(JSON.stringify(loggedOut), /redacted@|private-request/);
  const quota = parseKimi(JSON.stringify(kimiUsage));
  assert.equal(quota.balance?.unit, 'usd');
  assert.equal(quota.windows.some(window => window.name === 'monthly'), true);
  assert.throws(() => parseKimi(JSON.stringify(kimiLoggedOut)), { message: 'not logged in' });
  assert.throws(() => parseKimi(JSON.stringify({ ...kimiLoggedOut, data: { kind: 'error', message: 'upstream private-token failed' } })), { message: 'CLI failed' });
  const rmb = parseKimi(JSON.stringify({ ...kimiUsage, data: { ...kimiUsage.data, quota: { ...kimiUsage.data.quota, extraUsage: { ...kimiUsage.data.quota.extraUsage, currency: 'CNY' } } } }));
  assert.deepEqual(rmb.balances, []);
  assert.throws(() => parseKimi(JSON.stringify({ ...kimiUsage, request_id: 'redacted@example.invalid' })), { message: FORMAT_CHANGED });
  const live = parseKimi(JSON.stringify(kimiLive));
  assert.deepEqual(live.windows.map(window => [window.name, window.used_percent, window.window_minutes]), [['five_hour', 50, 300], ['weekly', 25, 10080]]);
  assert.deepEqual(live.balances, []);
  assert.doesNotMatch(JSON.stringify(live), /liveShapeRequestId|currency/);
  assert.throws(() => parseKimi(JSON.stringify({ ...kimiLive, data: { ...kimiLive.data, quota: { ...kimiLive.data.quota, extraUsage: { currency: null, balanceCents: 100 } } } })), { message: FORMAT_CHANGED });
  const session = parseOpencode(opencodeStats);
  assert.deepEqual(session.balances, [{ amount: '12.50', remaining: '12.50', total: null, unit: 'usd', label: 'session cost' }]);
  assert.throws(() => parseOpencode(opencodeStats.replace('Total Cost', 'Spend')), { message: FORMAT_CHANGED });
  assert.throws(() => parseOpencode(`${opencodeStats}\n│ secret │\n`), { message: FORMAT_CHANGED });
  const v2 = parseOpencodeV2(opencodeV2Stats);
  assert.deepEqual(v2.balances, [{ amount: '12.50', remaining: '12.50', total: null, unit: 'usd', label: 'session cost' }]);
  assert.doesNotMatch(JSON.stringify(v2), /12\.5k|3\.4k|7\.41/);
  assert.deepEqual(parseOpencodeV2(opencodeV2Zero).balances, [{ amount: '0.00', remaining: '0.00', total: null, unit: 'usd', label: 'session cost' }]);
  assert.throws(() => parseOpencodeV2(opencodeV2ShareCard), { message: FORMAT_CHANGED });
  assert.throws(() => parseOpencodeV2(opencodeV2Zero.replace('\n  cost', '\n cost')), { message: FORMAT_CHANGED });
  assert.throws(() => parseOpencodeV2(opencodeV2Stats.replace(' cached input', ' cached input\u001b[0m')), { message: FORMAT_CHANGED });
  assert.throws(() => parseOpencodeV2(`${opencodeV2Stats}MODELS\n private-model  1\n`), { message: FORMAT_CHANGED });
  const seen: string[][] = [];
  const v2run = await collect(null, async (program, args) => {
    if (program !== 'opencode') return fixtureRun(program, args);
    seen.push(args);
    return args[0] === '--version' ? 'opencode v2.0.32\n' : opencodeV2Stats;
  }, now);
  assert.deepEqual(seen, [['--version'], ['stats', '--all', '--cost']]);
  assert.equal(v2run.tools[5].status, 'ok');
  assert.equal(v2run.tools[5].cli_version, '2.0.32');
  assert.equal(v2run.tools[5].balances[0].amount, '12.50');
  assert.doesNotMatch(JSON.stringify(v2run.tools[5]), /12\.5k|private-model/);
  const missing = await collect(null, async (program, args) => {
    if (program === 'kimi') throw new Error('CLI missing');
    return fixtureRun(program, args);
  }, now);
  assert.equal(missing.tools[4].status, 'unknown');
  assert.equal(missing.tools[4].reason, 'CLI missing');
  assert.equal(missing.tools[5].status, 'ok');
});

test('kimi loopback probe rejects loose tokens, redirects and foreign servers, and kills only its child', async () => {
  const { createServer } = await import('node:http');
  const { symlink } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'kimi-probe-'));
  const previousHome = process.env.KIMI_CODE_HOME;
  const previousPort = process.env.FACTORY_KIMI_PORT;
  const token = 'fixturetokenvalue0001';
  const body = JSON.stringify(kimiUsage);
  const program = join(dir, 'kimi');
  const serve = (port: number, status: number, payload: string, location?: string) => new Promise<import('node:http').Server>(resolve => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('denied'); return; }
      if (location) res.setHeader('location', location);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
  const close = async (server: import('node:http').Server) => { await new Promise(resolve => server.close(resolve)); };
  try {
    process.env.KIMI_CODE_HOME = dir;
    await writeFile(program, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, 'spawned'))}, 'yes'); process.exit(1);\n`, { mode: 0o700 });
    await writeFile(join(dir, 'server.token'), token, { mode: 0o644 });
    await chmod(join(dir, 'server.token'), 0o644);
    process.env.FACTORY_KIMI_PORT = '58951';
    const loose = await serve(58951, 200, body);
    await assert.rejects(command(program, ['usage'], 2000), { message: 'CLI failed' });
    await assert.rejects(stat(join(dir, 'spawned')));
    await close(loose);
    await writeFile(join(dir, 'real.token'), token, { mode: 0o600 });
    await chmod(join(dir, 'real.token'), 0o600);
    await rm(join(dir, 'server.token'));
    await symlink(join(dir, 'real.token'), join(dir, 'server.token'));
    process.env.FACTORY_KIMI_PORT = '58952';
    const linked = await serve(58952, 200, body);
    await assert.rejects(command(program, ['usage'], 2000), { message: 'CLI failed' });
    await close(linked);
    await rm(join(dir, 'server.token'));
    await writeFile(join(dir, 'server.token'), token, { mode: 0o600 });
    await chmod(join(dir, 'server.token'), 0o600);
    process.env.FACTORY_KIMI_PORT = '58953';
    const redirect = await serve(58953, 302, '', 'http://169.254.169.254/latest');
    await assert.rejects(command(program, ['usage'], 2000), { message: 'CLI failed' });
    await close(redirect);
    process.env.FACTORY_KIMI_PORT = '58954';
    const huge = await serve(58954, 200, 'x'.repeat(70_000));
    await assert.rejects(command(program, ['usage'], 2000), { message: 'CLI output too large' });
    await close(huge);
    process.env.FACTORY_KIMI_PORT = '58955';
    let hits = 0;
    const held = await new Promise<import('node:http').Server>(resolve => {
      const server = createServer((_req, res) => { hits += 1; res.writeHead(200); res.end(body); });
      server.listen(58955, '127.0.0.1', () => resolve(server));
    });
    const reused = await command(program, ['usage'], 2000);
    assert.equal(hits, 1);
    assert.doesNotMatch(reused, new RegExp(token));
    await assert.rejects(stat(join(dir, 'spawned')));
    await close(held);
    await writeFile(program, `#!${process.execPath}\nconst fs=require('node:fs'); const http=require('node:http'); fs.writeFileSync(${JSON.stringify(join(dir, 'child.pid'))}, String(process.pid)); http.createServer((_req,res)=>{res.writeHead(200);res.end(${JSON.stringify(body)});}).listen(58956,'127.0.0.1'); console.log('Token: ${token}');\n`, { mode: 0o700 });
    process.env.FACTORY_KIMI_PORT = '58956';
    const spawned = await command(program, ['usage'], 3000);
    assert.equal(JSON.parse(spawned).data.kind, 'ok');
    assert.doesNotMatch(spawned, new RegExp(token));
    const pid = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
    let gone = false;
    for (let i = 0; i < 20; i++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); }
      catch { gone = true; break; }
    }
    assert.equal(gone, true);
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = previousHome;
    if (previousPort === undefined) delete process.env.FACTORY_KIMI_PORT; else process.env.FACTORY_KIMI_PORT = previousPort;
    await rm(dir, { recursive: true, force: true });
  }
});

const ADMIN_KEY = 'key_private_admin_0123456789abcdef';
const cursorNow = cursorCycleStart + 16 * 86_400_000 + 12_345;
const emptyEvents = { totalUsageEventsCount: 0, pagination: { numPages: 1, currentPage: 1, pageSize: 1000, hasNextPage: false, hasPreviousPage: false }, usageEvents: [] };
const teamsRun = async (program: string, args: string[]) => program === 'agent' && args[0] !== '--version' ? JSON.stringify(cursorTeams) : fixtureRun(program, args);
function fakeAdmin(respond?: (path: string, body: any) => { status: number; body: string }, key: string | null = ADMIN_KEY, keyId = '1:2:3:4') {
  const calls: { path: string; body: any; key: string }[] = [];
  const deps: AdminDeps = {
    readKey: async () => key === null ? null : { key, id: keyId },
    sleep: async () => {},
    post: async (path, body, sent) => {
      calls.push({ path, body, key: sent });
      if (respond) return respond(path, body);
      const pages = path === '/teams/spend' ? cursorSpendPages : cursorEventPages;
      return { status: 200, body: JSON.stringify(pages[(body as any).page - 1]) };
    },
  };
  return { calls, admin: () => deps };
}

test('cursor Teams spend and events sum across pages without identities or the key', async () => {
  const { calls, admin } = fakeAdmin();
  const snapshot = await collect(null, teamsRun, cursorNow, admin);
  const cursor = snapshot.tools[1];
  assert.equal(cursor.status, 'ok'); assert.equal(cursor.reason, null); assert.equal(cursor.plan, 'team');
  assert.equal(cursor.observed_at_ms, cursorNow);
  const spend = { amount: '15.50875', remaining: '15.50875', total: null, unit: 'usd', label: 'cycle spend' };
  assert.deepEqual(cursor.balances, [spend]); assert.deepEqual(cursor.balance, spend);
  // 1550.875 cents of a 200 USD team limit (every member limited).
  assert.deepEqual(cursor.windows, [{ name: 'monthly', used_percent: 7.75, resets_at_ms: Date.UTC(2026, 10, 1), window_minutes: null }]);
  assert.deepEqual(cursor.breakdown, [
    { label: 'headless', amount: '9' }, { label: 'interactive', amount: '6.50875' },
    { label: 'claude-4.5-sonnet', amount: '11.505' }, { label: 'gpt-5 -max-', amount: '4.00375' }, { label: 'auto', amount: '0' },
  ]);
  assert.deepEqual(calls.map(c => [c.path, c.body.page]), [['/teams/spend', 1], ['/teams/spend', 2], ['/teams/filtered-usage-events', 1], ['/teams/filtered-usage-events', 2]]);
  assert.deepEqual([calls[2].body.startDate, calls[2].body.endDate], [cursorCycleStart, cursorNow]);
  const state = snapshot.cursor_admin!;
  assert.equal(state.data!.limited_users_count, 1); assert.equal(state.data!.max_user_spend, '12.505');
  assert.deepEqual(state.data!.usage.find(r => r.model === 'claude-4.5-sonnet' && r.headless), {
    model: 'claude-4.5-sonnet', headless: true, events: 1, charged: '9', input_tokens: 100, output_tokens: 50, cache_read_tokens: 1000, cache_write_tokens: 10,
  });
  assert.equal(state.data!.usage.find(r => r.model === 'auto')!.input_tokens, 0);
  const text = JSON.stringify(snapshot);
  assert.doesNotMatch(text, /private|@|Private Name|user_private|bc-|key_private/);
  assert.ok(!text.includes(ADMIN_KEY));
  // Every other tool is unaffected, and the stored cache round-trips.
  assert.deepEqual(snapshot.tools.map(t => t.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  const dir = await mkdtemp(join(tmpdir(), 'usage-cursor-'));
  try {
    await writeFile(join(dir, 'usage.json'), text);
    assert.deepEqual((await readPrevious(join(dir, 'usage.json'), cursorNow))!.cursor_admin, state);
    const smuggled = structuredClone(snapshot); smuggled.cursor_admin!.data!.breakdown[0].label = 'private@example.invalid';
    await writeFile(join(dir, 'usage.json'), JSON.stringify(smuggled));
    assert.equal((await readPrevious(join(dir, 'usage.json'), cursorNow))!.cursor_admin, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cursor without an admin key stays plan-only and makes no HTTP call', async () => {
  const { calls, admin } = fakeAdmin(undefined, null);
  const cursor = (await collect(null, teamsRun, cursorNow, admin)).tools[1];
  assert.equal(cursor.status, 'ok'); assert.equal(cursor.plan, 'team');
  assert.deepEqual([cursor.windows, cursor.balances, cursor.breakdown], [[], [], undefined]);
  assert.equal(calls.length, 0);
  // The default (no key file here) is also plan-only.
  assert.deepEqual((await collect(null, teamsRun, cursorNow)).tools[1].balances, []);
});

test('cursor 401 and 403 report the fixed rejection with the plan, and back off hourly', async () => {
  for (const status of [401, 403]) {
    const { calls, admin } = fakeAdmin(() => ({ status, body: `{"error":"bad key ${ADMIN_KEY}"}` }));
    let snapshot = await collect(null, teamsRun, cursorNow, admin);
    const cursor = snapshot.tools[1];
    assert.deepEqual([cursor.status, cursor.reason, cursor.plan, cursor.balances], ['unknown', 'admin key rejected', 'team', []]);
    assert.ok(!JSON.stringify(snapshot).includes(ADMIN_KEY));
    snapshot = await collect(snapshot, teamsRun, cursorNow + 59 * 60_000, admin);
    assert.equal(snapshot.tools[1].reason, 'admin key rejected');
    assert.equal(calls.length, 1);
    assert.deepEqual(snapshot.tools.filter(t => t.tool !== 'cursor').map(t => t.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  }
});

test('cursor Admin data is fetched at most hourly and reused between fetches', async () => {
  const { calls, admin } = fakeAdmin();
  let snapshot = await collect(null, teamsRun, cursorNow, admin);
  for (const minutes of [15, 30, 45, 59]) {
    snapshot = await collect(snapshot, teamsRun, cursorNow + minutes * 60_000, admin);
    assert.equal(snapshot.tools[1].observed_at_ms, cursorNow);
    assert.equal(snapshot.tools[1].balance?.amount, '15.50875');
  }
  assert.equal(calls.length, 4);
  snapshot = await collect(snapshot, teamsRun, cursorNow + 60 * 60_000, admin);
  assert.equal(calls.length, 8);
  assert.equal(snapshot.tools[1].observed_at_ms, cursorNow + 3_600_000);
});

test('malformed Admin responses fail closed for the Cursor row only', async () => {
  const spend = cursorSpendPages[0], events = cursorEventPages[1];
  const bad: [string, unknown][] = [
    ['/teams/spend', 'not json'], ['/teams/spend', []],
    ['/teams/spend', { ...spend, subscriptionCycleStart: '2026-10-01' }],
    ['/teams/spend', { ...spend, teamMemberSpend: [{ ...spend.teamMemberSpend[0], spendCents: -1 }] }],
    ['/teams/spend', { ...spend, totalPages: 1 }],
    ['/teams/filtered-usage-events', { ...events, usageEvents: [{ ...events.usageEvents[0], isHeadless: 'no' }] }],
    ['/teams/filtered-usage-events', { ...events, usageEvents: [{ ...events.usageEvents[0], chargedCents: '1' }] }],
    ['/teams/filtered-usage-events', { ...events, pagination: undefined }],
  ];
  for (const [path, body] of bad) {
    const { admin } = fakeAdmin((p, b) => ({ status: 200, body: p === path ? (typeof body === 'string' ? body : JSON.stringify(body)) : JSON.stringify(spend.totalPages && p === '/teams/spend' ? { ...spend, totalPages: 1, totalMembers: 2 } : events) }));
    const snapshot = await collect(null, teamsRun, cursorNow, admin);
    const cursor = snapshot.tools[1];
    assert.deepEqual([cursor.status, cursor.reason, cursor.plan, cursor.balances, cursor.windows], ['unknown', FORMAT_CHANGED, null, [], []], String(path));
    assert.deepEqual(snapshot.tools.filter(t => t.tool !== 'cursor').map(t => t.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  }
  const { admin } = fakeAdmin(() => ({ status: 500, body: '' }));
  assert.equal((await collect(null, teamsRun, cursorNow, admin)).tools[1].reason, 'CLI failed');
});

test('cursor cycle start resets spend, the window and the events range', async () => {
  assert.equal(nextCycle(Date.UTC(2026, 0, 31, 8)), Date.UTC(2026, 1, 28, 8));
  assert.equal(nextCycle(Date.UTC(2026, 11, 15)), Date.UTC(2027, 0, 15));
  const old = await collect(null, teamsRun, cursorNow, fakeAdmin().admin);
  // Past the cached cycle end, last cycle's spend is not shown before the hourly fetch.
  const boundary = Date.UTC(2026, 10, 1) + 60_000;
  const reused = await collect({ ...old, cursor_admin: { ...old.cursor_admin!, attempted_at_ms: boundary - 30 * 60_000 } }, teamsRun, boundary, fakeAdmin(() => { throw new Error('no call'); }).admin);
  assert.deepEqual([reused.tools[1].status, reused.tools[1].plan, reused.tools[1].balances], ['ok', 'team', []]);
  const start = Date.UTC(2026, 10, 1);
  const { calls, admin } = fakeAdmin((path, body) => ({ status: 200, body: JSON.stringify(path === '/teams/spend'
    ? { teamMemberSpend: [{ spendCents: 5, effectivePerUserLimitDollars: 0, email: 'private@example.invalid' }], subscriptionCycleStart: start, totalMembers: 1, totalPages: 1 }
    : emptyEvents) }));
  const fresh = await collect(reused, teamsRun, start + 3_600_000, admin);
  const cursor = fresh.tools[1];
  assert.equal(cursor.balance?.amount, '0.05');
  assert.deepEqual(cursor.windows, []); // An unlimited member means no real limit.
  assert.deepEqual(cursor.breakdown, [{ label: 'headless', amount: '0' }, { label: 'interactive', amount: '0' }]);
  assert.equal(calls[1].body.startDate, start);
  assert.equal(fresh.cursor_admin!.data!.next_cycle_ms, Date.UTC(2026, 11, 1));
  // A cycle longer than 30 days splits the events range into inclusive 30-day requests.
  const long = fakeAdmin((path) => ({ status: 200, body: JSON.stringify(path === '/teams/spend'
    ? { teamMemberSpend: [], subscriptionCycleStart: Date.UTC(2026, 0, 31), totalMembers: 0, totalPages: 0 }
    : emptyEvents) }));
  await fetchCursor(long.admin(), ADMIN_KEY, Date.UTC(2026, 2, 3));
  assert.deepEqual(long.calls.slice(1).map(c => [c.body.startDate, c.body.endDate]), [
    [Date.UTC(2026, 0, 31), Date.UTC(2026, 0, 31) + 30 * 86_400_000 - 1], [Date.UTC(2026, 0, 31) + 30 * 86_400_000, Date.UTC(2026, 2, 3)],
  ]);
  assert.equal(cursorReading({ plan: 'team', windows: [], balance: null, balances: [], reset_credits_available: null }, fresh.cursor_admin!.data!, Date.UTC(2026, 11, 1)).balances.length, 0);
});

test('cursor admin key file is strict and dry-run against a fake Admin server leaks nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-cursor-cli-'));
  const { createServer } = await import('node:http');
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      const page = JSON.parse(body).page;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/teams/spend' ? cursorSpendPages[page - 1] : cursorEventPages[page - 1]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const keyFile = join(dir, 'cursor-admin-key');
    assert.equal(await readAdminKey(keyFile), null);
    await writeFile(keyFile, `${ADMIN_KEY}\n`, { mode: 0o640 }); await chmod(keyFile, 0o640);
    const read = await readAdminKey(keyFile, false);
    assert.equal(read?.key, ADMIN_KEY);
    const info = await stat(keyFile);
    assert.equal(read?.id, `${info.dev}:${info.ino}:${info.size}:${Math.trunc(info.mtimeMs)}`);
    // Unsafe credential metadata fails closed: world/group bits beyond 0640, a
    // non-root production owner, a symlink, or an empty file.
    for (const mode of [0o644, 0o660, 0o600, 0o440]) {
      await chmod(keyFile, mode);
      await assert.rejects(readAdminKey(keyFile, false), { message: 'CLI failed' }, mode.toString(8));
    }
    await chmod(keyFile, 0o640);
    if (process.getuid() !== 0) await assert.rejects(readAdminKey(keyFile, true), { message: 'CLI failed' });
    const { symlink } = await import('node:fs/promises');
    await symlink(keyFile, join(dir, 'linked-key'));
    await assert.rejects(readAdminKey(join(dir, 'linked-key'), false), { message: 'CLI failed' });
    await writeFile(join(dir, 'empty'), '', { mode: 0o640 }); await chmod(join(dir, 'empty'), 0o640);
    await assert.rejects(readAdminKey(join(dir, 'empty'), false), { message: 'CLI failed' });
    const agent = join(dir, 'agent');
    await writeFile(agent, `#!${process.execPath}\nconsole.log(process.argv[2]==='--version'?'2026.10.16-e3cb207':${JSON.stringify(JSON.stringify(cursorTeams))});\n`, { mode: 0o700 });
    const port = (server.address() as { port: number }).port;
    const env = { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, FACTORY_USAGE_SNAPSHOT: join(dir, 'usage.json'), FACTORY_CURSOR_ADMIN_KEY_FILE: keyFile, FACTORY_CURSOR_API_BASE: `http://127.0.0.1:${port}` };
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['scripts/usage/collect.ts', '--dry-run'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, stderr);
    assert.equal(stderr, '');
    const cursor = JSON.parse(stdout).tools[1];
    assert.equal(cursor.status, 'ok'); assert.equal(cursor.balance.amount, '15.50875');
    assert.ok(!stdout.includes(ADMIN_KEY)); assert.doesNotMatch(stdout, /private|@|user_private|bc-/);
    assert.deepEqual(seen.map(s => s.split(' ').slice(0, 2).join(' ')), ['POST /teams/spend', 'POST /teams/spend', 'POST /teams/filtered-usage-events', 'POST /teams/filtered-usage-events']);
    assert.ok(seen.every(s => s.endsWith(`Basic ${Buffer.from(`${ADMIN_KEY}:`).toString('base64')}`)));
    await assert.rejects(readFile(join(dir, 'usage.json')));
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('one Admin fetch per hour regardless of key file; another key never reuses cached success', async () => {
  const warm = await collect(null, teamsRun, cursorNow, fakeAdmin(undefined, ADMIN_KEY, '1:2:3:4').admin);
  assert.equal(warm.tools[1].balance?.amount, '15.50875');
  // Within the hour: identical bytes in another inode, then a different key Cursor would reject.
  for (const [minutes, key, id] of [[10, ADMIN_KEY, '1:9:3:5'], [20, 'key_replacement_000000', '1:10:3:6']] as const) {
    const other = fakeAdmin(() => ({ status: 401, body: '{}' }), key, id);
    const snapshot = await collect(warm, teamsRun, cursorNow + minutes * 60_000, other.admin);
    assert.equal(other.calls.length, 0);
    // Plan-only: neither the cached spend nor a cached success validates the other key file.
    assert.deepEqual([snapshot.tools[1].status, snapshot.tools[1].plan, snapshot.tools[1].balances, snapshot.tools[1].breakdown], ['ok', 'team', [], undefined]);
    assert.deepEqual(snapshot.cursor_admin, warm.cursor_admin);
  }
  // Removing the key inside the hour keeps the attempt, so re-adding it cannot fetch early.
  const removed = await collect(warm, teamsRun, cursorNow + 30 * 60_000, fakeAdmin(undefined, null).admin);
  assert.deepEqual([removed.tools[1].balances, removed.cursor_admin], [[], warm.cursor_admin]);
  const readded = fakeAdmin(undefined, ADMIN_KEY, '1:11:3:7');
  await collect(removed, teamsRun, cursorNow + 40 * 60_000, readded.admin);
  assert.equal(readded.calls.length, 0);
  // The original key file still reads its own cache.
  assert.equal((await collect(warm, teamsRun, cursorNow + 50 * 60_000, fakeAdmin(() => { throw new Error('no call'); }).admin)).tools[1].balance?.amount, '15.50875');
  // After the hour the replacement key gets its own fetch, and its rejection is reported.
  const rejected = fakeAdmin(() => ({ status: 401, body: '{}' }), 'key_replacement_000000', '1:10:3:6');
  const after = await collect(warm, teamsRun, cursorNow + 60 * 60_000, rejected.admin);
  assert.equal(rejected.calls.length, 1);
  // Stale, not unknown: the last good reading is now over 45 minutes old.
  assert.deepEqual([after.tools[1].status, after.tools[1].reason, after.cursor_admin!.key_id], ['stale', 'admin key rejected', '1:10:3:6']);
  // A missing key after the hour clears the state.
  assert.equal((await collect(warm, teamsRun, cursorNow + 60 * 60_000, fakeAdmin(undefined, null).admin)).cursor_admin, null);
});

test('malformed charge, token and pagination data fails closed instead of partial totals', async () => {
  const [first, second] = cursorEventPages;
  const tokenEvent = first.usageEvents[0];
  const { tokenUsage, ...noTokens } = tokenEvent;
  const { cacheReadTokens, ...missingCacheRead } = tokenUsage!;
  const lastPage = (usageEvents: unknown[]) => ({ ...second, usageEvents: [second.usageEvents[0], ...usageEvents] });
  const bad: [string, unknown[]][] = [
    ['missing charge', [first, lastPage([(({ chargedCents, ...e }) => e)(tokenEvent)])]],
    ['null charge', [first, lastPage([{ ...tokenEvent, chargedCents: null }])]],
    ['token call without tokenUsage', [first, lastPage([noTokens])]],
    ['token call missing a count', [first, lastPage([{ ...tokenEvent, tokenUsage: missingCacheRead }])]],
    ['missing isTokenBasedCall', [first, lastPage([(({ isTokenBasedCall, ...e }) => e)(tokenEvent)])]],
    ['next page past numPages', [first, { ...second, pagination: { ...second.pagination, hasNextPage: true } }]],
    ['last page before numPages', [{ ...first, pagination: { ...first.pagination, hasNextPage: false } }, second]],
    ['numPages changes', [first, { ...second, pagination: { ...second.pagination, numPages: 3 } }]],
    ['wrong currentPage', [first, { ...second, pagination: { ...second.pagination, currentPage: 1 } }]],
    ['total count mismatch', [first, { ...second, totalUsageEventsCount: 5 }]],
    ['total count changes', [{ ...first, totalUsageEventsCount: 3 }, second]],
    ['missing total count', [first, (({ totalUsageEventsCount, ...p }) => p)(second)]],
  ];
  for (const [name, pages] of bad) {
    const { admin } = fakeAdmin((path, body) => ({ status: 200, body: JSON.stringify(path === '/teams/spend' ? cursorSpendPages[body.page - 1] : pages[body.page - 1]) }));
    const snapshot = await collect(null, teamsRun, cursorNow, admin);
    assert.deepEqual([snapshot.tools[1].status, snapshot.tools[1].reason, snapshot.tools[1].balances], ['unknown', FORMAT_CHANGED, []], name);
    assert.equal(snapshot.cursor_admin!.data, null, name);
  }
  // A request-based event (isTokenBasedCall false) without tokenUsage stays valid.
  const ok = fakeAdmin((path, body) => ({ status: 200, body: JSON.stringify(path === '/teams/spend' ? cursorSpendPages[body.page - 1] : [first, lastPage([{ ...noTokens, isTokenBasedCall: false, model: 'request-model', chargedCents: 4 }])][body.page - 1]) }));
  const snapshot = await collect(null, teamsRun, cursorNow, ok.admin);
  assert.equal(snapshot.tools[1].status, 'ok');
  assert.deepEqual(snapshot.tools[1].breakdown?.find(i => i.label === 'request-model'), { label: 'request-model', amount: '0.04' });
});

test('a trickling Admin response hits the wall-clock deadline; other tools still complete', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"teamMemberSpend":[');
    const timer = setInterval(() => res.write(' '), 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const real = (await import('./cursor.ts')).defaultAdmin({ FACTORY_CURSOR_API_BASE: base });
    let started = Date.now();
    await assert.rejects(real.post('/teams/spend', { page: 1 }, ADMIN_KEY, 200), { message: 'timeout' });
    assert.ok(Date.now() - started < 1_000);
    const deps: AdminDeps = { ...real, readKey: async () => ({ key: ADMIN_KEY, id: '1:2:3:4' }), budgetMs: 300 };
    started = Date.now();
    const snapshot = await collect(null, teamsRun, cursorNow, () => deps);
    assert.ok(Date.now() - started < 2_000);
    assert.deepEqual([snapshot.tools[1].status, snapshot.tools[1].reason, snapshot.tools[1].plan], ['unknown', 'timeout', null]);
    assert.deepEqual(snapshot.tools.filter(t => t.tool !== 'cursor').map(t => t.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
    // An injected transport that never settles is bounded by the fetch budget too.
    started = Date.now();
    await assert.rejects(fetchCursor({ ...deps, post: () => new Promise(() => {}), budgetMs: 200 }, ADMIN_KEY, cursorNow), { message: 'timeout' });
    assert.ok(Date.now() - started < 1_000);
  } finally { server.closeAllConnections(); server.close(); }
});

test('installer-style preflight hands its one Admin fetch to the first collection; restaging inside the hour defers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-cursor-handoff-'));
  const { createServer } = await import('node:http');
  const { rename } = await import('node:fs/promises');
  const good = `Basic ${Buffer.from(`${ADMIN_KEY}:`).toString('base64')}`;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push(`${req.url} ${req.headers.authorization === good ? 'good' : 'other'}`);
      if (req.headers.authorization !== good) { res.writeHead(401); res.end('{}'); return; }
      const page = JSON.parse(body).page;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/teams/spend' ? cursorSpendPages[page - 1] : cursorEventPages[page - 1]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(join(dir, 'agent'), `#!${process.execPath}\nconsole.log(process.argv[2]==='--version'?'2026.10.16-e3cb207':${JSON.stringify(JSON.stringify(cursorTeams))});\n`, { mode: 0o700 });
    const snapshotPath = join(dir, 'usage.json'), keyFile = join(dir, 'cursor-admin-key');
    const run = async (args: string[], key: string) => {
      const { spawn } = await import('node:child_process');
      const env = { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, FACTORY_USAGE_SNAPSHOT: snapshotPath, FACTORY_CURSOR_ADMIN_KEY_FILE: key, FACTORY_CURSOR_API_BASE: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
      const child = spawn(process.execPath, ['scripts/usage/collect.ts', ...args], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env });
      let stdout = '', stderr = '';
      child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
      assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, stderr);
      assert.equal(stderr, '');
      return stdout;
    };
    const stage = async (name: string, key: string) => {
      const path = join(dir, name);
      await writeFile(path, `${key}\n`, { mode: 0o640 }); await chmod(path, 0o640);
      return path;
    };
    // Cold preflight: dry-run with the staged key, then move it into place (same inode).
    const staged = await stage('.staged-key', ADMIN_KEY);
    const preview = await run(['--dry-run'], staged);
    assert.equal(seen.length, 4);
    assert.ok(!preview.includes(ADMIN_KEY)); assert.doesNotMatch(preview, /private|@|user_private|bc-/);
    await assert.rejects(readFile(snapshotPath));
    await rename(staged, keyFile);
    await writeFile(snapshotPath, preview);
    await run([], keyFile);
    assert.equal(seen.length, 4); // The first collection reused the preflight fetch.
    const first = JSON.parse(await readFile(snapshotPath, 'utf8'));
    assert.equal(first.tools[1].status, 'ok'); assert.equal(first.tools[1].balance.amount, '15.50875');
    assert.equal(first.cursor_admin.attempted_at_ms, JSON.parse(preview).cursor_admin.attempted_at_ms);
    // Warm snapshot, then within the hour re-stage identical key bytes (new inode) and a
    // different key Cursor rejects. Neither fetches; neither validates from cached success,
    // so the installer's fresh-fetch check refuses and the installed key stays.
    const freshFetch = (preview: any, since: number) => preview.cursor_admin?.reason === null && preview.cursor_admin.data !== null && preview.cursor_admin.attempted_at_ms >= since;
    for (const [name, key] of [['.restaged-key', ADMIN_KEY], ['.replacement-key', 'key_rejected_replacement_01']]) {
      const since = Date.now();
      const staged = await stage(name, key);
      const deferred = await run(['--dry-run'], staged);
      assert.equal(seen.length, 4, name);
      const parsed = JSON.parse(deferred);
      assert.deepEqual([parsed.tools[1].status, parsed.tools[1].plan, parsed.tools[1].balances], ['ok', 'team', []], name);
      assert.equal(freshFetch(parsed, since), false, name);
      assert.ok(!deferred.includes(key), name);
      await rm(staged);
    }
    assert.equal(await readFile(keyFile, 'utf8'), `${ADMIN_KEY}\n`);
    // The installed key keeps serving its own cached row, still without a fetch.
    await run([], keyFile);
    assert.equal(seen.length, 4);
    assert.equal(JSON.parse(await readFile(snapshotPath, 'utf8')).tools[1].balance.amount, '15.50875');
    assert.ok(freshFetch(JSON.parse(preview), 0));
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a FIFO credential fails only the Cursor row promptly, and the snapshot is still written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-cursor-fifo-'));
  try {
    await writeFakeClis(dir);
    const fifo = join(dir, 'cursor-admin-key');
    assert.equal(spawnSync('mkfifo', ['-m', '0640', fifo]).status, 0);
    assert.ok((await stat(fifo)).isFIFO());
    // Direct read: rejected without waiting for a writer.
    let started = Date.now();
    await assert.rejects(readAdminKey(fifo, false), { message: 'CLI failed' });
    assert.ok(Date.now() - started < 1_000);
    // Actual CLI: a full (non-dry) run completes, Cursor fails closed, the rest are ok.
    const path = join(dir, 'usage.json');
    const env = { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, FACTORY_USAGE_SNAPSHOT: path, FACTORY_KIMI_PORT: '58943', FACTORY_CURSOR_ADMIN_KEY_FILE: fifo, FACTORY_CURSOR_API_BASE: 'http://127.0.0.1:9' };
    started = Date.now();
    const result = spawnSync(process.execPath, ['scripts/usage/collect.ts'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env, encoding: 'utf8', timeout: 15_000 });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(snapshot.tools.map(t => [t.tool, t.status, t.reason]), [
      ['amp', 'ok', null], ['cursor', 'unknown', 'CLI failed'], ['claude-code', 'ok', null],
      ['codex', 'ok', null], ['kimi', 'ok', null], ['opencode', 'ok', null],
    ]);
    assert.deepEqual([snapshot.tools[1].plan, snapshot.tools[1].balances], [null, []]);
    assert.equal(snapshot.cursor_admin, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
