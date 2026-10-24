import test from 'node:test';
import assert from 'node:assert/strict';
import { deployComponent, emptyLedger, issuesFromSubjects, main, parseSnapshot, pendingTags, plan, probeResult, receiptLine, recipes, resume, type Effects, type Ledger } from './deploy.ts';
import { nextAction, parseDeployReceipt } from './lifecycle.ts';

const sha = 'a'.repeat(40);
const kiosk = recipes.find(recipe => recipe.name === 'kiosk')!;
const usage = recipes.find(recipe => recipe.name === 'usage')!;
const snapshot = '/var/backups/factory-kiosk/20261024T120000.000000Z.abc123';
const idle = { orbs: 0, runnerSlots: 0, buildIssues: 0 };

/** Sandbox fixture: fake sudo, curl and Linear; scripted health bodies per probe. */
function fixture(options: { installOk?: boolean; rollbackOk?: boolean; bodies: string[]; ledger?: Ledger }) {
  let ledger = options.ledger ?? emptyLedger();
  const calls: string[] = [];
  const bodies = [...options.bodies];
  const effects: Effects = {
    log: () => {},
    sleep: async () => { calls.push('sleep'); },
    run: () => ({ stdout: '', stderr: '' }),
    ok: () => true,
    sudo: (script, args) => {
      calls.push(`sudo ${script} ${args.join(' ')}`.trim());
      if (script.startsWith('deploy/install-')) return { ok: options.installOk ?? true, output: `preflight ok\nRollback snapshot: ${snapshot}\ninstalled\n` };
      return { ok: options.rollbackOk ?? true, output: '' };
    },
    probe: () => { calls.push('probe'); return bodies.shift() ?? 'unreachable'; },
    readLedger: () => structuredClone(ledger),
    writeLedger: next => { ledger = structuredClone(next); },
    linear: { deploying: async () => true, comment: async () => {} },
  };
  return { effects, calls, ledger: () => ledger };
}

const green = JSON.stringify({ git_sha: sha, git_dirty: false, status: 'ok' });

test('install, three green probes 20 s apart, pass receipt, ledger records the component', async () => {
  const { effects, calls, ledger } = fixture({ bodies: [green, green, green] });
  const receipt = await deployComponent(effects, kiosk, 'v0.3.0', sha, '/tmp/rel');
  assert.deepEqual(receipt, { component: 'kiosk', sha, health: 'pass', rollback: 'none' });
  assert.deepEqual(calls, ['sudo deploy/install-kiosk.sh /tmp/rel/kiosk', 'probe', 'sleep', 'probe', 'sleep', 'probe']);
  assert.deepEqual(ledger(), { components: { kiosk: { sha, tag: 'v0.3.0', health: 'pass', snapshot } }, inFlight: undefined });
  assert.equal(receiptLine(receipt), `odd-deploy host=factory-gpu component=kiosk sha=${sha} health=pass rollback=none`);
  assert.equal(nextAction({ identifier: 'MET-1', status: 'Deploying', labels: ['odd'], description: '', openBlockers: [], deployReceipt: parseDeployReceipt(receiptLine(receipt)) }, idle).kind, 'set-status');
});

test('a red probe runs the rollback once with the installer snapshot and the receipt returns the issue to Todo', async () => {
  const stale = JSON.stringify({ git_sha: 'b'.repeat(7), git_dirty: false });
  const { effects, calls } = fixture({ bodies: [green, stale, green] });
  const receipt = await deployComponent(effects, kiosk, 'v0.3.0', sha, '/tmp/rel');
  assert.deepEqual(receipt, { component: 'kiosk', sha, health: 'fail', rollback: snapshot });
  assert.deepEqual(calls.filter(call => call.startsWith('sudo')), ['sudo deploy/install-kiosk.sh /tmp/rel/kiosk', `sudo deploy/rollback-kiosk.sh ${snapshot}`]);
  const action = nextAction({ identifier: 'MET-1', status: 'Deploying', labels: ['odd'], description: '', openBlockers: [], deployReceipt: parseDeployReceipt(receiptLine(receipt)) }, idle);
  assert.equal(action.kind, 'set-status');
  assert.equal((action as { status: string }).status, 'Todo');
  assert.ok((action as { followUp?: object }).followUp);
});

