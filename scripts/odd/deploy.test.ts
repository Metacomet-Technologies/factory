import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployComponent, emptyLedger, issuesFromSubjects, main, parseSnapshot, pendingTags, plan, probeResult, receiptLine, recipes, restoredResult, resume, type Effects, type Ledger } from './deploy.ts';
import { nextAction, parseDeployReceipt, type Action } from './lifecycle.ts';
import plugin, { diagnose, page, setStatus } from '../../.amp/plugins/factory-odd.ts';

const sha = 'a'.repeat(40);
const kiosk = recipes.find(recipe => recipe.name === 'kiosk')!;
const snapshot = '/var/backups/factory-kiosk/20261024T120000.000000Z.abc123';
const idle = { orbs: 0, runnerSlots: 0, buildIssues: 0 };
const deploying = (line: string) => nextAction({ identifier: 'MET-1', status: 'Deploying', labels: ['odd'], description: '', openBlockers: [], deployReceipt: parseDeployReceipt(line) }, idle);

/** deployComponent fixture: fake sudo and curl, scripted health bodies per probe. */
function fixture(options: { installOk?: boolean; rollbackOk?: boolean; bodies: string[]; ledger?: Ledger }) {
  let ledger = options.ledger ?? emptyLedger();
  const calls: string[] = [];
  const bodies = [...options.bodies];
  const effects: Effects = {
    stateDir: '/nonexistent',
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
    linear: { deploying: async () => true, posted: async () => false, comment: async () => {} },
  };
  return { effects, calls, ledger: () => ledger };
}

const green = JSON.stringify({ git_sha: sha, git_dirty: false, status: 'ok' });
const previous = JSON.stringify({ git_sha: 'b'.repeat(40), git_dirty: false, status: 'ok' });

test('install, three green probes 20 s apart, pass receipt, ledger records the component', async () => {
  const { effects, calls, ledger } = fixture({ bodies: [green, green, green] });
  const receipt = await deployComponent(effects, kiosk, 'v0.3.0', sha, '/tmp/rel');
  assert.deepEqual(receipt, { component: 'kiosk', sha, health: 'pass', rollback: 'none' });
  assert.deepEqual(calls, ['sudo deploy/install-kiosk.sh /tmp/rel/kiosk', 'probe', 'sleep', 'probe', 'sleep', 'probe']);
  assert.deepEqual(ledger(), { components: { kiosk: { sha, tag: 'v0.3.0', health: 'pass', snapshot } }, inFlight: undefined });
  assert.equal(receiptLine(receipt), `odd-deploy host=factory-gpu component=kiosk sha=${sha} health=pass rollback=none`);
});

test('an installer failure after its snapshot rolls back and re-probes; before any change it does not', async () => {
  const withSnapshot = fixture({ bodies: [previous, previous, previous], installOk: false });
  assert.deepEqual(await deployComponent(withSnapshot.effects, kiosk, 'v0.3.0', sha, '/tmp/rel'), { component: 'kiosk', sha, health: 'fail', rollback: snapshot });
  assert.equal(withSnapshot.calls.filter(call => call.includes('rollback')).length, 1);
  const unchanged = fixture({ bodies: [], installOk: false });
  unchanged.effects.sudo = () => ({ ok: false, output: 'ERROR: preflight failed\nNo deployment changes made; no rollback snapshot exists.\n' });
  assert.deepEqual(await deployComponent(unchanged.effects, kiosk, 'v0.3.0', sha, '/tmp/rel'), { component: 'kiosk', sha, health: 'fail', rollback: 'none' });
});

test('the enabled set is meter, factory-api and kiosk in install order, each with a restoring rollback', () => {
  assert.deepEqual(recipes.map(recipe => [recipe.name, recipe.rollback]), [
    ['meter', 'deploy/rollback-meter-v1.sh'], ['factory-api', 'deploy/rollback-factory-api.sh'], ['kiosk', 'deploy/rollback-kiosk.sh'],
  ]);
});

