import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, deployComponent, emptyLedger, issuesFromSubjects, main, parseSnapshot, pendingTags, plan, probeResult, receiptLine, recipes, reconcileManual, restoredResult, resume, type Effects, type Ledger } from './deploy.ts';
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
  assert.deepEqual(calls, ['sudo deploy/install-kiosk.sh --source-checkout /nonexistent/source /tmp/rel/kiosk', 'probe', 'sleep', 'probe', 'sleep', 'probe']);
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
    plan({ sha, sources, baselines, ledger, changedSince: () => changed, isAncestor: () => true }).map(recipe => recipe.name);
  const all = { meter: 'base', 'factory-api': 'base', kiosk: 'base' };
  // Usage changed too, but it is not in the enabled set.
  assert.deepEqual(names(emptyLedger(), all), ['meter', 'factory-api', 'kiosk']);
  assert.deepEqual(names({ components: { meter: { sha, tag: 'v', health: 'pass' } } }, all), ['factory-api', 'kiosk']);
  // A failed attempt at this SHA is retried; a component with no baseline installs; a prefix match needs a path boundary.
  assert.deepEqual(names({ components: { meter: { sha, tag: 'v', health: 'fail' } } }, { ...all, kiosk: undefined }), ['meter', 'factory-api', 'kiosk']);
  assert.deepEqual(plan({ sha, sources, baselines: all, ledger: emptyLedger(), changedSince: () => ['kiosk/x.ts'], isAncestor: () => true }).map(recipe => recipe.name), ['kiosk']);
  assert.deepEqual(plan({ sha, sources, baselines: all, ledger: emptyLedger(), changedSince: () => ['kiosk-docs/readme.md', 'docs/odd/README.md'], isAncestor: () => true }), []);
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

const shas = { 'v0.2.9': '0'.repeat(40), 'v0.2.10': 'a'.repeat(40), 'v0.2.11': 'b'.repeat(40),
  'v0.2.49': '6c157fe65cb9e4c4e07d55548b4cd3f6f2253240', 'v0.2.50': 'c'.repeat(40), 'v0.3.0': '1'.repeat(40), 'v0.3.1': '2'.repeat(40) } as const;
type Tag = keyof typeof shas;
const order = Object.values(shas);
const sources = { meter: ['meter', 'shared', 'factory-db'], 'factory-api': ['factory-api', 'shared', 'factory-db', 'pricing'], kiosk: ['kiosk', 'factory-api/openapi.json'], usage: ['scripts/usage'] };
const v2Plan = 'meter-plan mode=v2 user_version=2 db_changing=no';
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
  /** What `install-meter.sh --plan` reports (default an eligible v2 rerun). */
  meterPlan?: { ok: boolean; output: string };
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
  const changedBetween = (from: string, to: string) => order.slice(Math.min(index(from), index(to)) + 1, Math.max(index(from), index(to)) + 1)
    .flatMap(full => options.changes[(Object.keys(shas) as Tag[]).find(tag => shas[tag] === full)!] ?? []);
  const tagOf = (full: string) => (Object.keys(shas) as Tag[]).find(tag => shas[tag] === full)!;
  const identity = (full: string) => ({ git_sha: full, git_dirty: false, version: tagOf(full).slice(1), built_at_ms: 1792900000000, inputs_fingerprint: '012345abcdef' });
  // Actual v0.2.49 version.json shape and build hash; release-build.json is not this endpoint.
  const kioskIdentity = (full: string) => ({ build: full === shas['v0.2.49']
    ? '704da8361162b180e372d1fb7c3b5b27cb1212b6297fb571413ad71546598e1a' : full.padEnd(64, 'f'), git_sha: full, git_dirty: false });
  const healthBody = (component: string) => {
    const reported = live[component];
    const degraded = (options.broken?.includes(component) && reported !== before[component] && before[component] !== undefined)
      || (options.startDegraded?.includes(component) && reported === start[component]);
    if (component === 'kiosk') return JSON.stringify({ ...kioskIdentity(reported), ...(degraded ? { status: 'degraded' } : {}) });
    return JSON.stringify({ ...identity(reported), status: degraded ? 'degraded' : 'ok',
      openapi_sha256: 'abcdef123456', meter_openapi_expected: 'abcdef123456', meter_openapi_sha256: 'abcdef123456' });
  };
  const effects: Effects = {
    stateDir,
    log: () => {},
    sleep: async () => {},
    run: (command, args) => {
      const out = (stdout: string) => ({ stdout, stderr: '' });
      if (command === 'gh' && args[0] === 'api') return out(JSON.stringify([options.tags.map(tag_name => ({ tag_name, draft: false, prerelease: false }))]));
      if (command === 'gh' && args[0] === 'pr') {
        if (failPrView) { failPrView = false; throw new Error(`gh pr view ${args[2]} exited 1\nHTTP 503: Service Unavailable`); }
        if (args[2] === '404') throw new Error('gh pr view 404 exited 1\nGraphQL: Could not resolve to a PullRequest with the number of 404. (repository.pullRequest)');
        return out(JSON.stringify({ body: `closes MET-${args[2]}` }));
      }
      if (command === 'python3') {
        assert.equal(args[0], join(ROOT, 'scripts/release/release.py'));
        assert.equal(args[1], 'verify');
        assert.ok(!args.includes('--anonymous'), 'deployment verification must use existing gh authentication');
        const dir = args[args.indexOf('--directory') + 1];
        calls.push(`verify ${args[args.indexOf('--tag') + 1]}`);
        mkdirSync(dir, { recursive: true });
        for (const asset of ['meter-linux-x86_64', 'factory-api-linux-x86_64', 'kiosk.tar.gz']) writeFileSync(join(dir, asset), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ build_identity: Object.fromEntries(recipes.map(recipe => [recipe.name, identity(args[args.indexOf('--sha') + 1])])) }));
        writeFileSync(join(dir, 'version.json'), JSON.stringify(kioskIdentity(args[args.indexOf('--sha') + 1])));
        assert.equal(spawnSync('tar', ['-czf', join(dir, 'kiosk.tar.gz'), '-C', dir, 'version.json']).status, 0);
        rmSync(join(dir, 'version.json'));
        return out('complete: exact SHA, inventory and every digest verified\n');
      }
      if (command === 'tar') {
        if (args[0] !== '-xOf') return out('');
        const result = spawnSync(command, args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return out(result.stdout);
      }
      const git = args.slice(2);
      if (git[0] === 'rev-parse' && git[1] === '--absolute-git-dir') return out(`${args[1]}/.git`);
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
        const before = from.endsWith('^') ? index(shas[from.slice(0, -1) as Tag]) - 1 : index(shas[from as Tag] ?? from);
        return out(order.slice(before + 1, index(to) + 1).flatMap(full => (options.issues?.[tagOf(full)] ?? []).map(issue => `${issue}: change (#${issue.slice(4)})`)).join('\n'));
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
      const component = /deploy\/(?:install|rollback)-(.+?)(?:-v1)?\.sh$/.exec(script)![1];
      if (script.includes('/install-')) {
        assert.deepEqual(args.slice(0, 2), ['--source-checkout', join(stateDir, 'source')]);
        // The read-only plan is recorded apart from sudo installs and rollbacks.
        if (args[2] === '--plan') { calls.push(`plan ${component}`); return options.meterPlan ?? { ok: true, output: `${v2Plan}\n` }; }
        calls.push(`sudo ${script} ${args.slice(2).join(' ')}`);
        const target = order.find(full => args.at(-1)!.includes(`/releases/${tagOf(full)}/`))!;
        before[component] = live[component];
        live[component] = target;
        return { ok: true, output: `Rollback snapshot: /var/backups/${component}/snap\n` };
      }
      calls.push(`sudo ${script} ${args.join(' ')}`.trim());
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

function manuallyRecovered() {
  const tags: Tag[] = ['v0.2.10', 'v0.2.11', 'v0.2.49'];
  const host = world({ tags, ledger: { lastTag: 'v0.2.10', components: { meter: { tag: 'v0.2.10', sha: shas['v0.2.10'], health: 'fail' } } },
    live: Object.fromEntries(recipes.map(recipe => [recipe.name, shas['v0.2.49']])),
    changes: { 'v0.2.49': ['shared/build.rs', 'kiosk/src/App.tsx'], 'v0.2.50': ['shared/build.rs', 'kiosk/src/App.tsx'] },
    issues: { 'v0.2.10': ['MET-310'], 'v0.2.11': ['MET-311'], 'v0.2.49': ['MET-349'], 'v0.2.50': ['MET-350'] }, failComment: 'MET-350' });
  return { ...host, tags };
}

test('authenticated verification failures stop forward preparation and manual preview/adoption without side effects', async t => {
  for (const mode of ['forward', 'preview', 'adopt']) {
    for (const message of ['gh: HTTP 401', 'gh: HTTP 403', 'digest mismatch']) {
      await t.test(`${mode}: ${message}`, async t => {
        const host = mode === 'forward'
          ? world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, ledger: baseline() })
          : manuallyRecovered();
        t.after(host.cleanup);
        const approval = mode === 'adopt' ? (await reconcileManual(host.effects, 'v0.2.49')).approval : undefined;
        const original = structuredClone(host.ledger());
        const live = { ...host.live };
        const run = host.effects.run;
        const failure = new Error(message);
        let verifications = 0;
        let directory = '';
        host.calls.length = 0;
        host.effects.run = (command, args, options) => {
          if (command !== 'python3') return run(command, args, options);
          assert.ok(!args.includes('--anonymous'), 'no anonymous fallback');
          verifications++;
          directory = args[args.indexOf('--directory') + 1];
          throw failure;
        };
        await assert.rejects(mode === 'forward' ? main(host.effects) : reconcileManual(host.effects, 'v0.2.49', approval), error => error === failure);
        assert.equal(verifications, 1);
        assert.ok(!existsSync(join(directory, '.verified')));
        assert.deepEqual(host.calls, [], 'no checkout, probes or installers after verifier failure');
        assert.deepEqual(host.ledger(), original);
        assert.deepEqual(host.live, live);
        assert.deepEqual(host.comments, []);
      });
    }
  }
});

