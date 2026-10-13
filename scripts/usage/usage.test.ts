import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collect, command, readPrevious, writeSnapshot, CLAUDE_ARGS } from './collect.ts';
import { age, FORMAT_CHANGED, parseAmp, parseAmpDetails, parseClaude, parseCodex, STALE_MS } from './parsers.ts';
import { amp, details, claude, codex, fixtureRun } from './fixtures.ts';
const now = 1791800000000;

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

test('process timeout and output cap return fixed diagnostics', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100), { message: 'CLI timed out' });
  await assert.rejects(command(process.execPath, ['-e', 'console.error("private-secret"); process.exit(1)']), { message: 'CLI failed' });
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("x".repeat(2100000))']), { message: 'CLI output too large' });
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

test('atomic replacement preserves complete JSON, 0640 and last-good timestamps; no temp files survive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-test-'));
  try {
    const path = join(dir, 'usage.json');
    const snapshot = await collect(null, fixtureRun, now);
    await writeSnapshot(path, snapshot);
    const before = (await stat(path)).ino;
    let reading = true;
    const reads = (async () => { while (reading) assert.equal(JSON.parse(await readFile(path, 'utf8')).schema_version, 1); })();
    for (let i = 0; i < 10; i++) await writeSnapshot(path, { ...snapshot, generated_at_ms: now + i });
    reading = false; await reads;
    assert.notEqual((await stat(path)).ino, before);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.equal((await stat(path)).gid, (await stat(dir)).gid);
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
    const result = spawnSync(process.execPath, ['scripts/usage/collect.ts', '--dry-run'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, /private-|redacted@|tokens|prompt/);
    assert.deepEqual(JSON.parse(result.stdout).tools.map(t => t.status), ['ok', 'not_tracked', 'ok', 'ok', 'not_tracked']);
    assert.deepEqual((await readdir(dir)).sort(), ['amp', 'claude', 'codex']);
    assert.deepEqual(CLAUDE_ARGS, ['-p', '/usage', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--prompt-suggestions', 'false']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