test('plan: changed inputs since the baseline, recipe order, skips components the ledger has at this SHA and ones with no changes', () => {
  const sources = { meter: ['meter', 'shared', 'factory-db'], 'factory-api': ['factory-api', 'shared', 'factory-db', 'pricing'], kiosk: ['kiosk', 'factory-api/openapi.json'], usage: ['scripts/usage'] };
  const changed = ['kiosk/src/App.tsx', 'docs/x.md', 'shared/build.rs', 'scripts/usage/collect.ts', 'deploy/factory-usage.timer'];
  const names = (ledger: Ledger, baselines: Record<string, string | undefined>) =>
    plan({ sha, sources, baselines, ledger, changedSince: () => changed }).map(recipe => recipe.name);
  const all = { meter: 'base', 'factory-api': 'base', kiosk: 'base' };
  // Usage changed too, but it is not in the enabled set.
  assert.deepEqual(names(emptyLedger(), all), ['meter', 'factory-api', 'kiosk']);
  assert.deepEqual(names({ components: { meter: { sha, tag: 'v', health: 'pass' } } }, all), ['factory-api', 'kiosk']);
  // A failed attempt at this SHA is retried; a component with no baseline installs; a prefix match needs a path boundary.
  assert.deepEqual(names({ components: { meter: { sha, tag: 'v', health: 'fail' } } }, { ...all, kiosk: undefined }), ['meter', 'factory-api', 'kiosk']);
  assert.deepEqual(plan({ sha, sources, baselines: all, ledger: emptyLedger(), changedSince: () => ['kiosk/x.ts'] }).map(recipe => recipe.name), ['kiosk']);
  assert.deepEqual(plan({ sha, sources, baselines: all, ledger: emptyLedger(), changedSince: () => ['kiosk-docs/readme.md', 'docs/odd/README.md'] }), []);
});

test('issues come from squash subjects and PR bodies; snapshots and probes parse installer and health output', () => {
  const bodies: Record<number, string> = { 181: 'closes MET-302\nSee MET-999 for context', 180: 'contributes MET-279', 7: 'nothing' };
  assert.deepEqual(issuesFromSubjects(['MET-302: note (#181)', 'Phase 4 fixes (#180)', 'docs (#7)', 'no pr'], pr => bodies[pr] ?? ''), ['MET-302', 'MET-279']);
  assert.equal(parseSnapshot('Rollback snapshot: /var/backups/meter/20261024T1.abc\nmore\n'), '/var/backups/meter/20261024T1.abc');
  assert.equal(parseSnapshot('ERROR: kiosk install failed at line 9. Snapshot: not created (kiosk unchanged). Recover with: ...'), undefined);
  assert.equal(probeResult(sha, JSON.stringify({ git_sha: sha.slice(0, 7), git_dirty: false })), 'pass');
  assert.equal(probeResult(sha, JSON.stringify({ git_sha: sha, status: 'degraded' })), 'fail');
  assert.equal(probeResult(sha, JSON.stringify({ git_sha: sha, git_dirty: true })), 'fail');
  assert.equal(probeResult(sha, JSON.stringify({ git_sha: 'abc' })), 'fail');
  assert.equal(probeResult(sha, 'not json'), 'fail');
  // Restored means healthy on another release: still on the target, degraded or unreachable is not.
  assert.equal(restoredResult(sha, previous), 'pass');
  assert.equal(restoredResult(sha, green), 'fail');
  assert.equal(restoredResult(sha, JSON.stringify({ git_sha: 'b'.repeat(40), status: 'degraded' })), 'fail');
  assert.equal(restoredResult(sha, 'curl: (7) connection refused'), 'fail');
});

// --- Sandbox fixture: main() end to end against a fake host. -------------------------------
// Real files for the release download (written 0644 like release.py's Path.write_bytes) and the
// executable bit; fake gh, git, sudo (installers move the live SHA, rollbacks restore it), curl
// (health bodies from the live SHA) and Linear. No real sudo, network or Linear write.

const shas = { 'v0.2.9': '0'.repeat(40), 'v0.3.0': '1'.repeat(40), 'v0.3.1': '2'.repeat(40) } as const;
type Tag = keyof typeof shas;
const order = Object.values(shas);
const sources = { meter: ['meter', 'shared', 'factory-db'], 'factory-api': ['factory-api', 'shared', 'factory-db', 'pricing'], kiosk: ['kiosk', 'factory-api/openapi.json'], usage: ['scripts/usage'] };
const ports: Record<string, string> = { '11434': 'meter', '8080/v1': 'factory-api', '8080/version': 'kiosk' };