test('manual v0.2.49 / failed v0.2.10 ledger: refuse v0.2.11, explicitly adopt without historical receipts, then deploy forward and resume delivery', async t => {
  const host = manuallyRecovered();
  t.after(host.cleanup);
  const original = host.ledger();
  // The old planner selected all three: reverse git diff still lists changed files.
  assert.deepEqual(JSON.parse(host.effects.probe(recipes[2].health)), {
    build: '704da8361162b180e372d1fb7c3b5b27cb1212b6297fb571413ad71546598e1a',
    git_sha: shas['v0.2.49'], git_dirty: false,
  });
  await assert.rejects(main(host.effects), /Refusing older or divergent release/);
  assert.deepEqual(sudoCalls(host.calls), []);
  assert.deepEqual(host.comments, []);
  assert.deepEqual(host.ledger(), original);
  const probe = host.effects.probe;
  for (const override of [{ status: 'degraded' }, { git_dirty: true }, { git_sha: 'f'.repeat(40) }]) {
    host.effects.probe = url => JSON.stringify({ ...JSON.parse(probe(url)), ...override });
    await assert.rejects(main(host.effects), /older or divergent|Unverifiable|unknown revision/);
    assert.deepEqual(sudoCalls(host.calls), []);
    assert.deepEqual(host.ledger(), original, 'unhealthy or unverifiable identity cannot hide a newer install');
  }
  host.effects.probe = probe;
  const preview = await reconcileManual(host.effects, 'v0.2.49');
  assert.equal(preview.sha, '6c157fe65cb9e4c4e07d55548b4cd3f6f2253240');
  assert.deepEqual(preview.priorLedger, original);
  assert.deepEqual(preview.releases.map(({ tag, disposition, issues, requirements }) => ({ tag, disposition, issues, requirements })), [
    { tag: 'v0.2.10', disposition: 'prior-attempt', issues: ['MET-310'], requirements: 'unverified' },
    { tag: 'v0.2.11', disposition: 'not-replayed', issues: ['MET-311'], requirements: 'unverified' },
    { tag: 'v0.2.49', disposition: 'manual-install', issues: ['MET-349'], requirements: 'unverified' },
  ]);
  assert.deepEqual(host.ledger(), original, 'preview writes no deployment state');
  await assert.rejects(reconcileManual(host.effects, 'v0.2.49', '0'.repeat(64)), /plan changed/);
  assert.deepEqual(host.ledger(), original);
  await reconcileManual(host.effects, 'v0.2.49', preview.approval);
  assert.deepEqual(host.ledger(), { ...original, manualBaseline: preview });
  // An acknowledgement lost after the atomic write does not adopt twice or replay old tags.
  await reconcileManual(host.effects, 'v0.2.49', preview.approval);
  await main(host.effects);
  assert.deepEqual(host.ledger(), { ...original, manualBaseline: preview });
  assert.deepEqual(sudoCalls(host.calls), []);
  assert.deepEqual(host.comments, [], 'ancestry never fabricates a historical pass or completes an issue');

  host.tags.push('v0.2.50');
  await assert.rejects(main(host.effects), /Linear 503/);
  assert.equal(host.ledger().lastTag, 'v0.2.10', 'only actual forward receipt delivery may move lastTag');
  assert.equal(host.ledger().receipt?.tag, 'v0.2.50');
  assert.equal(sudoCalls(host.calls).length, 3);
  await main(host.effects);
  assert.equal(sudoCalls(host.calls).length, 3, 'receipt retry does not reinstall');
  assert.deepEqual(host.live, Object.fromEntries(recipes.map(recipe => [recipe.name, shas['v0.2.50']])));
  assert.equal(host.ledger().lastTag, 'v0.2.50');
  assert.equal(host.ledger().receipt, undefined);
  assert.deepEqual(host.ledger().manualBaseline?.priorLedger, original, 'original failed attempt survives later component replacement');
  assert.deepEqual(host.comments, [['MET-350', line(`component=meter+factory-api+kiosk sha=${shas['v0.2.50']} health=pass rollback=none`)]]);
});