test('a failed rollback posts rollback=none and the control plane pages', async () => {
  const { effects } = fixture({ bodies: ['unreachable'], rollbackOk: false });
  const receipt = await deployComponent(effects, kiosk, 'v0.3.0', sha, '/tmp/rel');
  assert.deepEqual(receipt, { component: 'kiosk', sha, health: 'fail', rollback: 'none' });
  const action = nextAction({ identifier: 'MET-1', status: 'Deploying', labels: ['odd'], description: '', openBlockers: [], deployReceipt: parseDeployReceipt(receiptLine(receipt)) }, idle);
  assert.equal(action.kind, 'page');
  assert.equal((action as { reason: string }).reason, 'failed-rollback');
});

test('an installer failure after its snapshot rolls back; before any change it does not', async () => {
  const withSnapshot = fixture({ bodies: [], installOk: false });
  assert.deepEqual(await deployComponent(withSnapshot.effects, kiosk, 'v0.3.0', sha, '/tmp/rel'), { component: 'kiosk', sha, health: 'fail', rollback: snapshot });
  assert.equal(withSnapshot.calls.filter(call => call.includes('rollback')).length, 1);
  const unchanged = fixture({ bodies: [], installOk: false });
  unchanged.effects.sudo = () => ({ ok: false, output: 'ERROR: preflight failed\nNo deployment changes made; no rollback snapshot exists.\n' });
  assert.deepEqual(await deployComponent(unchanged.effects, kiosk, 'v0.3.0', sha, '/tmp/rel'), { component: 'kiosk', sha, health: 'fail', rollback: 'none' });
});

test('resume after a kill between install and probe: a green probe means no second install', async () => {
  const inFlight = { tag: 'v0.3.0', sha, component: 'kiosk', phase: 'probing' as const, snapshot };
  const { effects, calls } = fixture({ bodies: [green, green, green], ledger: { components: {}, inFlight } });
  const receipt = await deployComponent(effects, kiosk, 'v0.3.0', sha, '/tmp/rel');
  assert.equal(receipt.health, 'pass');
  assert.deepEqual(calls.filter(call => call.startsWith('sudo')), []);
  assert.equal(resume(inFlight, 'fail'), 'rollback');
  assert.equal(resume({ ...inFlight, phase: 'installing' }, 'fail'), 'reinstall');
  // Killed during the install with nothing healthy: install again (installers are idempotent).
  const again = fixture({ bodies: ['unreachable', green, green, green], ledger: { components: {}, inFlight: { ...inFlight, phase: 'installing', snapshot: undefined } } });
  assert.equal((await deployComponent(again.effects, kiosk, 'v0.3.0', sha, '/tmp/rel')).health, 'pass');
  assert.deepEqual(again.calls.filter(call => call.startsWith('sudo')), ['sudo deploy/install-kiosk.sh /tmp/rel/kiosk']);
});

test('usage installs from the checkout, probes the timer and rolls back without a snapshot argument', async () => {
  const { effects, calls } = fixture({ bodies: ['active\n', 'inactive\n'] });
  const receipt = await deployComponent(effects, usage, 'v0.3.0', sha, '/tmp/rel');
  assert.deepEqual(receipt, { component: 'usage', sha, health: 'fail', rollback: snapshot });
  assert.deepEqual(calls.filter(call => call.startsWith('sudo')), ['sudo deploy/install-usage.sh', 'sudo deploy/rollback-usage.sh']);
});