function world(options: {
  tags: Tag[];
  /** Paths each release changed relative to its predecessor. */
  changes: Partial<Record<Tag, string[]>>;
  /** Issues each release closes, as `MET-n: subject (#pr)` with PR body `closes MET-n`. */
  issues?: Partial<Record<Tag, string[]>>;
  ledger: Ledger;
  live?: Record<string, string>;
  /** Components whose new release reports degraded health. */
  broken?: string[];
  /** Components degraded on their starting release (a failed rollback left them so). */
  startDegraded?: string[];
  rollbackOk?: boolean;
  /** Rollback exits 0 but leaves the broken release running. */
  rollbackRestores?: boolean;
  notDeploying?: string[];
  /** Linear rejects this issue's comment once. */
  failComment?: string;
  /** Linear stores this issue's comment once but the response is lost. */
  lostComment?: string;
  /** `gh pr view` fails once with a transient error. */
  failPrView?: boolean;
  /** Components whose endpoint is unreachable until they are installed. */
  unreachable?: string[];
  /** Comments already on the issues. */
  comments?: [string, string][];
}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'odd-deploy-'));
  let ledger = structuredClone(options.ledger);
  const live: Record<string, string> = { meter: shas['v0.2.9'], 'factory-api': shas['v0.2.9'], kiosk: shas['v0.2.9'], ...options.live };
  const before: Record<string, string> = {};
  const start = { ...live };
  const calls: string[] = [];
  const comments: [string, string][] = [...options.comments ?? []];
  let failComment = options.failComment;
  let lostComment = options.lostComment;
  let failPrView = options.failPrView;
  const index = (value: string) => order.findIndex(full => full.startsWith(value));
  const changedBetween = (from: string, to: string) => order.slice(index(from) + 1, index(to) + 1)
    .flatMap(full => options.changes[(Object.keys(shas) as Tag[]).find(tag => shas[tag] === full)!] ?? []);
  const tagOf = (full: string) => (Object.keys(shas) as Tag[]).find(tag => shas[tag] === full)!;
  const healthBody = (component: string) => {
    const reported = live[component];
    const degraded = (options.broken?.includes(component) && reported !== before[component] && before[component] !== undefined)
      || (options.startDegraded?.includes(component) && reported === start[component]);
    return JSON.stringify({ git_sha: reported, git_dirty: false, status: degraded ? 'degraded' : 'ok' });
  };
  const effects: Effects = {
    stateDir,
    log: () => {},
    sleep: async () => {},
    run: (command, args) => {
      const out = (stdout: string) => ({ stdout, stderr: '' });
      if (command === 'gh' && args[0] === 'release') return out(JSON.stringify(options.tags.map(tagName => ({ tagName }))));
      if (command === 'gh' && args[0] === 'pr') {
        if (failPrView) { failPrView = false; throw new Error(`gh pr view ${args[2]} exited 1\nHTTP 503: Service Unavailable`); }
        if (args[2] === '404') throw new Error('gh pr view 404 exited 1\nGraphQL: Could not resolve to a PullRequest with the number of 404. (repository.pullRequest)');
        return out(JSON.stringify({ body: `closes MET-${args[2]}` }));
      }
      if (command === 'python3') {
        const dir = args[args.indexOf('--directory') + 1];
        calls.push(`verify ${args[args.indexOf('--tag') + 1]}`);
        mkdirSync(dir, { recursive: true });
        for (const asset of ['meter-linux-x86_64', 'factory-api-linux-x86_64', 'kiosk.tar.gz']) writeFileSync(join(dir, asset), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
        return out('complete: exact SHA, inventory and every digest verified\n');
      }
      if (command === 'tar') return out('');
      const git = args.slice(2);
      if (git[0] === 'rev-parse' && git[1] === '--verify') {
        const ref = git[2].replace(/^refs\/tags\//, '').replace('^{commit}', '');
        const full = ref in shas ? shas[ref as Tag] : order.find(candidate => candidate.startsWith(ref));
        if (!full) throw new Error(`unknown revision ${ref}`);
        return out(`${full}\n`);
      }
      if (git[0] === 'rev-parse') return out(`${order.at(-1)}\n`);
      if (git[0] === 'show') return out(JSON.stringify({ components: Object.entries(sources).map(([id, paths]) => ({ id, sources: paths })) }));
      if (git[0] === 'diff') { const [from, to] = git[2].split('..'); return out(changedBetween(from, to).join('\n')); }
      if (git[0] === 'log') {
        const [from, to] = git.at(-1)!.split('..');
        return out(order.slice(index(shas[from as Tag]) + 1, index(to) + 1).flatMap(full => (options.issues?.[tagOf(full)] ?? []).map(issue => `${issue}: change (#${issue.slice(4)})`)).join('\n'));
      }
      if (git[0] === 'checkout' && git.includes('--detach')) calls.push(`checkout ${git.at(-1)!.slice(0, 7)}`);
      return out('');
    },
    ok: (_command, args) => {
      const git = args.slice(2);
      if (git[0] === 'merge-base') return git[2] === 'main' || index(git[2]) <= index(git[3]);
      return false;
    },
    sudo: (script, args) => {
      calls.push(`sudo ${script} ${args.join(' ')}`.trim());
      const component = /deploy\/(?:install|rollback)-(.+?)(?:-v1)?\.sh$/.exec(script)![1];
      if (script.includes('/install-')) {
        const target = order.find(full => args[0].includes(`/releases/${tagOf(full)}/`))!;
        before[component] = live[component];
        live[component] = target;
        return { ok: true, output: `Rollback snapshot: /var/backups/${component}/snap\n` };
      }
      if (options.rollbackOk === false) return { ok: false, output: 'ERROR: rollback failed\n' };
      if (options.rollbackRestores !== false) live[component] = before[component];
      return { ok: true, output: '' };
    },
    probe: url => {
      calls.push('probe');
      const component = Object.entries(ports).find(([key]) => url.includes(`:${key}`))![1];
      if (options.unreachable?.includes(component) && live[component] === start[component]) throw new Error('curl: (7) Failed to connect');
      return healthBody(component);
    },
    readLedger: () => structuredClone(ledger),
    writeLedger: next => { ledger = structuredClone(next); },
    linear: {
      deploying: async identifier => !options.notDeploying?.includes(identifier),
      posted: async (identifier, body) => comments.some(([issue, text]) => issue === identifier && text === body),
      comment: async (identifier, body) => {
        if (failComment === identifier) { failComment = undefined; throw new Error('Linear 503'); }
        comments.push([identifier, body]);
        if (lostComment === identifier) { lostComment = undefined; throw new Error('Linear request timed out'); }
      },
    },
  };
  const cleanup = () => rmSync(stateDir, { recursive: true, force: true });
  return { effects, calls, comments, live, ledger: () => ledger, stateDir, cleanup };
}

// Components have no ledger records yet; baselines come from the health endpoints.
const baseline = (extra: Partial<Ledger> = {}): Ledger => ({ lastTag: 'v0.2.9', components: {}, ...extra });
const sudoCalls = (calls: string[]) => calls.filter(call => call.startsWith('sudo'));
const line = (fields: string) => `odd-deploy host=factory-gpu ${fields}`;

test('sandbox: a kiosk release installs, three green probes report its SHA, Deploying issues get a pass receipt and move to Done', async t => {
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx', 'docs/x.md'] }, issues: { 'v0.3.0': ['MET-301', 'MET-302'] }, notDeploying: ['MET-302'], ledger: baseline() });
  t.after(host.cleanup);
  await main(host.effects);
  const dir = join(host.stateDir, 'releases/v0.3.0');
  assert.deepEqual(host.calls, ['verify v0.3.0', 'checkout 1111111', 'probe', 'probe', 'probe', `sudo deploy/install-kiosk.sh ${dir}/kiosk`, 'probe', 'probe', 'probe']);
  assert.equal(host.live.kiosk, shas['v0.3.0']);
  const pass = line(`component=kiosk sha=${shas['v0.3.0']} health=pass rollback=none`);
  assert.deepEqual(host.comments, [['MET-301', pass]]);
  assert.deepEqual(deploying(pass), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify kiosk at 111111111111', round: 1 });
  assert.equal(host.ledger().lastTag, 'v0.3.0');
  assert.equal(host.ledger().receipt, undefined);
  // release.py downloads 0644; the meter and factory-api installers require -x.
  for (const binary of ['meter-linux-x86_64', 'factory-api-linux-x86_64']) assert.equal(statSync(join(dir, binary)).mode & 0o100, 0o100, binary);
});

test('sandbox: a red probe runs the rollback once, the restored release is re-probed, the fail receipt carries the snapshot, and the issue returns to Todo with a Bug and a log reader', async t => {
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-301'] }, broken: ['kiosk'], ledger: baseline() });
  t.after(host.cleanup);
  await assert.rejects(main(host.effects), /health=fail/);
  assert.deepEqual(sudoCalls(host.calls), [`sudo deploy/install-kiosk.sh ${host.stateDir}/releases/v0.3.0/kiosk`, 'sudo deploy/rollback-kiosk.sh /var/backups/kiosk/snap']);
  assert.equal(host.live.kiosk, shas['v0.2.9']);
  const fail = line(`component=kiosk sha=${shas['v0.3.0']} health=fail rollback=/var/backups/kiosk/snap`);
  assert.deepEqual(host.comments, [['MET-301', fail]]);
  const action = deploying(fail) as Extract<Action, { kind: 'set-status' }>;
  assert.equal(action.status, 'Todo');
  assert.equal(action.followUp?.title, 'Deploy failed: kiosk at 111111111111');
  assert.deepEqual(action.diagnose, parseDeployReceipt(fail));
  assert.equal(host.ledger().lastTag, 'v0.3.0');
});

/** Fake plugin context: records every tool call; `fail` makes that tool's next call fail once. */
function pluginContext(found: { id: string }[] = [], fail?: string) {
  const tools: [string, Record<string, unknown>][] = [];
  const bugs: string[] = [];
  const ctx = {
    tools: { call: async (name: string, input: Record<string, unknown>) => {
      tools.push([name, input]);
      if (name === fail) { fail = undefined; throw new Error(`${name}: HTTP 503`); }
      if (name === 'find_thread') return { threads: found };
      if (name === 'linear.list_issues') return { issues: bugs.map(title => ({ id: 'MET-900', title })) };
      if (name === 'linear.save_issue' && typeof input.title === 'string') bugs.push(input.title);
      return name === 'linear.save_issue' && input.title ? { identifier: 'MET-900' } : {};
    } },
    $: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    logger: { log: () => {} },
  };
  return { ctx: ctx as unknown as Parameters<typeof page>[0], tools };
}

for (const [name, options] of [['exits non-zero', { rollbackOk: false }], ['exits 0 but the release stays red', { rollbackRestores: false }]] as const) {
  test(`sandbox: a rollback that ${name} posts rollback=none and the control plane pages failed-rollback${'rollbackOk' in options ? '; the plugin DMs Devon by Slack with the receipt, labels the issue escalated and starts one log reader on factory-gpu' : ''}`, async t => {
    const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-301'] }, broken: ['kiosk'], ledger: baseline(), ...options });
    t.after(host.cleanup);
    await assert.rejects(main(host.effects), /health=fail rollback=none/);
    assert.equal(sudoCalls(host.calls).filter(call => call.includes('rollback')).length, 1);
    const fail = line(`component=kiosk sha=${shas['v0.3.0']} health=fail rollback=none`);
    assert.deepEqual(host.comments, [['MET-301', fail]]);
    const action = deploying(fail) as Extract<Action, { kind: 'page' }>;
    assert.equal(action.kind, 'page');
    assert.equal(action.reason, 'failed-rollback');
    if (!('rollbackOk' in options)) return;
    const issue = { identifier: 'MET-301', status: 'Deploying' as const, labels: ['odd'], description: '', openBlockers: [] };
    const { ctx, tools } = pluginContext();
    await page(ctx, issue, action);
    assert.deepEqual(tools.find(([tool]) => tool === 'linear.save_issue')?.[1], { id: 'MET-301', addLabels: ['escalated'] });
    const slack = tools.find(([tool]) => tool === 'slack_write')?.[1] as { text: string; userID?: string; channelName?: string };
    assert.ok(slack.text.includes(fail), slack.text);
    assert.equal(slack.channelName, undefined, 'no recipient: slack_write DMs the thread owner (Devon)');
    const spawned: [string[], string][] = [];
    await diagnose(ctx, issue, action.diagnose!, undefined, async (labels, content) => { spawned.push([labels, content]); return 'T-deployer'; });
    await diagnose(ctx, issue, action.diagnose!, undefined, async (labels, content) => { spawned.push([labels, content]); return 'T-second'; });
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0][0], ['odd-issue-met-301', 'odd-role-deployer', 'odd-round-1', 'odd-deploy-111111111111']);
    assert.ok(spawned[0][1].includes(fail) && spawned[0][1].includes('MET-301') && spawned[0][1].includes('odd-deployer'), spawned[0][1]);
  });
}