test('manual reconciliation fails closed on mixed, dirty, stale or unverifiable evidence without state/receipt writes', async t => {
  const alterations: [string, (host: ReturnType<typeof manuallyRecovered>) => void][] = [
    ['mixed', host => { host.live.kiosk = shas['v0.2.11']; }],
    ...[undefined, '0'.repeat(64)].map(build => ['kiosk build fingerprint', (host: ReturnType<typeof manuallyRecovered>) => {
      const probe = host.effects.probe;
      host.effects.probe = url => url === recipes[2].health ? JSON.stringify({ ...JSON.parse(probe(url)), build }) : probe(url);
    }] as [string, (host: ReturnType<typeof manuallyRecovered>) => void]),
    ...Object.entries({ git_dirty: true, git_sha: shas['v0.2.49'].slice(0, 7), version: '0.2.48', built_at_ms: 1,
      inputs_fingerprint: '000000000000', meter_openapi_sha256: '111111111111', status: 'degraded' }).map(([key, value]) =>
      [key, (host: ReturnType<typeof manuallyRecovered>) => {
        const probe = host.effects.probe;
        host.effects.probe = url => JSON.stringify({ ...JSON.parse(probe(url)), [key]: value });
      }] as [string, (host: ReturnType<typeof manuallyRecovered>) => void]),
    ['missing dirty flag', host => {
      const probe = host.effects.probe;
      host.effects.probe = url => { const body = JSON.parse(probe(url)); delete body.git_dirty; return JSON.stringify(body); };
    }],
    ['unreachable', host => { host.effects.probe = () => { throw new Error('unreachable'); }; }],
    ['unstable third window', host => {
      const probe = host.effects.probe;
      let count = 0;
      host.effects.probe = url => ++count >= 7 ? JSON.stringify({ ...JSON.parse(probe(url)), git_dirty: true }) : probe(url);
    }],
    ['invalid bundle', host => {
      const run = host.effects.run;
      host.effects.run = (command, args, options) => { if (command === 'python3') throw new Error('digest mismatch'); return run(command, args, options); };
    }],
    ['dirty tools', host => {
      const run = host.effects.run;
      host.effects.run = (command, args, options) => command === 'git' && args.includes('status') ? { stdout: ' M operator-edit', stderr: '' } : run(command, args, options);
    }],
    ['divergent ancestry', host => { host.effects.ok = () => false; }],
    ['missing PR', host => {
      const run = host.effects.run;
      host.effects.run = (command, args, options) => { if (command === 'gh' && args[0] === 'pr') throw new Error('Could not resolve to a PullRequest'); return run(command, args, options); };
    }],
    ['pending receipt', host => host.effects.writeLedger({ ...host.ledger(), receipt: { tag: 'v0.2.11', receipt: { component: 'meter', sha: shas['v0.2.11'], health: 'fail', rollback: 'none' }, delivered: [] } })],
    ['in-flight install', host => host.effects.writeLedger({ ...host.ledger(), inFlight: { tag: 'v0.2.11', sha: shas['v0.2.11'], component: 'meter', phase: 'installing' } })],
    ['inconsistent ledger identity', host => host.effects.writeLedger({ ...host.ledger(), components: { meter: { tag: 'v0.2.10', sha: shas['v0.2.11'], health: 'fail' } } })],
  ];
  for (const [name, alter] of alterations) {
    const host = manuallyRecovered();
    t.after(host.cleanup);
    alter(host);
    const original = host.ledger();
    await assert.rejects(reconcileManual(host.effects, 'v0.2.49'), undefined, name);
    assert.deepEqual(host.ledger(), original, name);
    assert.deepEqual(sudoCalls(host.calls), [], name);
    assert.deepEqual(host.comments, [], name);
  }
});

test('reconciliation approval binds issue inventory; adopted baseline drift and divergent planning cannot downgrade', async t => {
  const host = manuallyRecovered();
  t.after(host.cleanup);
  const preview = await reconcileManual(host.effects, 'v0.2.49');
  const run = host.effects.run;
  host.effects.run = (command, args, options) => command === 'gh' && args[0] === 'pr'
    ? { stdout: JSON.stringify({ body: 'closes MET-999' }), stderr: '' } : run(command, args, options);
  await assert.rejects(reconcileManual(host.effects, 'v0.2.49', preview.approval), /plan changed/);
  assert.equal(host.ledger().manualBaseline, undefined);
  host.effects.run = run;
  await reconcileManual(host.effects, 'v0.2.49', preview.approval);
  host.tags.push('v0.2.50');
  host.live.kiosk = shas['v0.2.11'];
  await assert.rejects(main(host.effects), /Manual baseline drift/);
  assert.deepEqual(sudoCalls(host.calls), []);
  assert.deepEqual(host.comments, []);
  assert.throws(() => plan({ sha: shas['v0.2.11'], baselines: { meter: shas['v0.2.49'] }, ledger: emptyLedger(), sources,
    changedSince: () => [], isAncestor: () => false }), /older or divergent/, 'even a docs-only target cannot fabricate a historical pass');
});

