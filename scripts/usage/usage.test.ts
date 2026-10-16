import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, chown, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collect, command, readPrevious, writeSnapshot, CLAUDE_ARGS, supportedNode } from './collect.ts';
import { age, FORMAT_CHANGED, parseAmp, parseAmpDetails, parseClaude, parseCodex, STALE_MS } from './parsers.ts';
import { amp, ampAutoReload, ampNew, details, detailsAutoReload, detailsNew, claude, codex, fixtureRun, versions } from './fixtures.ts';
const now = 1791800000000;

test('supported Node versions require Node 24.12.0 or newer', () => {
  for (const version of ['24.12.0', '24.21.0', '24.22.0']) assert.equal(supportedNode(version), true);
  for (const version of ['24.11.1', '22.18.0', '25.0.0', '26.1.0', '24.12', 'v24.12.0', '24.12.0-beta']) assert.equal(supportedNode(version), false);
});

test('verified projections preserve units, percentages, scope and UTC milliseconds', async () => {
  const snapshot = await collect(null, fixtureRun, now);
  assert.deepEqual(snapshot.tools.map(t => t.status), ['ok', 'not_tracked', 'ok', 'ok', 'not_tracked']);
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
  assert.doesNotMatch(JSON.stringify(snapshot), /redacted@|private-|tokens|prompt|accountId/);
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
  assert.deepEqual(failed.tools.map(t => t.status), ['ok', 'not_tracked', 'unknown', 'ok', 'not_tracked']);
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

test('CLI dry-run writes nothing and logs only sanitized snapshot using fake binaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-cli-'));
  try {
    for (const program of ['amp', 'claude', 'codex']) {
      const output = program === 'amp' ? { version: '0.0.1791763306-ged595a (released 2026-10-12T00:01:46.000Z, 1d ago)', summary: amp, details } : { version: '2.1.296 (Claude Code)', summary: claude };
      const script = program === 'codex' ? `if(process.argv[2]==='--version') console.log('codex-cli 0.162.1'); else {require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l); if(m.id===1) console.log(JSON.stringify({id:1,result:{}})); if(m.id===2) console.log(${JSON.stringify(JSON.stringify(codex))});});}` : `const o=${JSON.stringify(output)}; console.error('private-secret'); console.log(process.argv[2]==='--version'?o.version:process.argv.includes('--details')?o.details:o.summary);`;
      await writeFile(join(dir, program), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
    }
    const path = join(dir, 'usage.json');
    const env = { HOME: dir, PATH: `${dir}:/usr/bin:/bin`, FACTORY_USAGE_SNAPSHOT: path };
    const invoke = (args: string[]) => spawnSync(process.execPath, ['scripts/usage/collect.ts', ...args], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env, encoding: 'utf8', timeout: 5000 });
    for (const cachedVersion of [null, '0.0.1791763306-ged595a', '0.0.1791849701-g1448da']) {
      if (cachedVersion) await writeFile(path, JSON.stringify({
        schema_version: 1, tools: [],
        amp_details: { attempted_at_ms: Date.now(), reason: null, cli_version: cachedVersion },
      }));
      const before = cachedVersion ? await readFile(path, 'utf8') : null;
      const result = invoke(['--dry-run']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, /private-|redacted@|tokens|prompt/);
      assert.deepEqual(JSON.parse(result.stdout).tools.map(t => t.status), ['ok', 'not_tracked', 'ok', 'ok', 'not_tracked']);
      if (before === null) assert.deepEqual((await readdir(dir)).sort(), ['amp', 'claude', 'codex']);
      else assert.equal(await readFile(path, 'utf8'), before);
    }
    const written = invoke([]);
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stdout, '');
    assert.equal(written.stderr, '');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).tools.map(t => t.status), ['ok', 'not_tracked', 'ok', 'ok', 'not_tracked']);
    assert.deepEqual((await readdir(dir)).sort(), ['amp', 'claude', 'codex', 'usage.json']);
    assert.deepEqual(CLAUDE_ARGS, ['-p', '/usage', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--prompt-suggestions', 'false']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