const redIssue = (receiptSha: string, rollback: string) => ({ identifier: 'MET-311', status: 'Deploying' as const, labels: ['odd'], description: '', openBlockers: [],
  deployReceipt: parseDeployReceipt(line(`component=kiosk sha=${receiptSha} health=fail rollback=${rollback}`)) });
const flakySpawn = (fails: boolean) => {
  const spawned: string[] = [];
  const spawn = async (_labels: string[], content: string) => {
    if (fails) { fails = false; throw new Error('runner factory-gpu offline'); }
    spawned.push(content);
    return 'T-deployer';
  };
  return { spawn, spawned };
};

for (const [what, receiptSha, failTool, spawnFails] of [['Bug lookup', 'c'.repeat(40), 'linear.list_issues', false], ['log-reader spawn', 'd'.repeat(40), undefined, true]] as const) {
  test(`control plane: when the ${what} fails, the issue stays in Deploying; re-evaluating it files one Bug, starts one log reader and only then moves it to Todo`, async () => {
    const issue = redIssue(receiptSha, '/var/backups/kiosk/snap');
    const { ctx, tools } = pluginContext([], failTool);
    const { spawn, spawned } = flakySpawn(spawnFails);
    const statusCalls = () => tools.filter(([tool, input]) => tool === 'linear.save_issue' && input.id === 'MET-311' && 'state' in input);
    const action = nextAction(issue, idle) as Extract<Action, { kind: 'set-status' }>;
    await assert.rejects(setStatus(ctx, issue, action, spawn), /503|offline/);
    assert.deepEqual(statusCalls(), [], 'still Deploying, so no builder can take it');
    // The issue Linear reports is unchanged, so the next evaluation derives the same action.
    assert.deepEqual(nextAction(issue, idle), action);
    await setStatus(ctx, issue, action, spawn);
    assert.deepEqual(tools.at(-1), ['linear.save_issue', { id: 'MET-311', state: 'Todo' }]);
    assert.equal(statusCalls().length, 1);
    assert.equal(tools.filter(([tool, input]) => tool === 'linear.save_issue' && input.title).length, 1, 'one Bug');
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0].includes('MET-900'), spawned[0]);
  });
}