test('adoption retains rollback recovery for an interrupted forward attempt with an unreachable component', async t => {
  const host = manuallyRecovered();
  t.after(host.cleanup);
  const preview = await reconcileManual(host.effects, 'v0.2.49');
  await reconcileManual(host.effects, 'v0.2.49', preview.approval);
  host.tags.push('v0.2.50');
  const snapshot = '/var/backups/meter/forward-snapshot';
  host.effects.writeLedger({ ...host.ledger(), inFlight: { tag: 'v0.2.50', sha: shas['v0.2.50'], component: 'meter', phase: 'probing', snapshot } });
  const probe = host.effects.probe;
  let unreachable = true;
  host.effects.probe = url => {
    if (unreachable && url === recipes[0].health) throw new Error('connection refused');
    return probe(url);
  };
  const sudo = host.effects.sudo;
  host.effects.sudo = (script, args) => {
    if (args[2] === '--plan') return sudo(script, args);
    assert.equal(script, 'deploy/rollback-meter-v1.sh');
    assert.deepEqual(args, [snapshot]);
    host.calls.push('rollback');
    unreachable = false;
    return { ok: true, output: '' };
  };
  await assert.rejects(main(host.effects), /Linear 503/);
  assert.equal(host.ledger().receipt?.receipt.rollback, snapshot);
  await assert.rejects(main(host.effects), /health=fail/);
  assert.equal(host.calls.filter(call => call === 'rollback').length, 1);
  assert.equal(host.ledger().lastTag, 'v0.2.50');
  assert.equal(host.ledger().inFlight, undefined);
  assert.deepEqual(host.ledger().manualBaseline, preview);
  assert.deepEqual(host.live, Object.fromEntries(recipes.map(recipe => [recipe.name, shas['v0.2.49']])));
  assert.deepEqual(host.comments, [['MET-350', line(`component=meter sha=${shas['v0.2.50']} health=fail rollback=${snapshot}`)]]);
});

test('recorded API recovery restores its dependent kiosk endpoint before any further install or success receipt', async t => {
  for (const phase of ['installing', 'probing'] as const) {
    for (const kioskAfter of ['healthy', 'unreachable', 'older', 'newer'] as const) {
      const host = manuallyRecovered();
      t.after(host.cleanup);
      const preview = await reconcileManual(host.effects, 'v0.2.49');
      await reconcileManual(host.effects, 'v0.2.49', preview.approval);
      host.tags.push('v0.2.50');
      host.live.meter = shas['v0.2.50'];
      const snapshot = '/var/backups/factory-api/interrupted';
      host.effects.writeLedger({ ...host.ledger(), components: { meter: { tag: 'v0.2.50', sha: shas['v0.2.50'], health: 'pass' } },
        inFlight: { tag: 'v0.2.50', sha: shas['v0.2.50'], component: 'factory-api', phase, snapshot } });
      let recovered = false;
      let dependentChecks = 0;
      const probe = host.effects.probe;
      host.effects.probe = url => {
        if (!recovered && url.includes(':8080/')) throw new Error('connection refused');
        if (recovered && url === recipes[2].health) {
          dependentChecks++;
          if (kioskAfter === 'unreachable') throw new Error('still unavailable');
        }
        return probe(url);
      };
      const sudo = host.effects.sudo;
      host.effects.sudo = (script, args) => {
        if (!recovered) {
          assert.equal(script, phase === 'probing' ? 'deploy/rollback-factory-api.sh' : 'deploy/install-factory-api.sh');
          recovered = true;
          if (kioskAfter === 'older') host.live.kiosk = shas['v0.2.11'];
          if (kioskAfter === 'newer') host.live.kiosk = shas['v0.3.0'];
          if (phase === 'probing') {
            assert.deepEqual(args, [snapshot]);
            host.calls.push(`sudo ${script} ${snapshot}`);
            return { ok: true, output: '' };
          }
        } else assert.ok(dependentChecks > 0, 'recheck kiosk before installing it');
        return sudo(script, args);
      };
      host.effects.linear.comment = async (issue, body) => { host.comments.push([issue, body]); };
      if (kioskAfter !== 'healthy') {
        await assert.rejects(main(host.effects), /baseline drift|older or divergent/);
        assert.equal(sudoCalls(host.calls).length, 1, `${phase}/${kioskAfter}: only API recovery may run`);
        assert.deepEqual(host.comments, []);
        assert.equal(host.ledger().lastTag, 'v0.2.10');
      } else if (phase === 'probing') {
        await assert.rejects(main(host.effects), /health=fail/);
        assert.equal(sudoCalls(host.calls).length, 1);
        assert.equal(host.live['factory-api'], shas['v0.2.49']);
        assert.deepEqual(host.comments, [['MET-350', line(`component=factory-api sha=${shas['v0.2.50']} health=fail rollback=${snapshot}`)]]);
      } else {
        await main(host.effects);
        assert.equal(sudoCalls(host.calls).length, 2, 'API reinstall and kiosk install, no meter replay');
        assert.equal(host.live.kiosk, shas['v0.2.50']);
        assert.deepEqual(host.comments, [['MET-350', line(`component=meter+factory-api+kiosk sha=${shas['v0.2.50']} health=pass rollback=none`)]]);
      }
      assert.ok(dependentChecks > 0, 'both recovery outcomes recheck dependent health');
      assert.deepEqual(host.ledger().manualBaseline, preview);
    }
  }
});

test('an initially healthy kiosk must remain healthy after recorded API recovery before a success receipt', async t => {
  const tags: Tag[] = ['v0.2.10', 'v0.2.49'];
  const host = world({ tags, ledger: { lastTag: 'v0.2.10', components: {} },
    live: Object.fromEntries(recipes.map(recipe => [recipe.name, shas['v0.2.49']])),
    changes: { 'v0.2.50': ['factory-api/src/main.rs'] }, issues: { 'v0.2.50': ['MET-350'] } });
  t.after(host.cleanup);
  const preview = await reconcileManual(host.effects, 'v0.2.49');
  await reconcileManual(host.effects, 'v0.2.49', preview.approval);
  tags.push('v0.2.50');
  host.effects.writeLedger({ ...host.ledger(), inFlight: {
    tag: 'v0.2.50', sha: shas['v0.2.50'], component: 'factory-api', phase: 'installing',
  } });
  let recovered = false;
  let kioskUnavailable = true;
  let dependentChecks = 0;
  const probe = host.effects.probe;
  host.effects.probe = url => {
    if (!recovered && url === recipes[1].health) throw new Error('API unavailable');
    if (recovered && url === recipes[2].health) {
      dependentChecks++;
      if (kioskUnavailable) throw new Error('kiosk unavailable after API reinstall');
    }
    return probe(url);
  };
  const sudo = host.effects.sudo;
  host.effects.sudo = (script, args) => {
    assert.equal(script, 'deploy/install-factory-api.sh');
    recovered = true;
    return sudo(script, args);
  };
  await assert.rejects(main(host.effects), /Manual baseline drift for kiosk/);
  assert.ok(dependentChecks > 0);
  assert.equal(host.ledger().lastTag, 'v0.2.10');
  assert.equal(host.ledger().receipt, undefined);
  assert.deepEqual(host.comments, []);
  kioskUnavailable = false;
  await main(host.effects);
  assert.equal(sudoCalls(host.calls).length, 1, 'healthy retry delivers without reinstalling API');
  assert.equal(host.ledger().lastTag, 'v0.2.50');
  assert.deepEqual(host.ledger().manualBaseline, preview);
  assert.deepEqual(host.comments, [['MET-350', line(`component=factory-api sha=${shas['v0.2.50']} health=pass rollback=none`)]]);
});