test('plan: changed inputs since the baseline, recipe order, skips components the ledger has at this SHA and ones with no changes', () => {
  const sources = { meter: ['meter', 'shared', 'factory-db'], 'factory-api': ['factory-api', 'shared', 'factory-db', 'pricing'], kiosk: ['kiosk', 'factory-api/openapi.json'], usage: ['scripts/usage'] };
  const changed = ['kiosk/src/App.tsx', 'docs/x.md', 'shared/build.rs', 'deploy/factory-usage.timer'];
  const names = (ledger: Ledger, baselines: Record<string, string | undefined>) =>
    plan({ sha, sources, baselines, ledger, changedSince: () => changed }).map(recipe => recipe.name);
  const all = { meter: 'base', 'factory-api': 'base', kiosk: 'base', usage: 'base' };
  assert.deepEqual(names(emptyLedger(), all), ['meter', 'factory-api', 'kiosk', 'usage']);
  assert.deepEqual(names({ components: { meter: { sha, tag: 'v', health: 'pass' } } }, all), ['factory-api', 'kiosk', 'usage']);
  // A failed attempt at this SHA is retried; a component with no baseline installs; a prefix match needs a path boundary.
  assert.deepEqual(names({ components: { meter: { sha, tag: 'v', health: 'fail' } } }, { ...all, usage: undefined }), ['meter', 'factory-api', 'kiosk', 'usage']);
  assert.deepEqual(plan({ sha, sources, baselines: all, ledger: emptyLedger(), changedSince: () => ['kiosk-docs/readme.md', 'docs/odd/README.md'] }), []);
});

test('pending releases are immutable v-tags newer than the ledger, oldest first; bootstrap records the latest without deploying', async () => {
  assert.deepEqual(pendingTags(['v0.2.10', 'v0.2.9', 'latest', 'v0.3.0', 'v0.2.8-rc1'], 'v0.2.9'), ['v0.2.10', 'v0.3.0']);
  assert.deepEqual(pendingTags(['v0.2.9'], 'v0.2.9'), []);
  const { effects, calls, ledger } = fixture({ bodies: [] });
  effects.run = (command, args) => ({ stdout: command === 'gh' && args[0] === 'release' ? JSON.stringify([{ tagName: 'v0.2.9' }, { tagName: 'v0.2.10' }]) : '', stderr: '' });
  await main(effects);
  assert.equal(ledger().lastTag, 'v0.2.10');
  assert.deepEqual(calls, []);
});

test('issues come from squash subjects and PR bodies; snapshots and probes parse installer and health output', () => {
  const bodies: Record<number, string> = { 181: 'closes MET-302\nSee MET-999 for context', 180: 'contributes MET-279', 7: 'nothing' };
  assert.deepEqual(issuesFromSubjects(['MET-302: note (#181)', 'Phase 4 fixes (#180)', 'docs (#7)', 'no pr'], pr => bodies[pr] ?? ''), ['MET-302', 'MET-279']);
  assert.equal(parseSnapshot('Rollback snapshot: /var/backups/meter/20261024T1.abc\nmore\n'), '/var/backups/meter/20261024T1.abc');
  assert.equal(parseSnapshot('Snapshot: /var/backups/factory-usage/20261024T1\nERROR: usage install failed'), '/var/backups/factory-usage/20261024T1');
  assert.equal(parseSnapshot('ERROR: kiosk install failed at line 9. Snapshot: not created (kiosk unchanged). Recover with: ...'), undefined);
  const http = { kind: 'http' as const, url: 'http://127.0.0.1:8080/version.json' };
  assert.equal(probeResult(http, sha, JSON.stringify({ git_sha: sha.slice(0, 7), git_dirty: false })), 'pass');
  assert.equal(probeResult(http, sha, JSON.stringify({ git_sha: sha, status: 'degraded' })), 'fail');
  assert.equal(probeResult(http, sha, JSON.stringify({ git_sha: sha, git_dirty: true })), 'fail');
  assert.equal(probeResult(http, sha, JSON.stringify({ git_sha: 'abc' })), 'fail');
  assert.equal(probeResult(http, sha, 'not json'), 'fail');
  assert.equal(probeResult({ kind: 'unit', unit: 'factory-usage.timer' }, sha, 'active\n'), 'pass');
});