/** The registered plugin armed in a control thread, with fake Amp, Linear, GitHub and Slack. */
async function controlPlane(options: { issue: string; receipt: string; failOnce: string }) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const webhooks = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const calls: string[] = [];
  const bugs: string[] = [];
  let status = 'Deploying';
  let failOnce: string | undefined = options.failOnce;
  const alerts: string[] = [];
  const tools = { call: async (name: string, input: Record<string, unknown>) => {
    // The Watchdog sweep enumerates issues by status and posts to #factory-alerts; neither is the handoff under test.
    if (name === 'linear.list_issues' && (input.state !== undefined || input.label !== undefined)) return { issues: [] };
    if (name === 'slack_write' && input.channelName !== undefined) { alerts.push(String(input.text)); return {}; }
    if (name === failOnce) { failOnce = undefined; calls.push(`${name} failed`); throw new Error(`${name}: HTTP 503`); }
    switch (name) {
      case 'linear.get_issue': return { id: options.issue, status, labels: ['odd'], description: '', relations: { blockedBy: [] } };
      case 'linear.list_comments': return { comments: [{ body: options.receipt, createdAt: '2026-10-24T15:00:00Z' }, { body: 'odd-merge pr=1 head=a merge=b release=none', createdAt: '2026-10-24T14:00:00Z' }] };
      case 'linear.list_issues': calls.push('Bug lookup'); return { issues: bugs.map(title => ({ id: 'MET-900', title })) };
      case 'linear.save_issue':
        if (typeof input.title === 'string') { bugs.push(input.title); calls.push('Bug created'); return { identifier: 'MET-900' }; }
        if (typeof input.state === 'string') { status = input.state; calls.push(`status ${status}`); }
        return {};
      case 'find_thread': return { threads: [] };
      case 'slack_read': return { messages: [] };
      // The sweep writes the heartbeat on its own; this test pins the receipt handoff's calls.
      case 'linear.get_status_updates': return { statusUpdates: [], hasNextPage: false, cursor: '' };
      case 'linear.save_status_update': return { id: 'update-1' };
      default: calls.push(name); return {};
    }
  } };
  const thread = { id: 'T-control', labels: async () => ['odd-control-plane', 'odd-perform'] };
  const ui = { confirm: async () => true, notify: async () => {} };
  const logger = { log: () => {} };
  const agent = { definition: {}, createThread: async (options: { executor: unknown }) => ({
    id: 'T-deployer', setLabels: async (labels: string[]) => { calls.push(`log reader ${JSON.stringify(options.executor)} ${labels.at(-1)}`); }, appendUserMessage: async () => {},
  }) };
  const $ = async () => ({ exitCode: 0, stdout: '[]', stderr: '' });
  const amp = {
    $, createAgent: () => agent, registerAgentMode: () => {}, registerTool: () => {},
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, handler); },
    createWebhook: async ({ key, handler }: { key: string; handler: (event: unknown, ctx: unknown) => Promise<void> }) => { webhooks.set(key, handler); return { url: `https://hooks.example/${key}` }; },
    system: { executor: { kind: 'remote', keepAlive: async () => {} } },
  };
  await (plugin as unknown as (api: unknown) => Promise<void>)(amp);
  await handlers.get('session.start')!({}, { thread, ui, logger, tools });
  const deliver = (id: string) => webhooks.get('linear')!(
    { id, receivedAt: '2026-10-24T15:00:01Z', body: new TextEncoder().encode(JSON.stringify({ data: { identifier: options.issue } })) },
    { thread, ui, logger, tools, $ });
  return { deliver, calls, alerts, status: () => status };
}