test('API recovery does not excuse a usable unsafe kiosk identity or an unrelated outage', async t => {
  for (const control of ['dirty', 'newer', 'degraded', 'unrecorded', 'meter-outage']) {
    const host = manuallyRecovered();
    t.after(host.cleanup);
    const preview = await reconcileManual(host.effects, 'v0.2.49');
    await reconcileManual(host.effects, 'v0.2.49', preview.approval);
    host.tags.push('v0.2.50');
    if (control !== 'unrecorded') host.effects.writeLedger({ ...host.ledger(), inFlight: {
      tag: 'v0.2.50', sha: shas['v0.2.50'], component: 'factory-api', phase: 'probing', snapshot: '/var/backups/factory-api/interrupted',
    } });
    const probe = host.effects.probe;
    host.effects.probe = url => {
      if (url === recipes[1].health || control === 'unrecorded' || control === 'meter-outage') throw new Error('connection refused');
      if (url === recipes[2].health) return JSON.stringify({ ...JSON.parse(probe(url)),
        ...(control === 'dirty' ? { git_dirty: true } : control === 'newer' ? { git_sha: shas['v0.3.0'] } : { status: 'degraded' }) });
      return probe(url);
    };
    const before = host.ledger();
    await assert.rejects(main(host.effects), /Unverifiable|older or divergent|baseline drift/);
    assert.deepEqual(host.ledger(), before);
    assert.deepEqual(sudoCalls(host.calls), []);
    assert.deepEqual(host.comments, []);
  }
});