const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };

test('control plane, through the registered webhook: a transient Bug-lookup failure is re-evaluated by itself, and a redelivery of the failed event is not ignored', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const receipt = line(`component=kiosk sha=${'f'.repeat(40)} health=fail rollback=/var/backups/kiosk/snap`);
  const host = await controlPlane({ issue: 'MET-312', receipt, failOnce: 'linear.list_issues' });
  await assert.rejects(host.deliver('evt-1'), /HTTP 503/);
  assert.deepEqual(host.calls, ['linear.list_issues failed']);
  assert.equal(host.status(), 'Deploying');
  // No new event arrives: the failure's own re-check (90 s) finishes the handoff.
  mock.timers.tick(90_000);
  await settle();
  assert.deepEqual(host.calls.slice(1), ['Bug lookup', 'Bug created', 'log reader {"type":"runner","id":"factory-gpu"} odd-deploy-ffffffffffff', 'status Todo']);
  assert.equal(host.status(), 'Todo');

  // A redelivery of a failed event is evaluated again rather than dropped as seen.
  const again = await controlPlane({ issue: 'MET-313', receipt: receipt.replace('f'.repeat(40), '9'.repeat(40)), failOnce: 'linear.list_issues' });
  await assert.rejects(again.deliver('evt-2'), /HTTP 503/);
  await again.deliver('evt-2');
  assert.equal(again.status(), 'Todo');
  assert.equal(again.calls.filter(call => call === 'Bug created').length, 1);
});