test('install-only persistently disables an enabled-but-stopped timer; normal install and removal preserve ledger', t => {
  const temp = mkdtempSync(join(tmpdir(), 'odd-units-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'home/agent/work/factory');
  const bin = join(temp, 'bin');
  const units = join(temp, 'etc/systemd/system');
  for (const path of [bin, units, join(temp, 'etc/factory-dispatch'), join(temp, 'home/agent/.local/state/factory-odd'), join(root, 'deploy'), join(root, 'scripts/odd'), join(root, 'scripts/release')]) mkdirSync(path, { recursive: true });
  const paths = ['scripts/odd/deploy.ts', 'scripts/odd/lifecycle.ts', 'scripts/release/release.py', 'deploy/components.json',
    'deploy/factory-deploy.service', 'deploy/factory-deploy.timer', 'deploy/install-deploy.sh', 'deploy/rollback-deploy.sh',
    ...recipes.flatMap(recipe => [recipe.installer, recipe.rollback]), 'deploy/install-usage.sh', 'deploy/rollback-usage.sh'];
  for (const path of paths) {
    // Existing installer-test convention: relocate fixed paths and simulate root, never run sudo.
    const text = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
      .replaceAll('[[ $EUID -eq 0 ]]', 'true').replaceAll('/home/agent', `${temp}/home/agent`)
      .replaceAll('/etc/', `${temp}/etc/`).replaceAll('/var/backups', `${temp}/var/backups`);
    writeFileSync(join(root, path), text);
  }
  writeFileSync(join(temp, 'etc/factory-dispatch/linear-api-key'), 'synthetic key');
  const ledgerPath = join(temp, 'home/agent/.local/state/factory-odd/deploy.json');
  const ledger = JSON.stringify({ lastTag: 'v0.2.10', components: { meter: { health: 'fail' } } });
  writeFileSync(ledgerPath, ledger);
  writeFileSync(join(units, 'factory-deploy.timer'), 'old timer');
  writeFileSync(join(units, 'factory-deploy.service'), 'old service');
  writeFileSync(join(temp, 'enabled'), 'enabled\n');
  writeFileSync(join(temp, 'active'), 'inactive\n');
  const shims = {
    hostname: 'echo factory-gpu',
    getent: `echo 'agent:x:1000:1000::${temp}/home/agent:/bin/bash'`,
    node: 'echo v24.22.1',
    gh: '[[ $* == "auth status" ]]',
    git: '[[ $* == *"fetch --quiet --tags origin" || $* == *"status --porcelain" ]]',
    sudo: `if [[ $* == '-n -l' ]]; then
  printf '%s\\n' ${paths.filter(path => /deploy\/(install|rollback)-/.test(path)).map(path => `' /usr/bin/bash ${root}/${path} *'`).join(' ')}
  exit 0
fi
while [[ $1 == -* ]]; do case $1 in -u|-iu) shift 2 ;; *) shift ;; esac; done
exec "$@"`,
    install: 'args=(); while (($#)); do case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; exec /usr/bin/install "${args[@]}"',
    systemctl: `state='${temp}'
case "$1" in
  show) case "$*" in
    *DropInPaths*) ;;
    *LoadState*) echo loaded ;;
    *UnitFileState*) cat "$state/enabled" ;;
    *ActiveState*) if [[ $2 == factory-deploy.timer ]]; then cat "$state/active"; else echo "\${SERVICE_ACTIVE:-inactive}"; fi ;;
    *) exit 98 ;;
  esac ;;
  is-enabled) [[ $* == *--quiet* ]] || cat "$state/enabled"; [[ $(cat "$state/enabled") == enabled ]] ;;
  is-active) [[ $(cat "$state/active") == active ]] ;;
  stop) echo inactive > "$state/active" ;;
  disable) [[ -n \${BROKEN_DISABLE:-} ]] || echo disabled > "$state/enabled"; echo "\${DISABLE_ACTIVE:-inactive}" > "$state/active" ;;
  enable) echo enabled > "$state/enabled"; echo active > "$state/active" ;;
  start) touch "$state/service-started" ;;
  daemon-reload) ;;
  *) exit 99 ;;
esac`,
  };
  for (const [name, body] of Object.entries(shims)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  }
  const run = (script: string, args: string[] = [], env = {}) => spawnSync('bash', [join(root, 'deploy', script), ...args],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ...env } });
  const installed = run('install-deploy.sh', ['--install-only']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const snapshot = /^Snapshot: (.+)$/m.exec(installed.stdout)![1];
  assert.equal(readFileSync(join(snapshot, 'factory-deploy.timer.enabled'), 'utf8'), 'enabled\n');
  assert.equal(readFileSync(join(snapshot, 'factory-deploy.timer'), 'utf8'), 'old timer');
  assert.equal(readFileSync(join(temp, 'enabled'), 'utf8'), 'disabled\n');
  assert.equal(readFileSync(join(temp, 'active'), 'utf8'), 'inactive\n');
  assert.equal(existsSync(join(temp, 'service-started')), false);
  assert.equal(readFileSync(ledgerPath, 'utf8'), ledger);
  const normal = run('install-deploy.sh');
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.equal(existsSync(join(temp, 'service-started')), true);
  assert.equal(readFileSync(join(temp, 'enabled'), 'utf8'), 'enabled\n');
  assert.equal(readFileSync(join(temp, 'active'), 'utf8'), 'active\n');
  rmSync(join(temp, 'service-started'));
  const refused = run('install-deploy.sh', ['--install-only'], { BROKEN_DISABLE: '1' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not persistently disabled/);
  const stillActive = run('install-deploy.sh', ['--install-only'], { DISABLE_ACTIVE: 'active' });
  assert.notEqual(stillActive.status, 0);
  assert.match(stillActive.stderr, /not inactive/);
  writeFileSync(join(units, 'factory-deploy.timer'), 'do not replace while deploy is running');
  const busy = run('install-deploy.sh', ['--install-only'], { SERVICE_ACTIVE: 'activating' });
  assert.notEqual(busy.status, 0);
  assert.match(busy.stderr, /Wait for the running deploy service/);
  assert.equal(readFileSync(join(units, 'factory-deploy.timer'), 'utf8'), 'do not replace while deploy is running');
  assert.equal(existsSync(join(temp, 'service-started')), false);
  const removed = run('rollback-deploy.sh');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(existsSync(join(units, 'factory-deploy.timer')), false);
  assert.equal(existsSync(join(units, 'factory-deploy.service')), false);
  assert.equal(readFileSync(join(temp, 'enabled'), 'utf8'), 'disabled\n');
  assert.equal(readFileSync(join(temp, 'active'), 'utf8'), 'inactive\n');
  assert.equal(readFileSync(ledgerPath, 'utf8'), ledger);
});

test('real Git: releases predating the deployer cannot remove its runtime or tools, including the tick after a failed install', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'odd-history-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runtime = join(temp, 'factory');
  const stateDir = join(temp, 'state');
  mkdirSync(join(runtime, 'deploy'), { recursive: true });
  mkdirSync(stateDir);
  const run: Effects['run'] = (command, args, options) => {
    const result = spawnSync(command, args, { cwd: options?.cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
  };
  const git = (...args: string[]) => run('git', ['-C', runtime, ...args]).stdout.trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const commit = (message: string) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  writeFileSync(join(runtime, 'deploy/components.json'), JSON.stringify({ components: Object.entries(sources).map(([id, paths]) => ({ id, sources: paths })) }));
  writeFileSync(join(runtime, 'deploy/install-meter.sh'), '# obsolete installer\nexit 99\n');
  commit('baseline');
  git('tag', 'v0.2.9');
  writeFileSync(join(runtime, 'release.txt'), 'first historical release');
  const first = commit('first (#310)');
  git('tag', 'v0.2.10');
  writeFileSync(join(runtime, 'release.txt'), 'next historical release');
  const second = commit('second (#311)');
  git('tag', 'v0.2.11');
  mkdirSync(join(runtime, 'scripts/odd'), { recursive: true });
  mkdirSync(join(runtime, 'scripts/release'), { recursive: true });
  const tools = ['scripts/odd/deploy.ts', 'scripts/release/release.py', ...recipes.flatMap(recipe => [recipe.installer, recipe.rollback])];
  for (const path of tools) writeFileSync(join(runtime, path), readFileSync(new URL(`../../${path}`, import.meta.url)));
  const toolsSha = commit('deployment machinery');
  git('update-ref', 'refs/remotes/origin/main', toolsSha);
  let ledger = baseline();
  let failInstall = true;
  const live = new Map<string, string>();
  const verified: string[] = [];
  const comments: [string, string][] = [];
  const effects: Effects = {
    stateDir, log: () => {}, sleep: async () => {},
    run: (command, args, options) => {
      if (command === 'git') {
        if (args[2] === 'fetch') return { stdout: '', stderr: '' }; // No network in this fixture.
        return run(command, args.map(arg => arg === ROOT ? runtime : arg), options);
      }
      if (command === 'gh') return { stdout: JSON.stringify(args[0] === 'api' ? [
        [{ tag_name: 'v0.2.11', draft: false, prerelease: false },
          ...Array.from({ length: 99 }, (_, i) => ({ tag_name: `v9.0.${i}`, draft: i % 2 === 0, prerelease: i % 2 !== 0 }))],
        ...(args.includes('--paginate') ? [['v0.2.10', 'v0.2.9'].map(tag_name => ({ tag_name, draft: false, prerelease: false }))] : []),
      ] : { body: `closes MET-${args[2]}` }), stderr: '' };
      if (command === 'python3') {
        assert.equal(readFileSync(args[0].replace(ROOT, runtime), 'utf8'), readFileSync(new URL('../release/release.py', import.meta.url), 'utf8'));
        verified.push(args[args.indexOf('--tag') + 1]);
        const dir = args.at(-1)!;
        mkdirSync(dir);
        for (const asset of ['meter-linux-x86_64', 'factory-api-linux-x86_64']) writeFileSync(join(dir, asset), 'fixture');
        return { stdout: '', stderr: '' };
      }
      assert.equal(command, 'tar');
      return { stdout: '', stderr: '' };
    },
    ok: (command, args) => spawnSync(command, args.map(arg => arg === ROOT ? runtime : arg)).status === 0,
    sudo: (script, args) => {
      assert.equal(readFileSync(join(runtime, script), 'utf8'), readFileSync(new URL(`../../${script}`, import.meta.url), 'utf8'));
      assert.equal(args[0], '--source-checkout');
      assert.equal(args[1], join(stateDir, 'source'));
      assert.equal(existsSync(join(args[1], 'scripts/odd/deploy.ts')), false);
      const target = run('git', ['-C', args[1], 'rev-parse', 'HEAD']).stdout.trim();
      if (args[2] === '--plan') return { ok: true, output: `${v2Plan}\n` };
      if (failInstall) { failInstall = false; return { ok: false, output: 'No deployment changes made; no rollback snapshot exists.' }; }
      live.set(recipes.find(recipe => recipe.installer === script)!.health, target);
      return { ok: true, output: 'Rollback snapshot: /var/backups/fixture/snap\n' };
    },
    probe: url => {
      if (!live.has(url)) throw new Error('service unavailable');
      return JSON.stringify({ git_sha: live.get(url), git_dirty: false, status: 'ok' });
    },
    readLedger: () => structuredClone(ledger), writeLedger: next => { ledger = structuredClone(next); },
    linear: { deploying: async () => true, posted: async (id, body) => comments.some(([i, b]) => i === id && b === body), comment: async (id, body) => { comments.push([id, body]); } },
  };
  const entry = pathToFileURL(join(runtime, 'scripts/odd/deploy.ts')).href;
  // A symlink or Git-file alias must fail before it can change HEAD, install, or handle the tag.
  const source = join(stateDir, 'source');
  for (const alias of ['symlink', 'gitfile']) {
    if (alias === 'symlink') symlinkSync(runtime, source);
    else { mkdirSync(source); writeFileSync(join(source, '.git'), `gitdir: ${runtime}/.git\n`); }
    await assert.rejects((await import(entry)).main(effects), /source checkout aliases the deployer runtime/);
    assert.deepEqual(ledger, baseline());
    assert.equal(git('rev-parse', 'HEAD'), toolsSha);
    assert.deepEqual(comments, []);
    assert.equal(live.size, 0);
    rmSync(source, { recursive: true });
  }
  await assert.rejects((await import(entry)).main(effects), /health=fail/);
  assert.equal(ledger.lastTag, 'v0.2.10');
  assert.equal(ledger.components.meter.health, 'fail');
  assert.equal(live.size, 0, 'failed preflight did not replace any running component');
  assert.equal(git('rev-parse', 'HEAD'), toolsSha);
  assert.equal(git('status', '--porcelain'), '');
  // A fresh Node process must still load the timer entry point after the failed tick.
  run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(entry)})`]);
  await (await import(`${entry}?next-tick`)).main(effects);
  assert.equal(ledger.lastTag, 'v0.2.11');
  assert.deepEqual([...live.values()], [second, second, second]);
  assert.deepEqual(verified, ['v0.2.10', 'v0.2.11']);
  assert.deepEqual(comments, [
    ['MET-310', line(`component=meter sha=${first} health=fail rollback=none`)],
    ['MET-311', line(`component=meter+factory-api+kiosk sha=${second} health=pass rollback=none`)],
  ]);
  assert.equal(git('rev-parse', 'HEAD'), toolsSha);
  assert.equal(git('status', '--porcelain'), '');
  // Neither checkout may silently discard operator edits, even before a docs-only retry.
  for (const checkout of [runtime, join(stateDir, 'source')]) {
    writeFileSync(join(checkout, 'operator-note'), 'preserve me');
    ledger.lastTag = 'v0.2.10';
    await assert.rejects(main(effects), /is dirty/);
    assert.equal(readFileSync(join(checkout, 'operator-note'), 'utf8'), 'preserve me');
    rmSync(join(checkout, 'operator-note'));
  }
});

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

// MET-364: automatic deploys never change the meter DB generation.
const plans = {
  fresh: { ok: true, output: 'meter-plan mode=fresh user_version=none db_changing=yes\n' },
  legacy: { ok: true, output: 'meter-plan mode=legacy user_version=0 db_changing=yes\n' },
  v1: { ok: true, output: 'meter-plan mode=v1 user_version=1 db_changing=yes\n' },
  unknown: { ok: true, output: 'meter-plan mode=unknown user_version=3 db_changing=yes\n' },
  'failed plan': { ok: false, output: `${v2Plan}\nERROR: interrupted\n` },
  'no plan line': { ok: true, output: 'Artifact meter built at 1111111 matches checkout\n' },
  'two plan lines': { ok: true, output: `${v2Plan}\n${v2Plan}\n` },
  'changing v2': { ok: true, output: 'meter-plan mode=v2 user_version=2 db_changing=yes\n' },
};
const refusalOf = (mode: keyof typeof plans) => mode === 'fresh' || mode === 'legacy' || mode === 'v1' ? `db-changing-${mode}` : 'db-changing-unknown';
const meterRelease = { tags: ['v0.2.9', 'v0.3.0', 'v0.3.1'] as Tag[], changes: { 'v0.3.0': ['shared/build.rs', 'kiosk/src/App.tsx'], 'v0.3.1': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-364'], 'v0.3.1': ['MET-365'] } };

test('sandbox: a fresh, legacy, v1 or unknown meter plan refuses the whole release before any installer; the refusal is durable and pages irreversible-action', async t => {
  for (const mode of Object.keys(plans) as (keyof typeof plans)[]) {
    await t.test(mode, async t => {
      const host = world({ ...meterRelease, ledger: baseline(), meterPlan: plans[mode] });
      t.after(host.cleanup);
      await assert.rejects(main(host.effects), /health=refused/);
      assert.deepEqual(sudoCalls(host.calls), [], 'no install, migration or rollback for any component');
      assert.deepEqual(host.calls.filter(call => call.startsWith('plan')), ['plan meter']);
      const refused = line(`component=meter sha=${shas['v0.3.0']} health=refused rollback=none refusal=${refusalOf(mode)}`);
      assert.deepEqual(host.comments, [['MET-364', refused]]);
      assert.equal(host.ledger().lastTag, 'v0.2.9', 'lastTag never moves past an unhandled refusal');
      assert.deepEqual(host.ledger().components, {});
      assert.deepEqual(host.ledger().receipt, { tag: 'v0.3.0', receipt: { component: 'meter', sha: shas['v0.3.0'], health: 'refused', rollback: 'none', refusal: refusalOf(mode) }, delivered: ['MET-364'] });
      // Durable: later ticks redeliver nothing, re-plan nothing and never reach the next release.
      await assert.rejects(main(host.effects), /health=refused/);
      assert.deepEqual(sudoCalls(host.calls), []);
      assert.deepEqual(host.calls.filter(call => call.startsWith('plan')), ['plan meter']);
      assert.deepEqual(host.comments, [['MET-364', refused]]);
      assert.equal(host.ledger().lastTag, 'v0.2.9');
      assert.deepEqual(host.live, { meter: shas['v0.2.9'], 'factory-api': shas['v0.2.9'], kiosk: shas['v0.2.9'] });
      const action = deploying(refused) as Extract<Action, { kind: 'page' }>;
      assert.equal(action.kind, 'page');
      assert.equal(action.reason, 'irreversible-action');
      assert.equal(action.diagnose, undefined, 'no log reader');
    });
  }
});

test('sandbox: the plan guards an interrupted meter resume too: a refused plan runs neither its rollback nor a reinstall', async t => {
  const inFlight = { tag: 'v0.3.0', sha: shas['v0.3.0'], component: 'meter', phase: 'probing' as const, snapshot: '/var/backups/meter/snap' };
  const host = world({ ...meterRelease, tags: ['v0.2.9', 'v0.3.0'], ledger: baseline({ inFlight }), meterPlan: plans.legacy });
  t.after(host.cleanup);
  await assert.rejects(main(host.effects), /health=refused rollback=none refusal=db-changing-legacy/);
  assert.deepEqual(sudoCalls(host.calls), []);
  assert.deepEqual(host.ledger().inFlight, inFlight, 'resume state is kept for Devon');
  assert.equal(host.ledger().lastTag, 'v0.2.9');
});

test('sandbox: the installer rechecks after an eligible plan; a generation change in between is a refusal, not a failed rollback', async t => {
  const host = world({ ...meterRelease, tags: ['v0.2.9', 'v0.3.0'], ledger: baseline() });
  t.after(host.cleanup);
  const sudo = host.effects.sudo;
  host.effects.sudo = (script, args) => {
    if (!args.includes('--no-db-change')) return sudo(script, args);
    host.calls.push(`sudo ${script} ${args.slice(2).join(' ')}`);
    return { ok: false, output: `Artifact meter built at 1111111 matches checkout\n${plans.v1.output}ERROR: Refusing automatic meter install: mode v1 changes the DB generation; migration is Devon's explicit manual operation.\nNo deployment changes made; no rollback snapshot exists.\n` };
  };
  await assert.rejects(main(host.effects), /health=refused/);
  const meter = `${host.stateDir}/releases/v0.3.0/meter-linux-x86_64`;
  assert.deepEqual(host.calls.filter(call => /^(plan|sudo)/.test(call)), ['plan meter', `sudo deploy/install-meter.sh --no-db-change ${meter}`]);
  const refused = line(`component=meter sha=${shas['v0.3.0']} health=refused rollback=none refusal=db-changing-v1`);
  assert.deepEqual(host.comments, [['MET-364', refused]]);
  assert.equal(host.ledger().lastTag, 'v0.2.9');
  assert.equal(host.ledger().components.meter, undefined);
  assert.equal((deploying(refused) as Extract<Action, { kind: 'page' }>).reason, 'irreversible-action');
  // Control: an installer failure without a refusal plan line is still an ordinary red receipt.
  const red = world({ ...meterRelease, tags: ['v0.2.9', 'v0.3.0'], ledger: baseline() });
  t.after(red.cleanup);
  const redSudo = red.effects.sudo;
  red.effects.sudo = (script, args) => args.includes('--no-db-change') ? { ok: false, output: `${v2Plan}\nERROR: Required command missing: zstd\nNo deployment changes made; no rollback snapshot exists.\n` } : redSudo(script, args);
  await assert.rejects(main(red.effects), /health=fail rollback=none/);
});