test('control plane: a failed rollback pages even when its log reader cannot start, says so in the page, and sets escalated last', async () => {
  const issue = redIssue('e'.repeat(40), 'none');
  const action = nextAction(issue, idle) as Extract<Action, { kind: 'page' }>;
  const { ctx, tools } = pluginContext();
  await page(ctx, issue, action, flakySpawn(true).spawn);
  const slack = tools.find(([tool]) => tool === 'slack_write')?.[1] as { text: string };
  assert.match(slack.text, /log reader not started: Error: runner factory-gpu offline/);
  assert.deepEqual(tools.at(-1), ['linear.save_issue', { id: 'MET-311', addLabels: ['escalated'] }]);
});

test('sandbox: a release that touches no enabled component posts component=none and its issues move to Done', async t => {
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['docs/odd/README.md', 'kiosk-docs/readme.md'] }, issues: { 'v0.3.0': ['MET-301'] }, ledger: baseline() });
  t.after(host.cleanup);
  await main(host.effects);
  assert.deepEqual(sudoCalls(host.calls), []);
  const none = line(`component=none sha=${shas['v0.3.0']} health=pass rollback=none`);
  assert.deepEqual(host.comments, [['MET-301', none]]);
  assert.deepEqual(deploying(none), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify none at 111111111111', round: 1 });
});

test('sandbox: killed between install and probe, the rerun resumes the in-flight kiosk without a second install and finishes the probe', async t => {
  const inFlight = { tag: 'v0.3.0', sha: shas['v0.3.0'], component: 'kiosk', phase: 'probing' as const, snapshot: '/var/backups/kiosk/snap' };
  // The install landed before the kill: the endpoint already reports the release SHA.
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-301'] }, live: { kiosk: shas['v0.3.0'] }, ledger: baseline({ inFlight }) });
  t.after(host.cleanup);
  await main(host.effects);
  assert.deepEqual(sudoCalls(host.calls), []);
  assert.equal(host.calls.filter(call => call === 'probe').length, 3 + 3, 'three baseline reads (meter, factory-api, kiosk), then the kiosk window');
  assert.deepEqual(host.comments, [['MET-301', line(`component=kiosk sha=${shas['v0.3.0']} health=pass rollback=none`)]]);
  assert.equal(host.ledger().inFlight, undefined);
  assert.deepEqual(host.ledger().components.kiosk, { sha: shas['v0.3.0'], tag: 'v0.3.0', health: 'pass', snapshot: '/var/backups/kiosk/snap' });
  assert.equal(host.ledger().lastTag, 'v0.3.0');
  // Killed during the install with the old release still live: one install, not two.
  const again = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, ledger: baseline({ inFlight: { ...inFlight, phase: 'installing', snapshot: undefined } }) });
  t.after(again.cleanup);
  await main(again.effects);
  assert.equal(sudoCalls(again.calls).length, 1);
  assert.equal(again.ledger().components.kiosk.health, 'pass');
  // An earlier recipe that becomes eligible during recovery (meter: no record, endpoint down) waits
  // until kiosk has resumed, so it cannot overwrite kiosk's inFlight entry or snapshot.
  const earlier = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-301'] }, live: { kiosk: shas['v0.3.0'] }, unreachable: ['meter'], ledger: baseline({ inFlight }) });
  t.after(earlier.cleanup);
  await main(earlier.effects);
  assert.deepEqual(sudoCalls(earlier.calls), [`sudo deploy/install-meter.sh ${earlier.stateDir}/releases/v0.3.0/meter-linux-x86_64`]);
  assert.deepEqual(earlier.ledger().components.kiosk, { sha: shas['v0.3.0'], tag: 'v0.3.0', health: 'pass', snapshot: '/var/backups/kiosk/snap' });
  assert.deepEqual(earlier.comments, [['MET-301', line(`component=meter+kiosk sha=${shas['v0.3.0']} health=pass rollback=none`)]]);
});

test('sandbox: a rolled-back component is retried by the next release even when that release touches only docs', async t => {
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'], 'v0.3.1': ['docs/x.md'] }, broken: ['kiosk'], ledger: baseline() });
  t.after(host.cleanup);
  await assert.rejects(main(host.effects));
  assert.equal(host.ledger().components.kiosk.health, 'fail');
  const next = world({ tags: ['v0.2.9', 'v0.3.0', 'v0.3.1'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'], 'v0.3.1': ['docs/x.md'] }, issues: { 'v0.3.1': ['MET-303'] }, ledger: host.ledger() });
  t.after(next.cleanup);
  await main(next.effects);
  assert.deepEqual(sudoCalls(next.calls), [`sudo deploy/install-kiosk.sh ${next.stateDir}/releases/v0.3.1/kiosk`]);
  assert.deepEqual(next.comments, [['MET-303', line(`component=kiosk sha=${shas['v0.3.1']} health=pass rollback=none`)]]);
  // A failed rollback left v0.3.0 running degraded: a degraded endpoint is no baseline, so kiosk reinstalls.
  const degraded = world({ tags: ['v0.2.9', 'v0.3.0', 'v0.3.1'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'], 'v0.3.1': ['docs/x.md'] }, live: { kiosk: shas['v0.3.0'] }, startDegraded: ['kiosk'], ledger: host.ledger() });
  t.after(degraded.cleanup);
  await main(degraded.effects);
  assert.deepEqual(sudoCalls(degraded.calls), [`sudo deploy/install-kiosk.sh ${degraded.stateDir}/releases/v0.3.1/kiosk`]);
});

test('sandbox: a receipt delivery that fails midway is resumed by the rerun without reinstalling or reposting', async t => {
  const options = { tags: ['v0.2.9', 'v0.3.0'] as Tag[], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-301', 'MET-302'] }, broken: ['kiosk'] };
  const host = world({ ...options, ledger: baseline(), failComment: 'MET-302' });
  t.after(host.cleanup);
  await assert.rejects(main(host.effects), /Linear 503/);
  assert.equal(host.ledger().lastTag, 'v0.2.9');
  const fail = line(`component=kiosk sha=${shas['v0.3.0']} health=fail rollback=/var/backups/kiosk/snap`);
  assert.deepEqual(host.comments, [['MET-301', fail]]);
  const rerun = world({ ...options, ledger: host.ledger() });
  t.after(rerun.cleanup);
  await assert.rejects(main(rerun.effects), /health=fail/);
  assert.deepEqual(sudoCalls(rerun.calls), []);
  assert.deepEqual(rerun.comments, [['MET-302', fail]]);
  assert.equal(rerun.ledger().lastTag, 'v0.3.0');
});

test('sandbox: a comment Linear stored but whose response was lost is not posted again by the rerun', async t => {
  const options = { tags: ['v0.2.9', 'v0.3.0'] as Tag[], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-301'] } };
  const host = world({ ...options, ledger: baseline(), lostComment: 'MET-301' });
  t.after(host.cleanup);
  await assert.rejects(main(host.effects), /timed out/);
  assert.equal(host.ledger().lastTag, 'v0.2.9');
  const rerun = world({ ...options, ledger: host.ledger(), comments: host.comments });
  t.after(rerun.cleanup);
  await main(rerun.effects);
  assert.deepEqual(sudoCalls([...host.calls, ...rerun.calls]), [`sudo deploy/install-kiosk.sh ${host.stateDir}/releases/v0.3.0/kiosk`]);
  assert.deepEqual(rerun.comments, [['MET-301', line(`component=kiosk sha=${shas['v0.3.0']} health=pass rollback=none`)]]);
  assert.equal(rerun.ledger().lastTag, 'v0.3.0');
});

test('sandbox: a transient PR lookup failure keeps the release pending; the rerun finds the issue and delivers without reinstalling', async t => {
  // #404 is not a PR (no body, no issue); a 503 on #301 must not be mistaken for that.
  const options = { tags: ['v0.2.9', 'v0.3.0'] as Tag[], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-301', 'MET-404'] } };
  const host = world({ ...options, ledger: baseline(), failPrView: true });
  t.after(host.cleanup);
  await assert.rejects(main(host.effects), /HTTP 503/);
  assert.deepEqual(host.comments, []);
  assert.equal(host.ledger().lastTag, 'v0.2.9');
  const rerun = world({ ...options, ledger: host.ledger() });
  t.after(rerun.cleanup);
  await main(rerun.effects);
  assert.deepEqual(sudoCalls(rerun.calls), []);
  assert.deepEqual(rerun.comments, [['MET-301', line(`component=kiosk sha=${shas['v0.3.0']} health=pass rollback=none`)]]);
  assert.equal(rerun.ledger().lastTag, 'v0.3.0');
});

test('pending releases are immutable v-tags newer than the ledger, oldest first; bootstrap records the latest without deploying', async t => {
  assert.deepEqual(pendingTags(['v0.2.10', 'v0.2.9', 'latest', 'v0.3.0', 'v0.2.8-rc1'], 'v0.2.9'), ['v0.2.10', 'v0.3.0']);
  assert.deepEqual(pendingTags(['v0.2.9'], 'v0.2.9'), []);
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, ledger: emptyLedger() });
  t.after(host.cleanup);
  await main(host.effects);
  assert.equal(host.ledger().lastTag, 'v0.3.0');
  assert.deepEqual(host.calls, []);
  assert.equal(resume({ tag: 'v', sha, component: 'kiosk', phase: 'probing' }, 'fail'), 'rollback');
  assert.equal(resume({ tag: 'v', sha, component: 'kiosk', phase: 'installing' }, 'fail'), 'reinstall');
});