test('sandbox: an eligible v2 plan precedes every installer, meter installs with --no-db-change, and the pass receipt is unchanged', async t => {
  const host = world({ ...meterRelease, tags: ['v0.2.9', 'v0.3.0'], ledger: baseline() });
  t.after(host.cleanup);
  await main(host.effects);
  const dir = `${host.stateDir}/releases/v0.3.0`;
  assert.deepEqual(host.calls.filter(call => /^(plan|sudo)/.test(call)), ['plan meter', `sudo deploy/install-meter.sh --no-db-change ${dir}/meter-linux-x86_64`,
    `sudo deploy/install-factory-api.sh ${dir}/factory-api-linux-x86_64`, `sudo deploy/install-kiosk.sh ${dir}/kiosk`]);
  assert.deepEqual(host.comments, [['MET-364', line(`component=meter+factory-api+kiosk sha=${shas['v0.3.0']} health=pass rollback=none`)]]);
  assert.equal(host.ledger().lastTag, 'v0.3.0');
});

test('control plane: a refused receipt pages irreversible-action with default not executed, files no Bug and starts no log reader', async () => {
  const refused = line(`component=meter sha=${shas['v0.3.0']} health=refused rollback=none refusal=db-changing-legacy`);
  const issue = { identifier: 'MET-364', status: 'Deploying' as const, labels: ['odd'], description: '', openBlockers: [], deployReceipt: parseDeployReceipt(refused) };
  const action = nextAction(issue, idle) as Extract<Action, { kind: 'page' }>;
  const { ctx, tools } = pluginContext();
  const spawned = flakySpawn(false);
  await page(ctx, issue, action, spawned.spawn);
  const slack = tools.find(([tool]) => tool === 'slack_write')?.[1] as { text: string };
  assert.match(slack.text, /ODD page: irreversible-action \| issue MET-364 \| - \| 1{40} \| default if silent: not executed\./);
  assert.ok(slack.text.includes(refused), slack.text);
  assert.deepEqual(spawned.spawned, []);
  assert.equal(tools.filter(([tool, input]) => tool === 'linear.save_issue' && (input.title || input.state)).length, 0, 'no Bug, no status change');
  assert.deepEqual(tools.at(-1), ['linear.save_issue', { id: 'MET-364', addLabels: ['escalated'] }]);
  assert.deepEqual(nextAction({ ...issue, labels: ['odd', 'escalated'] }, idle), { kind: 'wait', reason: 'escalated to Devon' });
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
  assert.deepEqual(sudoCalls(earlier.calls), [`sudo deploy/install-meter.sh --no-db-change ${earlier.stateDir}/releases/v0.3.0/meter-linux-x86_64`]);
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
