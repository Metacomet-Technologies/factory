import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHECK_TIMEOUT_MS, ROOT, toolChecks, bootstrap, deployComponent, emptyLedger, issuesFromSubjects, liveEffects, main, parseSnapshot, pendingTags, plan, probeResult, promoteTools, receiptLine, recipes, reconcileManual, restoredResult, resume, type Effects, type Ledger } from './deploy.ts';
import { nextAction, parseDeployReceipt, type Action } from './lifecycle.ts';
import { toSnapshot } from './snapshot.ts';
import plugin, { diagnose, page, setStatus } from '../../.amp/plugins/factory-odd.ts';
import { fakeShell } from './fixtures.ts';

// No fixture signs with the host's injected webhook secrets: the plugin prefers the project
// environment over the dialog, so both names are removed and only the synthetic secret signs.
for (const name of ['ODD_GITHUB_WEBHOOK_SECRET', 'ODD_LINEAR_WEBHOOK_SECRET']) delete process.env[name];

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
  const { effects, calls, ledger } = fixture({ bodies: [previous, green, green, green] });
  const receipt = await deployComponent(effects, kiosk, 'v0.3.0', sha, '/tmp/rel');
  assert.deepEqual(receipt, { component: 'kiosk', sha, health: 'pass', rollback: 'none' });
  // The first probe captures the healthy identity before the install.
  assert.deepEqual(calls, ['probe', 'sudo deploy/install-kiosk.sh --source-checkout /nonexistent/source /tmp/rel/kiosk', 'probe', 'sleep', 'probe', 'sleep', 'probe']);
  assert.deepEqual(ledger(), { components: { kiosk: { sha, tag: 'v0.3.0', health: 'pass', snapshot } }, inFlight: undefined });
  assert.equal(receiptLine(receipt), `odd-deploy host=factory-gpu component=kiosk sha=${sha} health=pass rollback=none`);
});

test('an installer failure after its snapshot rolls back and re-probes; before any change it does not', async () => {
  const withSnapshot = fixture({ bodies: [previous, previous, previous, previous], installOk: false });
  assert.deepEqual(await deployComponent(withSnapshot.effects, kiosk, 'v0.3.0', sha, '/tmp/rel'), { component: 'kiosk', sha, health: 'fail', rollback: snapshot });
  assert.equal(withSnapshot.calls.filter(call => call.includes('rollback')).length, 1);
  const unchanged = fixture({ bodies: [], installOk: false });
  unchanged.effects.sudo = () => ({ ok: false, output: 'ERROR: preflight failed\nNo deployment changes made; no rollback snapshot exists.\n' });
  assert.deepEqual(await deployComponent(unchanged.effects, kiosk, 'v0.3.0', sha, '/tmp/rel'), { component: 'kiosk', sha, health: 'fail', rollback: 'none' });
  // Meter: a generation change by a writer that bypassed the backup lock is caught by the post-stop
  // recheck after the snapshot (deploy/install-meter.sh output; MeterPlanTest). The service is already
  // stopped, so it is not a not-executed refusal: the v2 snapshot is rolled back once, binaries only.
  const meter = recipes.find(recipe => recipe.name === 'meter')!;
  const stopped = fixture({ bodies: [previous, previous, previous, previous] });
  const sudo = stopped.effects.sudo;
  stopped.effects.sudo = (script, args) => script.startsWith('deploy/install-')
    ? (sudo(script, args), { ok: false, output: `Rollback snapshot: ${snapshot}\nERROR: DB version changed since preflight.\nRecover with: sudo bash deploy/rollback-meter-v1.sh ${snapshot}\n` })
    : sudo(script, args);
  assert.deepEqual(await deployComponent(stopped.effects, meter, 'v0.3.0', sha, '/tmp/rel'), { component: 'meter', sha, health: 'fail', rollback: snapshot });
  assert.deepEqual(stopped.calls.filter(call => call.startsWith('sudo')), [`sudo deploy/install-meter.sh --source-checkout /nonexistent/source --no-db-change ${meter.artifact('/tmp/rel')}`, `sudo deploy/rollback-meter-v1.sh ${snapshot}`]);
});

test('a pre-snapshot installer failure is rollback=unchanged only when three probes find the exact healthy identity captured before it; never a rollback', async t => {
  const body = (fields: object) => JSON.stringify({ git_sha: 'b'.repeat(40), git_dirty: false, status: 'ok', ...fields });
  const [dirty, degraded, other, short] = [body({ git_dirty: true }), body({ status: 'degraded' }), body({ git_sha: 'c'.repeat(40) }), body({ git_sha: 'bbbbbbb' })];
  const install = 'sudo deploy/install-kiosk.sh --source-checkout /nonexistent/source /tmp/rel/kiosk';
  const reprobe = ['probe', 'sleep', 'probe', 'sleep', 'probe'];
  // [case, health bodies in probe order (undefined: connection refused), rollback, calls]
  const cases: [string, (string | undefined)[], string, string[]][] = [
    ['exact previous identity before and three times after', [previous, previous, previous, previous], 'unchanged', ['probe', install, ...reprobe]],
    ['unavailable before the install', [undefined, previous, previous, previous], 'none', ['probe', install]],
    ['dirty before the install', [dirty, previous, previous, previous], 'none', ['probe', install]],
    ['degraded before the install', [degraded, previous, previous, previous], 'none', ['probe', install]],
    ['malformed before the install', ['<html>502</html>', previous, previous, previous], 'none', ['probe', install]],
    ['healthy on another release after', [previous, other, other, other], 'none', ['probe', install, 'probe']],
    ['healthy on the target release after', [previous, green, green, green], 'none', ['probe', install, 'probe']],
    ['an abbreviated identity after, not the exact one', [previous, short, short, short], 'none', ['probe', install, 'probe']],
    ['degraded on the third probe after', [previous, previous, previous, degraded], 'none', ['probe', install, ...reprobe]],
    ['unavailable on the second probe after', [previous, previous, undefined, previous], 'none', ['probe', install, 'probe', 'sleep', 'probe']],
  ];
  for (const [name, bodies, rollback, calls] of cases) {
    await t.test(name, async () => {
      const host = fixture({ bodies: [] });
      host.effects.probe = () => {
        host.calls.push('probe');
        const next = bodies.shift();
        if (next === undefined) throw new Error('curl: (7) Failed to connect');
        return next;
      };
      host.effects.sudo = (script, args) => {
        host.calls.push(`sudo ${script} ${args.join(' ')}`);
        return script.startsWith('deploy/install-') ? { ok: false, output: 'ERROR: preflight failed\nNo deployment changes made; no rollback snapshot exists.\n' } : { ok: true, output: '' };
      };
      const receipt = await deployComponent(host.effects, kiosk, 'v0.3.0', sha, '/tmp/rel');
      assert.deepEqual(receipt, { component: 'kiosk', sha, health: 'fail', rollback });
      assert.deepEqual(host.calls, calls, 'no rollback subprocess, and the re-probe stops at the first mismatch');
      assert.deepEqual(host.ledger().receipt, { tag: 'v0.3.0', receipt, delivered: [] });
      assert.deepEqual(host.ledger().components.kiosk, { sha, tag: 'v0.3.0', health: 'fail', snapshot: undefined });
      assert.equal(receiptLine(receipt), `odd-deploy host=factory-gpu component=kiosk sha=${sha} health=fail rollback=${rollback}`);
    });
  }
  // Crash recovery: a resumed install's prior state is unproven, so a healthy previous release afterwards is still `none`.
  await t.test('a resumed install that fails before its snapshot', async () => {
    const host = fixture({ bodies: [previous, previous, previous, previous], ledger: { components: {}, inFlight: { tag: 'v0.3.0', sha, component: 'kiosk', phase: 'installing' } } });
    host.effects.sudo = (script, args) => { host.calls.push(`sudo ${script} ${args.join(' ')}`); return { ok: false, output: 'No deployment changes made; no rollback snapshot exists.\n' }; };
    assert.deepEqual(await deployComponent(host.effects, kiosk, 'v0.3.0', sha, '/tmp/rel'), { component: 'kiosk', sha, health: 'fail', rollback: 'none' });
    assert.deepEqual(host.calls, ['probe', install], 'the red resume probe, then the reinstall; no identity capture, no re-probe, no rollback');
  });
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

test('plan: each release fingerprint input alone selects every enabled recipe; lookalikes, docs and healthy same-SHA records do not', () => {
  const sources = { meter: ['meter', 'shared', 'factory-db'], 'factory-api': ['factory-api', 'shared', 'factory-db', 'pricing'], kiosk: ['kiosk', 'factory-api/openapi.json'] };
  const all = { meter: 'base', 'factory-api': 'base', kiosk: 'base' };
  const names = (changed: string[], ledger = emptyLedger()) =>
    plan({ sha, sources, baselines: all, ledger, changedSince: () => changed, isAncestor: () => true }).map(recipe => recipe.name);
  // scripts/release/release.py fingerprints these four for every component.
  for (const shared of ['VERSION', 'Cargo.toml', 'Cargo.lock', 'deploy/components.json']) {
    assert.deepEqual(names([shared]), ['meter', 'factory-api', 'kiosk'], shared);
    assert.deepEqual(names([shared], { components: { meter: { sha, tag: 'v', health: 'pass' }, kiosk: { sha, tag: 'v', health: 'pass' } } }), ['factory-api'], `${shared}: healthy same-SHA records still skip`);
    assert.throws(() => plan({ sha, sources, baselines: all, ledger: emptyLedger(), changedSince: () => [shared], isAncestor: () => false }), /older or divergent/, `${shared}: ancestry still refuses`);
  }
  for (const lookalike of ['VERSION.md', 'docs/VERSION', 'Cargo.toml.bak', 'meter-cli/Cargo.toml', 'Cargo.lock~', 'kiosk-docs/Cargo.lock', 'deploy/components.json.orig', 'deploy/components.jsonc', 'docs/deploy/components.json', 'docs/odd/README.md']) {
    assert.deepEqual(names([lookalike]), [], lookalike);
  }
  assert.deepEqual(names([]), []);
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
  /** `undefined` is an absent ledger file: reads throw ENOENT. */
  ledger: Ledger | undefined;
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
  /** The odd issues Linear lists in Deploying (read live, so a fixture can move an issue between ticks). */
  deploying?: string[];
  /** Merged PRs GitHub's quoted search returns for an issue (by title or body); `gh pr view` reads their bodies. */
  prs?: { number: number; title: string; headRefName: string; body: string; mergeCommit: { oid: string }; mergedAt: string }[];
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
  const clock = { now: Date.parse('2026-10-27T00:00:00.000Z') };
  const logs: [string, Record<string, unknown>][] = [];
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
    toolsDir: join(stateDir, 'factory-tools'),
    log: (decision, details = {}) => { logs.push([decision, details as Record<string, unknown>]); },
    sleep: async () => {},
    now: () => clock.now,
    run: (command, args) => {
      const out = (stdout: string) => ({ stdout, stderr: '' });
      // Tools self-checks pass here; the promotion fixtures run the real ones.
      if (command === process.execPath) return out(JSON.stringify({ decision: 'self-check', root: realpathSync(args.at(-2)!.replace(/\/scripts\/.*$/, '')) }));
      if (command === 'gh' && args[0] === 'api') return out(JSON.stringify([options.tags.map(tag_name => ({ tag_name, draft: false, prerelease: false }))]));
      if (command === 'gh' && args[0] === 'pr') {
        if (failPrView) { failPrView = false; throw new Error(`gh pr view ${args[2]} exited 1\nHTTP 503: Service Unavailable`); }
        if (args[1] === 'list') {
          const query = args[args.indexOf('--search') + 1].replaceAll('"', '').toLowerCase();
          calls.push(`gh pr list ${query}`);
          return out(JSON.stringify((options.prs ?? []).filter(pr => `${pr.title}\n${pr.body}`.toLowerCase().includes(query)).map(({ title: _, ...pr }) => pr)));
        }
        if (args[2] === '404') throw new Error('gh pr view 404 exited 1\nGraphQL: Could not resolve to a PullRequest with the number of 404. (repository.pullRequest)');
        return out(JSON.stringify({ body: options.prs?.find(pr => pr.number === Number(args[2]))?.body ?? `closes MET-${args[2]}` }));
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
    readLedger: () => {
      if (!ledger) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      return structuredClone(ledger);
    },
    writeLedger: (next, write) => {
      if (write?.create && ledger) throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      ledger = structuredClone(next);
    },
    linear: {
      deploying: async identifier => !options.notDeploying?.includes(identifier),
      posted: async (identifier, body) => comments.some(([issue, text]) => issue === identifier && text === body),
      comment: async (identifier, body) => {
        if (failComment === identifier) { failComment = undefined; throw new Error('Linear 503'); }
        comments.push([identifier, body]);
        if (lostComment === identifier) { lostComment = undefined; throw new Error('Linear request timed out'); }
      },
      deployingIssues: async () => [...options.deploying ?? []],
      // Creation order is array order.
      comments: async identifier => comments.flatMap(([issue, body], i) => issue === identifier ? [{ body, createdAt: new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 1000).toISOString() }] : []),
    },
  };
  const cleanup = () => rmSync(stateDir, { recursive: true, force: true });
  return { effects, calls, comments, live, logs, clock, ledger: () => ledger!, stateDir, cleanup, exists: () => ledger !== undefined };
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
  // A snapshot this deployer's --no-db-change install took: proven binary-only, so its rollback may run.
  host.effects.writeLedger({ ...host.ledger(), inFlight: { tag: 'v0.2.50', sha: shas['v0.2.50'], component: 'meter', phase: 'probing', snapshot, noDbChange: true } });
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

/** install-deploy.sh on a relocated fake host: stub sudo/systemctl/git, real Node self-checks of a promoted tools tree. */
function installerHost(t: { after: (fn: () => void) => void }) {
  const temp = mkdtempSync(join(tmpdir(), 'odd-units-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  // The deployer-promoted runtime the units execute: a real tree, so the installer's self-checks run.
  const toolsVersion = join(temp, 'home/agent/factory-tools/v9.9.9');
  for (const path of ['scripts/odd', 'scripts/dispatch', 'scripts/usage', 'deploy/components.json']) cpSync(new URL(`../../${path}`, import.meta.url), join(toolsVersion, path), { recursive: true });
  writeFileSync(join(toolsVersion, '.factory-tools.json'), `${JSON.stringify({ tag: 'v9.9.9', sha: 'f'.repeat(40) })}\n`);
  symlinkSync('v9.9.9', join(temp, 'home/agent/factory-tools/current'));
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
    node: `if [[ $1 == --version ]]; then echo v24.22.1; else exec ${process.execPath} "$@"; fi`,
    gh: '[[ $* == "auth status" ]]',
    git: '[[ $* == *"fetch --quiet --tags origin" || $* == *"status --porcelain" ]] || { [[ $* == *"rev-parse HEAD" ]] && echo 1111111111111111111111111111111111111111; }',
    sudo: `if [[ $* == '-n -l' ]]; then
  printf '%s\\n' ${paths.filter(path => /deploy\/(install|rollback)-/.test(path)).map(path => `' /usr/bin/bash ${root}/${path} *'`).join(' ')}
  exit 0
fi
while [[ $1 == -* ]]; do case $1 in -u|-iu) shift 2 ;; *) shift ;; esac; done
exec "$@"`,
    install: 'args=(); while (($#)); do case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; exec /usr/bin/install "${args[@]}"',
    systemctl: `state='${temp}'
echo "$*" >> "$state/systemctl.log"
# Per-unit state for the tools cutover; the deploy-only tests use the files below.
if [[ -n \${UNIT_STATE:-} ]]; then
  case "$1" in
    show) case "$*" in
      *DropInPaths*) cat "$UNIT_STATE/$2.dropins" 2>/dev/null || true ;;
      *ActiveState*) cat "$UNIT_STATE/$2.active" ;;
      *) exit 98 ;;
    esac ;;
    is-enabled) cat "$UNIT_STATE/$2.enabled"; [[ $(cat "$UNIT_STATE/$2.enabled") == enabled ]] ;;
    is-active) cat "$UNIT_STATE/$2.active"; [[ $(cat "$UNIT_STATE/$2.active") == active ]] ;;
    stop) echo inactive > "$UNIT_STATE/$2.active" ;;
    start) echo active > "$UNIT_STATE/$2.active" ;;
    daemon-reload) ;;
    *) exit 99 ;;
  esac
  exit
fi
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
  return { temp, root, units, ledgerPath, ledger, run };
}

test('install-only persistently disables an enabled-but-stopped timer; normal install and removal preserve ledger; a missing ledger is never initialized and blocks the default install', t => {
  const { temp, units, ledgerPath, ledger, run } = installerHost(t);
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
  assert.match(readFileSync(join(units, 'factory-deploy.service'), 'utf8'), new RegExp(`^ExecStart=.* ${temp}/home/agent/factory-tools/current/scripts/odd/deploy\\.ts$`, 'm'));
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
  // Missing ledger: the default install refuses before any snapshot or unit change; install-only never initializes one.
  rmSync(ledgerPath);
  const snapshots = () => readdirSync(join(temp, 'var/backups/factory-deploy')).sort();
  const before = snapshots();
  const absent = run('install-deploy.sh');
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /No deploy ledger at \S+deploy\.json; nothing changed\. Use --install-only, .*deploy\.ts --bootstrap TAG/);
  assert.deepEqual(snapshots(), before);
  assert.equal(existsSync(join(units, 'factory-deploy.timer')), false);
  assert.equal(existsSync(join(temp, 'service-started')), false);
  assert.equal(readFileSync(join(temp, 'enabled'), 'utf8'), 'disabled\n');
  const installOnly = run('install-deploy.sh', ['--install-only']);
  assert.equal(installOnly.status, 0, installOnly.stdout + installOnly.stderr);
  assert.equal(existsSync(join(units, 'factory-deploy.timer')), true);
  assert.equal(readFileSync(join(temp, 'enabled'), 'utf8'), 'disabled\n');
  assert.equal(existsSync(join(temp, 'service-started')), false);
  assert.deepEqual(readdirSync(dirname(ledgerPath)), [], 'install-only never initializes the ledger');
});

test('tools cutover repoints only the three ExecStart paths to one tools link, preserving settings and trigger states; refusals change nothing; revert restores the snapshot', t => {
  const { temp, units, ledgerPath, ledger, run } = installerHost(t);
  const state = join(temp, 'unit-state');
  mkdirSync(state);
  const work = `${temp}/home/agent/work/factory/scripts/`;
  const link = `${temp}/home/agent/factory-tools/current/scripts/`;
  // Installed units as install-deploy/-dispatch/-usage rendered them before the cutover, plus a local setting.
  const old: Record<string, string> = {};
  for (const unit of ['factory-deploy.service', 'factory-dispatch.service', 'factory-usage.service']) {
    old[unit] = readFileSync(new URL(`../../deploy/${unit}`, import.meta.url), 'utf8').replaceAll('/home/agent/', `${temp}/home/agent/`)
      .replaceAll(link, work).replace('@NODE@', '/opt/node/bin/node').replace('@PATH@', '/opt/node/bin:/usr/bin:/bin')
      .replace('[Service]\n', '[Service]\nEnvironment="DISPATCH_RUNNER_CAPS=gpu=3"\n');
    writeFileSync(join(units, unit), old[unit]);
  }
  const triggers = { 'factory-deploy.timer': ['enabled', 'active'], 'factory-dispatch.timer': ['enabled', 'active'], 'factory-usage.timer': ['disabled', 'inactive'], 'factory-usage-refresh.path': ['enabled', 'active'] };
  const setStates = () => {
    for (const [unit, [enabled, active]] of Object.entries(triggers)) {
      writeFileSync(join(units, unit), `[Unit]\nDescription=${unit}\n`);
      writeFileSync(join(state, `${unit}.enabled`), `${enabled}\n`);
      writeFileSync(join(state, `${unit}.active`), `${active}\n`);
    }
    for (const [unit, active] of [['factory-deploy.service', 'inactive'], ['factory-dispatch.service', 'failed'], ['factory-usage.service', 'inactive']]) {
      writeFileSync(join(state, `${unit}.enabled`), 'static\n');
      writeFileSync(join(state, `${unit}.active`), `${active}\n`);
    }
  };
  setStates();
  const env = { UNIT_STATE: state };
  const unitFiles = () => Object.fromEntries(Object.keys(old).map(unit => [unit, readFileSync(join(units, unit), 'utf8')]));
  const triggerStates = () => Object.fromEntries(Object.keys(triggers).map(unit => [unit, ['enabled', 'active'].map(kind => readFileSync(join(state, `${unit}.${kind}`), 'utf8').trim())]));
  const unchanged = (result: ReturnType<typeof run>, error: RegExp) => {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, error);
    assert.deepEqual(unitFiles(), old);
    assert.deepEqual(triggerStates(), triggers);
  };
  // A missing link or a tree failing its self-check refuses before any snapshot or unit change.
  const current = join(temp, 'home/agent/factory-tools/current');
  rmSync(current);
  unchanged(run('install-deploy.sh', ['--tools-cutover'], env), /No tools runtime at .*nothing changed/);
  mkdirSync(join(temp, 'home/agent/factory-tools/v9.9.8/scripts/odd'), { recursive: true });
  writeFileSync(join(temp, 'home/agent/factory-tools/v9.9.8/scripts/odd/deploy.ts'), "console.log('no self-check here');\n");
  symlinkSync('v9.9.8', current);
  unchanged(run('install-deploy.sh', ['--tools-cutover'], env), /Tools self-check failed in .*v9\.9\.8: scripts\/odd\/deploy\.ts --self-check/);
  rmSync(current);
  symlinkSync('v9.9.9', current);
  assert.equal(existsSync(join(temp, 'var/backups/factory-deploy')), false, 'no snapshot before a refusal');
  // A running service: the snapshot is taken, the stopped triggers are restarted, no unit is replaced.
  writeFileSync(join(state, 'factory-dispatch.service.active'), 'activating\n');
  unchanged(run('install-deploy.sh', ['--tools-cutover'], env), /Wait for factory-dispatch\.service to finish/);
  writeFileSync(join(state, 'factory-dispatch.service.active'), 'failed\n');
  rmSync(join(temp, 'systemctl.log'), { force: true });
  const cutover = run('install-deploy.sh', ['--tools-cutover'], env);
  assert.equal(cutover.status, 0, cutover.stdout + cutover.stderr);
  assert.match(cutover.stdout, new RegExp(`^Tools: ${temp}/home/agent/factory-tools/v9\\.9\\.9 \\{"tag":"v9\\.9\\.9","sha":"f{40}"\\}$`, 'm'));
  assert.match(cutover.stdout, new RegExp(`^Installer: ${temp}/home/agent/work/factory 1{40}$`, 'm'));
  const after = unitFiles();
  for (const unit of Object.keys(old)) {
    // Byte-for-byte the old unit with only the script path moved: node, PATH, settings, lock and limits stay.
    assert.equal(after[unit], old[unit].replace(work, link), unit);
    assert.equal(after[unit].split('\n').filter(text => text.startsWith('ExecStart=')).length, 1);
  }
  assert.deepEqual(Object.values(after).map(text => /^ExecStart=.* (\S+)scripts\//m.exec(text)![1]), Array(3).fill(`${temp}/home/agent/factory-tools/current/`));
  assert.match(after['factory-deploy.service'], new RegExp(`ExecStart=/usr/bin/flock -n ${temp}/home/agent/\\.local/state/factory-odd/deploy\\.lock /opt/node/bin/node ${link}odd/deploy\\.ts$`, 'm'));
  assert.deepEqual(triggerStates(), triggers);
  assert.doesNotMatch(readFileSync(join(temp, 'systemctl.log'), 'utf8'), /^(enable|disable)/m, 'enablement is never changed');
  assert.equal(readFileSync(ledgerPath, 'utf8'), ledger);
  const snapshot = /^Snapshot: (.+)$/m.exec(cutover.stdout)![1];
  for (const unit of Object.keys(old)) assert.equal(readFileSync(join(snapshot, unit), 'utf8'), old[unit]);
  // A second cutover refuses: the units no longer execute the installer checkout.
  const again = run('install-deploy.sh', ['--tools-cutover'], env);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /does not execute .*work\/factory\/scripts\/odd\/deploy\.ts/);
  assert.deepEqual(unitFiles(), after);
  const reverted = run('install-deploy.sh', ['--revert-tools-cutover', snapshot], env);
  assert.equal(reverted.status, 0, reverted.stdout + reverted.stderr);
  assert.deepEqual(unitFiles(), old);
  assert.deepEqual(triggerStates(), triggers);
  assert.equal(readFileSync(ledgerPath, 'utf8'), ledger);
  // The repository templates the installers render all execute the same link.
  for (const unit of Object.keys(old)) assert.match(readFileSync(new URL(`../../deploy/${unit}`, import.meta.url), 'utf8'), /^ExecStart=.*@NODE@ \/home\/agent\/factory-tools\/current\/scripts\/(odd\/deploy|dispatch\/dispatch|usage\/collect)\.ts( poll)?$/m);
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
  const tools = ['scripts/odd/deploy.ts', 'scripts/odd/lifecycle.ts', 'scripts/odd/snapshot.ts', 'scripts/odd/engines.ts', 'scripts/release/release.py', ...recipes.flatMap(recipe => [recipe.installer, recipe.rollback])];
  for (const path of tools) writeFileSync(join(runtime, path), readFileSync(new URL(`../../${path}`, import.meta.url)));
  const toolsSha = commit('deployment machinery');
  git('update-ref', 'refs/remotes/origin/main', toolsSha);
  let ledger = baseline();
  let failInstall = true;
  const live = new Map<string, string>();
  const verified: string[] = [];
  const comments: [string, string][] = [];
  // The runtime the timer executes before these releases; none of them may replace it.
  const toolsDir = join(temp, 'factory-tools');
  mkdirSync(join(toolsDir, 'v0.2.8'), { recursive: true });
  symlinkSync('v0.2.8', join(toolsDir, 'current'));
  const effects: Effects = {
    stateDir, toolsDir, log: () => {}, sleep: async () => {},
    run: (command, args, options) => {
      if (command === process.execPath || (command === 'tar' && args[1] === '-xf')) return run(command, args, options);
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
    now: () => Date.now(),
    linear: { deploying: async () => true, posted: async (id, body) => comments.some(([i, b]) => i === id && b === body), comment: async (id, body) => { comments.push([id, body]); },
      deployingIssues: async () => [], comments: async () => [] },
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
  // v0.2.11 predates the self-checks: it deploys, but its tools are rejected and the running link stays.
  await assert.rejects((await import(`${entry}?next-tick`)).main(effects), /Tools v0\.2\.11 rejected; \S+ restored to v0\.2\.8: scripts\/odd\/deploy\.ts --self-check failed in \S+\/v0\.2\.11: /);
  assert.equal(readlinkSync(join(toolsDir, 'current')), 'v0.2.8');
  assert.equal(ledger.tools?.current, undefined);
  assert.deepEqual({ ...ledger.tools?.rejected, reason: undefined }, { tag: 'v0.2.11', sha: second, installerSha: toolsSha, reason: undefined });
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

// Preloaded before a tool: every network, subprocess, lock, key, file-write or database-file call is reported on stderr and fails.
const guard = `data:text/javascript,${encodeURIComponent(`
import fs from 'node:fs';
import net from 'node:net';
import childProcess from 'node:child_process';
import sqlite from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
const block = (name, detail = '') => { process.stderr.write('GUARD ' + name + ' ' + detail + '\\n'); throw new Error('blocked ' + name); };
globalThis.fetch = url => block('fetch', String(url));
net.Socket.prototype.connect = () => block('connect');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = command => block(name, command);
// Reads stay open (module loading uses openSync); locks, keys and every writable open are blocked.
const openSync = fs.openSync;
fs.openSync = (path, flags = 'r', ...rest) => flags !== 'r' || /\\.lock$|linear(-api)?-key/.test(String(path)) ? block('openSync', path) : openSync(path, flags, ...rest);
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'rmSync', 'unlinkSync', 'chmodSync', 'linkSync', 'symlinkSync', 'mkdtempSync', 'cpSync']) fs[name] = path => block(name, path);
for (const name of ['open', 'writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'unlink', 'chmod']) fs.promises[name] = async path => block(name, path);
const Database = sqlite.DatabaseSync;
sqlite.DatabaseSync = class extends Database { constructor(path, options) { if (path !== ':memory:') block('DatabaseSync', path); super(path, options); } };
syncBuiltinESMExports();
`)}`;

test('self-checks through a tools link: real imports and config, no network, subprocess, lock, ledger, key or file write; the guard catches a real poll', t => {
  const temp = mkdtempSync(join(tmpdir(), 'odd-checks-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  symlinkSync(repo, join(temp, 'current'));
  mkdirSync(join(temp, 'home'));
  const env = { PATH: join(temp, 'no-commands'), HOME: join(temp, 'home'), DISPATCH_LEDGER: join(temp, 'state/dispatch.db'),
    DISPATCH_LOCK_FILE: join(temp, 'dispatch.lock'), LINEAR_API_KEY_FILE: join(temp, 'linear-key'), FACTORY_USAGE_SNAPSHOT: join(temp, 'usage.json') };
  const run = (script: string, args: string[], extra = {}) => spawnSync(process.execPath, ['--import', guard, join(temp, 'current', script), ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  for (const [script, arg] of toolChecks) {
    const result = run(script, [arg]);
    assert.equal(result.status, 0, `${script}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stderr, '', `${script} made no guarded call`);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.decision, 'self-check');
    assert.equal(report.root, repo, `${script} resolved the link to its tree`);
  }
  assert.deepEqual(readdirSync(temp).sort(), ['current', 'home']);
  assert.deepEqual(readdirSync(join(temp, 'home')), []);
  // Config is parsed for real: an invalid runner list fails the dispatcher's check.
  const invalid = run('scripts/dispatch/dispatch.ts', ['check'], { DISPATCH_RUNNERS: 'gpu=factory-gpu' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /DISPATCH_RUNNERS must be gpu=<id>,console=<id>/);
  // Control: the same guard reports the dispatcher's lock and the collector's lock on a real run.
  const poll = run('scripts/dispatch/dispatch.ts', ['poll']);
  assert.equal(poll.status, 1);
  assert.match(poll.stderr, new RegExp(`^GUARD openSync ${join(temp, 'dispatch.lock')}$`, 'm'));
  const collect = run('scripts/usage/collect.ts', ['--dry-run']);
  assert.equal(collect.status, 1);
  assert.match(collect.stderr, /^GUARD openSync \/home\/agent\/work\/factory\/scripts\/usage\/collect\.lock$/m);
});

test('tools promotion: a good release once and forward only; missing, failed, timed-out or unactivatable checks and crashes keep the prior link, installer root and no false success', t => {
  const temp = mkdtempSync(join(tmpdir(), 'odd-tools-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runtime = join(temp, 'factory');
  const stateDir = join(temp, 'state');
  const toolsDir = join(temp, 'factory-tools');
  const link = join(toolsDir, 'current');
  const live = liveEffects().run;
  const git = (...args: string[]) => live('git', ['-C', runtime, ...args]).stdout.trim();
  mkdirSync(join(runtime, 'deploy'), { recursive: true });
  for (const path of ['scripts/odd', 'scripts/dispatch', 'scripts/usage', 'deploy/components.json']) cpSync(new URL(`../../${path}`, import.meta.url), join(runtime, path), { recursive: true });
  writeFileSync(join(runtime, 'deploy/install-meter.sh'), '# installer\n');
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const edit = (path: string, from: string, to: string) => {
    const text = readFileSync(join(runtime, path), 'utf8');
    assert.ok(text.includes(from), `${path} lacks ${from}`);
    writeFileSync(join(runtime, path), text.replace(from, to));
  };
  const shas: Record<string, string> = {};
  const release = (tag: string, change: () => void) => { change(); git('add', '-A'); git('commit', '-qm', tag); shas[tag] = git('rev-parse', 'HEAD'); };
  const good = () => writeFileSync(join(runtime, 'release.txt'), `${Object.keys(shas).length}\n`);
  release('v1.0.0', good);
  release('v1.1.0', good);
  release('v1.2.0', () => writeFileSync(join(runtime, 'scripts/dispatch/repos.json'), '{"broken'));
  release('v1.3.0', () => { git('checkout', '-q', shas['v1.1.0'], '--', '.'); edit('scripts/usage/collect.ts', 'export async function selfCheck() {', 'export async function selfCheck() {\n  await new Promise(() => setInterval(() => {}, 1000));'); });
  // Before this change: the collector has no self-check, and the deployer's main guard compares the link path.
  release('v1.4.0', () => { git('checkout', '-q', shas['v1.1.0'], '--', '.'); edit('scripts/usage/collect.ts', "['--dry-run', '--self-check']", "['--dry-run']"); });
  release('v1.5.0', () => { git('checkout', '-q', shas['v1.1.0'], '--', '.'); edit('scripts/odd/deploy.ts', 'fileURLToPath(import.meta.url) === realpathSync(process.argv[1])', 'fileURLToPath(import.meta.url) === process.argv[1]'); });
  release('v1.6.0', () => { git('checkout', '-q', shas['v1.1.0'], '--', '.'); good(); });
  release('v1.7.0', good);
  release('v1.8.0', good);
  // The approved installer revision ROOT stays at: newer than every release, with its own installer change.
  writeFileSync(join(runtime, 'deploy/install-meter.sh'), '# reviewed installer change\n');
  git('add', '-A');
  git('commit', '-qm', 'installer revision');
  const installerSha = git('rev-parse', 'HEAD');
  let ledger: Ledger = { lastTag: 'v1.8.0', components: {} };
  const logs: [string, Record<string, unknown>][] = [];
  const checks: { path: string; report?: Record<string, unknown> }[] = [];
  let crash: ((next: Ledger) => boolean) | undefined;
  let failArchive = false;
  const forbidden = () => { throw new Error('promotion must not use sudo, probes or Linear'); };
  const effects: Effects = {
    stateDir, toolsDir, log: (decision, details = {}) => logs.push([decision, details as Record<string, unknown>]), sleep: async () => {},
    run: (command, args, options) => {
      if (command === process.execPath) {
        assert.equal(options?.timeout, CHECK_TIMEOUT_MS);
        assert.deepEqual(args.slice(0, 2), ['--permission', '--allow-fs-read=*'], 'candidate checks cannot write or spawn');
        checks.push({ path: args[2] });
        // The real check, with a shorter bound so the hanging candidate costs seconds.
        const result = live(command, args, { ...options, timeout: 10_000 });
        try { checks.at(-1)!.report = JSON.parse(result.stdout.trim().split('\n').at(-1)!); } catch { /* Reported by promoteTools. */ }
        return result;
      }
      if (command === 'git' && args[2] === 'archive' && failArchive) { failArchive = false; throw new Error('git archive: interrupted'); }
      return live(command, args.map(arg => arg === ROOT ? runtime : arg), options);
    },
    ok: forbidden, sudo: forbidden, probe: forbidden,
    readLedger: () => structuredClone(ledger),
    writeLedger: next => {
      if (crash?.(next)) { crash = undefined; throw new Error('killed before the ledger write'); }
      ledger = structuredClone(next);
    },
    linear: { deploying: forbidden, posted: forbidden, comment: forbidden },
  };
  const verify = (tag: string, sha = shas[tag]) => { mkdirSync(join(stateDir, 'releases', tag), { recursive: true }); writeFileSync(join(stateDir, 'releases', tag, '.verified'), `${sha}\n`); };
  const decisions = () => logs.map(([decision]) => decision);
  const record = (tag: string) => ({ tag, sha: shas[tag], installerSha });
  const linkTarget = () => readlinkSync(link);
  const versions = () => readdirSync(toolsDir).filter(name => name !== 'current').sort();

  // A release this job never verified is not staged.
  promoteTools(effects, 'v1.0.0');
  assert.deepEqual(decisions(), ['tools-waiting']);
  assert.equal(existsSync(toolsDir), false);
  for (const tag of Object.keys(shas)) verify(tag);

  // Good: candidate then activation checks, one atomic link, the installer path and SHA recorded beside it.
  logs.length = 0;
  promoteTools(effects, 'v1.0.0');
  const v1 = realpathSync(join(toolsDir, 'v1.0.0'));
  assert.equal(linkTarget(), 'v1.0.0');
  assert.deepEqual(ledger.tools, { current: record('v1.0.0'), rejected: undefined });
  assert.deepEqual(checks.map(check => check.path.replace(toolsDir, '')), [
    '/v1.0.0/scripts/odd/deploy.ts', '/v1.0.0/scripts/dispatch/dispatch.ts', '/v1.0.0/scripts/usage/collect.ts',
    '/current/scripts/odd/deploy.ts', '/current/scripts/dispatch/dispatch.ts', '/current/scripts/usage/collect.ts']);
  assert.deepEqual(checks.map(check => check.report?.root), Array(6).fill(v1), 'every check ran in the resolved version, including through the link');
  assert.deepEqual(checks.map(check => check.report?.tool), ['deploy', 'dispatch', 'usage', 'deploy', 'dispatch', 'usage']);
  assert.equal(checks[3].report?.installerRoot, '/home/agent/work/factory');
  const promoted = logs.find(([decision]) => decision === 'tools-promoted')![1];
  assert.deepEqual(promoted, { ...record('v1.0.0'), link, root: v1, installerRoot: '/home/agent/work/factory', installerChanges: ['deploy/install-meter.sh'] });
  assert.deepEqual(JSON.parse(readFileSync(join(v1, '.factory-tools.json'), 'utf8')), { tag: 'v1.0.0', sha: shas['v1.0.0'] });
  assert.equal(existsSync(join(v1, '.git')), false, 'a release tree, not a checkout that can be moved');
  // Once: the same tag again stages and checks nothing.
  checks.length = 0;
  logs.length = 0;
  promoteTools(effects, 'v1.0.0');
  assert.deepEqual([checks.length, logs.length], [0, 0]);

  promoteTools(effects, 'v1.1.0');
  assert.equal(linkTarget(), 'v1.1.0');
  assert.deepEqual(ledger.tools?.current, record('v1.1.0'));
  // Never backwards, and the prior version stays intact for running processes.
  checks.length = 0;
  promoteTools(effects, 'v1.0.0');
  assert.equal(checks.length, 0);
  assert.equal(linkTarget(), 'v1.1.0');
  assert.deepEqual(JSON.parse(readFileSync(join(v1, '.factory-tools.json'), 'utf8')), { tag: 'v1.0.0', sha: shas['v1.0.0'] });

  // Failed, timed-out, missing and unactivatable checks: the prior link, no success, the tag not retried.
  const rejected: [string, RegExp][] = [
    ['v1.2.0', /scripts\/dispatch\/dispatch\.ts check failed in \S+\/v1\.2\.0: /],
    ['v1.3.0', /scripts\/usage\/collect\.ts --self-check failed in \S+\/v1\.3\.0: spawnSync \S+ ETIMEDOUT/],
    ['v1.4.0', /scripts\/usage\/collect\.ts --self-check failed in \S+\/v1\.4\.0: /],
    // Its candidate checks pass by path; through the link its old main guard runs nothing.
    ['v1.5.0', /scripts\/odd\/deploy\.ts --self-check did not report a self-check of \S+\/v1\.5\.0$/],
  ];
  for (const [tag, reason] of rejected) {
    logs.length = 0;
    checks.length = 0;
    assert.throws(() => promoteTools(effects, tag), new RegExp(`^Error: Tools ${tag.replaceAll('.', '\\.')} rejected; ${link} restored to v1\\.1\\.0: ${reason.source}`));
    assert.equal(linkTarget(), 'v1.1.0', tag);
    assert.deepEqual(ledger.tools?.current, record('v1.1.0'), tag);
    assert.equal(ledger.tools?.pending, undefined, tag);
    assert.deepEqual({ ...ledger.tools?.rejected, reason: undefined }, { ...record(tag), reason: undefined });
    assert.match(ledger.tools!.rejected!.reason, reason);
    assert.ok(!decisions().includes('tools-promoted'), tag);
    if (tag === 'v1.5.0') assert.deepEqual(checks.map(check => check.report?.root ?? null), [...Array(3).fill(realpathSync(join(toolsDir, tag))), null]);
    checks.length = 0;
    promoteTools(effects, tag);
    assert.equal(checks.length, 0, `${tag} is not retried`);
  }

  // Killed after the link moved but before delivery: still pending, never recorded as current;
  // the next tick resumes, rechecks and delivers.
  crash = next => next.tools?.current?.tag === 'v1.6.0';
  logs.length = 0;
  assert.throws(() => promoteTools(effects, 'v1.6.0'), /killed before the ledger write/);
  assert.equal(linkTarget(), 'v1.6.0');
  assert.deepEqual(ledger.tools?.pending, { ...record('v1.6.0'), previous: 'v1.1.0' });
  assert.deepEqual(ledger.tools?.current, record('v1.1.0'));
  assert.ok(!decisions().includes('tools-promoted'));
  logs.length = 0;
  promoteTools(effects, 'v1.8.0');
  assert.deepEqual(decisions(), ['tools-resume', 'tools-promoted']);
  assert.deepEqual(ledger.tools?.current, record('v1.6.0'));
  assert.equal(ledger.tools?.pending, undefined);

  // Interrupted staging: pending kept, link and versions untouched, no partial tree; the retry completes.
  failArchive = true;
  assert.throws(() => promoteTools(effects, 'v1.7.0'), /git archive: interrupted/);
  assert.deepEqual(ledger.tools?.pending, { ...record('v1.7.0'), previous: 'v1.6.0' });
  assert.equal(linkTarget(), 'v1.6.0');
  assert.deepEqual(versions(), ['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.3.0', 'v1.4.0', 'v1.5.0', 'v1.6.0']);
  promoteTools(effects, 'v1.7.0');
  assert.equal(linkTarget(), 'v1.7.0');
  assert.deepEqual(ledger.tools?.current, record('v1.7.0'));

  // An existing version is never replaced, even when its recorded commit differs.
  mkdirSync(join(toolsDir, 'v1.8.0'));
  writeFileSync(join(toolsDir, 'v1.8.0/.factory-tools.json'), JSON.stringify({ tag: 'v1.8.0', sha: shas['v1.0.0'] }));
  assert.throws(() => promoteTools(effects, 'v1.8.0'), /refusing to replace a tools version/);
  assert.deepEqual(JSON.parse(readFileSync(join(toolsDir, 'v1.8.0/.factory-tools.json'), 'utf8')).sha, shas['v1.0.0']);
  assert.equal(linkTarget(), 'v1.7.0');
  assert.deepEqual(ledger.tools?.current, record('v1.7.0'));
  assert.equal(ledger.tools?.pending?.tag, 'v1.8.0');
  // The installer checkout never moved; no staging directory or link temporary is left behind.
  assert.equal(git('rev-parse', 'HEAD'), installerSha);
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(readdirSync(toolsDir).filter(name => name.startsWith('.') || name.includes('.next-')), []);
});

test('sandbox: a kiosk release installs, three green probes report its SHA, Deploying issues get a pass receipt and move to Done', async t => {
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx', 'docs/x.md'] }, issues: { 'v0.3.0': ['MET-301', 'MET-302'] }, notDeploying: ['MET-302'], ledger: baseline() });
  t.after(host.cleanup);
  await main(host.effects);
  const dir = join(host.stateDir, 'releases/v0.3.0');
  assert.deepEqual(host.calls, ['verify v0.3.0', 'checkout 1111111', 'probe', 'probe', 'probe', 'probe', `sudo deploy/install-kiosk.sh ${dir}/kiosk`, 'probe', 'probe', 'probe']);
  assert.equal(host.live.kiosk, shas['v0.3.0']);
  const pass = line(`component=kiosk sha=${shas['v0.3.0']} health=pass rollback=none`);
  assert.deepEqual(host.comments, [['MET-301', pass]]);
  assert.deepEqual(deploying(pass), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify kiosk at 111111111111', round: 1 });
  assert.equal(host.ledger().lastTag, 'v0.3.0');
  assert.equal(host.ledger().receipt, undefined);
  assert.deepEqual(host.ledger().deliveries?.map(delivery => delivery.issue), ['MET-302'], 'the issue not yet Deploying stays a pending delivery');
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
function pluginContext(found: { id: string }[] = [], fail?: string, linear = fakeLinear()) {
  const tools: [string, Record<string, unknown>][] = [];
  const ctx = {
    tools: { call: async (name: string, input: Record<string, unknown>) => {
      tools.push([name, input]);
      if (name === fail || (fail === 'Bug lookup' && name === 'linear.get_issue')) { fail = undefined; throw new Error(`${name}: HTTP 503`); }
      if (name === 'find_thread') return { threads: found };
      if (name === 'linear.save_comment') return { id: input.id ?? 'c-latch' };
      return linear.call(name, input) ?? {};
    } },
    $: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    logger: { log: () => {} },
  };
  return { ctx: ctx as unknown as Parameters<typeof page>[0], tools, linear };
}

/** Fake Linear issues with related-issue links, as get_issue returns them; a created issue is MET-900, MET-901, … */
function fakeLinear() {
  const issues = new Map<string, { id: string; title: string; description: string; labels: string[]; status: string; related: Set<string> }>();
  const add = (id: string, fields: { title?: string; description?: string; labels?: string[]; status?: string; related?: string[] } = {}) => {
    issues.set(id, { id, title: fields.title ?? id, description: fields.description ?? '', labels: fields.labels ?? ['odd'], status: fields.status ?? 'Deploying', related: new Set() });
    for (const other of fields.related ?? []) link(id, other);
  };
  const link = (a: string, b: string) => {
    if (!issues.has(b)) add(b);
    issues.get(a)!.related.add(b);
    issues.get(b)!.related.add(a);
  };
  const call = (name: string, input: Record<string, unknown>): unknown => {
    if (name === 'linear.get_issue') {
      const id = String(input.id);
      if (!issues.has(id)) add(id);
      const { title, description, labels, status, related } = issues.get(id)!;
      return { id, title, description, labels, status, relations: { blockedBy: [], relatedTo: [...related].map(other => ({ id: other, title: issues.get(other)!.title })) } };
    }
    if (name === 'linear.save_issue' && typeof input.title === 'string' && input.id === undefined) {
      const id = `MET-${900 + [...issues.keys()].filter(key => /^MET-9\d\d$/.test(key)).length}`;
      add(id, { title: input.title, description: String(input.description), labels: input.labels as string[], status: String(input.state) });
      for (const other of (input.relatedTo as string[] | undefined) ?? []) link(id, other);
      return { identifier: id };
    }
    if (name === 'linear.save_issue' && typeof input.id === 'string' && typeof input.title === 'string') issues.get(input.id)!.title = input.title;
    // Linear's search matches title or description text; only a title lookup could rely on it.
    if (name === 'linear.list_issues' && typeof input.query === 'string') return { issues: [...issues.values()].filter(issue => `${issue.title}\n${issue.description}`.includes(String(input.query))).map(({ id, title }) => ({ id, title })) };
    return undefined;
  };
  return { issues, add, link, call, created: () => [...issues.values()].filter(issue => issue.labels.includes('Bug')) };
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

for (const [what, receiptSha, failTool, spawnFails] of [['Bug lookup', 'c'.repeat(40), 'Bug lookup', false], ['log-reader spawn', 'd'.repeat(40), undefined, true]] as const) {
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

// P4.6-rollback-bugs: a rollback Bug is labelled by its receipt component and found again by relation and key, never by title.
const rollbackOf = (identifier: string, component: string, receiptSha: string) => ({ identifier, status: 'Deploying' as const, labels: ['odd'], description: '', openBlockers: [],
  deployReceipt: parseDeployReceipt(line(`component=${component} sha=${receiptSha} health=fail rollback=/var/backups/${component}/snap`)) });
const evaluate = async (linear: ReturnType<typeof fakeLinear>, issue: ReturnType<typeof rollbackOf>) => {
  const { ctx } = pluginContext([{ id: 'T-reader' }], undefined, linear);
  await setStatus(ctx, issue, nextAction(issue, idle) as Extract<Action, { kind: 'set-status' }>, async () => 'T-deployer');
};

test('P4.6-rollback-bugs: every deploy component files its Bug in Triage with exactly Bug and its own area; tooling components fall back to ops, never agents', async () => {
  const components = JSON.parse(readFileSync(new URL('../../deploy/components.json', import.meta.url), 'utf8')).components.map((component: { id: string }) => component.id) as string[];
  const expected: Record<string, string> = { meter: 'area:meter', 'factory-api': 'area:api', kiosk: 'area:kiosk' };
  assert.ok(['meter', 'factory-api', 'kiosk', 'dispatcher', 'usage'].every(name => components.includes(name)), components.join(' '));
  for (const component of components) {
    const linear = fakeLinear();
    await evaluate(linear, rollbackOf('MET-311', component, 'c'.repeat(40)));
    const bugs = linear.created();
    assert.equal(bugs.length, 1, component);
    assert.deepEqual([bugs[0].labels, bugs[0].status], [['Bug', expected[component] ?? 'area:ops'], 'Triage'], component);
    assert.ok(bugs[0].related.has('MET-311'), component);
  }
});

test('P4.6-rollback-bugs: repeated evaluations and an edited title reuse the related Bug; same-title, unkeyed or other-identity issues are never reused', async () => {
  const sha = 'c'.repeat(40);
  const title = `Deploy failed: meter at ${sha.slice(0, 12)}`;
  const linear = fakeLinear();
  // An unrelated Bug with the identical title and even the key line, not linked to MET-311.
  linear.add('MET-500', { title, labels: ['Bug', 'area:agents'], status: 'Triage', description: `odd-rollback-bug source=MET-311 component=meter sha=${sha}` });
  // A related issue with the identical title but no key line (filed by hand).
  linear.add('MET-501', { title, labels: ['Bug', 'area:meter'], status: 'Triage', description: 'seen it too', related: ['MET-311'] });
  // A related Bug for another source issue of the same release.
  linear.add('MET-502', { title, labels: ['Bug', 'area:meter'], status: 'Triage', description: `odd-rollback-bug source=MET-312 component=meter sha=${sha}`, related: ['MET-311', 'MET-312'] });
  const issue = rollbackOf('MET-311', 'meter', sha);
  await evaluate(linear, issue);
  const filed = linear.created().filter(bug => bug.id >= 'MET-900');
  assert.deepEqual(filed.map(bug => bug.id), ['MET-900'], 'none of MET-500..502 is reused');
  await evaluate(linear, issue);
  linear.call('linear.save_issue', { id: 'MET-900', title: 'meter rollback: probe 503 after install' });
  await evaluate(linear, issue);
  assert.deepEqual(linear.created().filter(bug => bug.id >= 'MET-900').map(bug => bug.id), ['MET-900'], 'reused after a repeat and a title edit');
  // Each part of the identity is a different Bug: another release, another component, another source issue.
  await evaluate(linear, rollbackOf('MET-311', 'meter', 'd'.repeat(40)));
  await evaluate(linear, rollbackOf('MET-311', 'kiosk', sha));
  await evaluate(linear, rollbackOf('MET-313', 'meter', sha));
  assert.deepEqual(linear.created().filter(bug => bug.id >= 'MET-900').map(bug => [bug.id, bug.labels[1], [...bug.related].sort().join(' ')]),
    [['MET-900', 'area:meter', 'MET-311'], ['MET-901', 'area:meter', 'MET-311'], ['MET-902', 'area:kiosk', 'MET-311'], ['MET-903', 'area:meter', 'MET-313']]);
});

test('P4.6-rollback-bugs: a source issue read without its related list, or with a malformed one, files no Bug and keeps the issue in Deploying', async () => {
  for (const relations of [undefined, {}, { relatedTo: null }, { relatedTo: [{}] }, { relatedTo: [{ id: '' }] }]) {
    const linear = fakeLinear();
    const base = linear.call;
    const issue = rollbackOf('MET-311', 'meter', 'c'.repeat(40));
    const { ctx, tools } = pluginContext([], undefined, { ...linear, call: (name: string, input: Record<string, unknown>) =>
      name === 'linear.get_issue' && input.id === 'MET-311' ? { id: 'MET-311', status: 'Deploying', labels: ['odd'], relations } : base(name, input) });
    await assert.rejects(setStatus(ctx, issue, nextAction(issue, idle) as Extract<Action, { kind: 'set-status' }>, async () => 'T-deployer'), /relatedTo|malformed/, JSON.stringify(relations));
    assert.deepEqual(tools.filter(([tool]) => tool === 'linear.save_issue'), [], JSON.stringify(relations));
  }
});

/** The registered plugin armed in a control thread, with fake Amp, Linear, GitHub and Slack. */
async function controlPlane(options: { issue: string; receipt: string; failOnce: string }) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const webhooks = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const calls: string[] = [];
  const linear = fakeLinear();
  let status = 'Deploying';
  let failOnce: string | undefined = options.failOnce;
  const alerts: string[] = [];
  const tools = { call: async (name: string, input: Record<string, unknown>) => {
    // The Watchdog sweep enumerates issues by status and posts to #factory-alerts; neither is the handoff under test.
    if (name === 'linear.list_issues' && (input.state !== undefined || input.label !== undefined)) return { issues: [] };
    if (name === 'slack_write' && input.channelName !== undefined) { alerts.push(String(input.text)); return {}; }
    const lookup = name === 'linear.get_issue' && Array.isArray(input.fields) && input.fields.includes('relations');
    if (lookup) calls.push('Bug lookup');
    if (failOnce === 'Bug lookup' && lookup) { failOnce = undefined; calls[calls.length - 1] = 'Bug lookup failed'; throw new Error(`${name}: HTTP 503`); }
    switch (name) {
      case 'linear.get_issue': {
        if (input.id !== options.issue) return linear.call(name, input);
        const { relations } = linear.call(name, input) as { relations: unknown };
        return { id: options.issue, status, labels: ['odd'], description: '', relations };
      }
      case 'linear.list_comments': return { comments: [{ body: options.receipt, createdAt: '2026-10-24T15:00:00Z' }, { body: 'odd-merge pr=1 head=a merge=b release=none', createdAt: '2026-10-24T14:00:00Z' }], hasNextPage: false };
      case 'linear.save_issue':
        if (typeof input.title === 'string') { calls.push('Bug created'); return linear.call(name, input); }
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
  const ui = { confirm: async () => true, notify: async () => {}, input: async () => signingSecret };
  const logger = { log: () => {} };
  const agent = { definition: {}, createThread: async (options: { executor: unknown }) => ({
    id: 'T-deployer', setLabels: async (labels: string[]) => { calls.push(`log reader ${JSON.stringify(options.executor)} ${labels.at(-1)}`); }, appendUserMessage: async () => {},
  }) };
  const { $ } = fakeShell();
  const amp = {
    $, createAgent: () => agent, registerAgentMode: () => {}, registerTool: () => {},
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, handler); },
    createWebhook: async ({ key, handler }: { key: string; handler: (event: unknown, ctx: unknown) => Promise<void> }) => { webhooks.set(key, handler); return { url: `https://hooks.example/${key}` }; },
    system: { executor: { kind: 'remote', keepAlive: async () => {} } },
  };
  await (plugin as unknown as (api: unknown) => Promise<void>)(amp);
  await handlers.get('session.start')!({}, { thread, ui, logger, tools });
  const deliver = (id: string) => webhooks.get('linear')!(
    signedLinear(id, '2026-10-24T15:00:01Z', { identifier: options.issue }),
    { thread, ui, logger, tools, $ });
  return { deliver, calls, alerts, status: () => status };
}

/** The private test signing secret the control thread's secret dialogs receive, and a Linear delivery signed with it the way Linear signs: HMAC-SHA256 of the raw body, `webhookTimestamp` at send time. */
const signingSecret = 'test-signing-secret';
const signedLinear = (id: string, receivedAt: string, data: Record<string, unknown>) => {
  const body = JSON.stringify({ data, webhookId: id, webhookTimestamp: Date.parse(receivedAt) - 1_000 });
  return { id, receivedAt, body: new TextEncoder().encode(body), headers: { 'linear-signature': createHmac('sha256', signingSecret).update(body).digest('hex') } };
};

const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };

test('control plane, through the registered webhook: a transient Bug-lookup failure is re-evaluated by itself, and a redelivery of the failed event is not ignored', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const receipt = line(`component=kiosk sha=${'f'.repeat(40)} health=fail rollback=/var/backups/kiosk/snap`);
  const host = await controlPlane({ issue: 'MET-312', receipt, failOnce: 'Bug lookup' });
  await assert.rejects(host.deliver('evt-1'), /HTTP 503/);
  assert.deepEqual(host.calls, ['Bug lookup failed']);
  assert.equal(host.status(), 'Deploying');
  // No new event arrives: the failure's own re-check (90 s) finishes the handoff.
  mock.timers.tick(90_000);
  await settle();
  assert.deepEqual(host.calls.slice(1), ['Bug lookup', 'Bug created', 'log reader {"type":"runner","id":"factory-gpu"} odd-deploy-ffffffffffff', 'status Todo']);
  assert.equal(host.status(), 'Todo');

  // A redelivery of a failed event is evaluated again rather than dropped as seen.
  const again = await controlPlane({ issue: 'MET-313', receipt: receipt.replace('f'.repeat(40), '9'.repeat(40)), failOnce: 'Bug lookup' });
  await assert.rejects(again.deliver('evt-2'), /HTTP 503/);
  await again.deliver('evt-2');
  assert.equal(again.status(), 'Todo');
  assert.equal(again.calls.filter(call => call === 'Bug created').length, 1);
});

test('control plane: a failed rollback pages even when its log reader cannot start, says so in the page, and latches escalated before any side effect', async () => {
  const issue = redIssue('e'.repeat(40), 'none');
  const action = nextAction(issue, idle) as Extract<Action, { kind: 'page' }>;
  const { ctx, tools } = pluginContext();
  await page(ctx, issue, action, flakySpawn(true).spawn);
  const slack = tools.find(([tool]) => tool === 'slack_write')?.[1] as { text: string };
  assert.match(slack.text, /log reader not started: Error: runner factory-gpu offline/);
  // MET-348: the latch comment comes first, then the label; each finished step is recorded on the latch.
  assert.deepEqual(tools[0], ['linear.save_comment', { issueId: 'MET-311', body: `odd-escalated reason=failed-rollback pr=- sha=- done=-\n\n${action.detail}` }]);
  assert.deepEqual(tools[1], ['linear.save_issue', { id: 'MET-311', addLabels: ['escalated'] }]);
  assert.deepEqual(tools.at(-1), ['linear.save_comment', { id: 'c-latch', body: `odd-escalated reason=failed-rollback pr=- sha=- done=label,page,archive\n\n${action.detail}` }]);
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

test('sandbox: an interrupted meter resume with a red probe never runs a rollback that may restore an older DB generation; a --no-db-change snapshot still rolls back', async t => {
  // Live meter DB is already v2 (the plan is eligible), but the snapshot came from an older installer that migrated v1 → v2.
  for (const proven of [false, true]) {
    const inFlight = { tag: 'v0.3.0', sha: shas['v0.3.0'], component: 'meter', phase: 'probing' as const, snapshot: '/var/backups/meter/previous-v1-db-changing',
      ...(proven ? { noDbChange: true as const } : {}) };
    const host = world({ ...meterRelease, tags: ['v0.2.9', 'v0.3.0'], ledger: baseline({ inFlight }) });
    t.after(host.cleanup);
    await assert.rejects(main(host.effects), proven ? /health=fail/ : /health=refused rollback=none refusal=db-changing-snapshot/);
    assert.deepEqual(host.calls.filter(call => call.startsWith('plan')), ['plan meter'], 'the plan precedes the resume');
    if (proven) {
      assert.deepEqual(sudoCalls(host.calls), ['sudo deploy/rollback-meter-v1.sh /var/backups/meter/previous-v1-db-changing']);
      continue;
    }
    assert.deepEqual(sudoCalls(host.calls), [], 'no rollback and no install');
    const refused = line(`component=meter sha=${shas['v0.3.0']} health=refused rollback=none refusal=db-changing-snapshot`);
    assert.deepEqual(host.comments, [['MET-364', refused]]);
    assert.deepEqual(host.ledger().inFlight, inFlight, 'recovery state is kept for Devon');
    assert.equal(host.ledger().lastTag, 'v0.2.9');
    assert.equal((deploying(refused) as Extract<Action, { kind: 'page' }>).reason, 'irreversible-action');
  }
});

test('sandbox: the installer rechecks after an eligible plan; a generation change or unsafe DB path in between is a refusal, not a failed rollback', async t => {
  // Real installer output for each drift (deploy/test-install-artifact.py MeterPlanTest): v1, and the DB replaced by a symlink.
  for (const [mode, refusal] of [['v1', 'db-changing-v1'], ['unknown', 'db-changing-unknown']] as const) {
    const host = world({ ...meterRelease, tags: ['v0.2.9', 'v0.3.0'], ledger: baseline() });
    t.after(host.cleanup);
    const sudo = host.effects.sudo;
    host.effects.sudo = (script, args) => {
      if (!args.includes('--no-db-change')) return sudo(script, args);
      host.calls.push(`sudo ${script} ${args.slice(2).join(' ')}`);
      return { ok: false, output: `Artifact meter built at 1111111 matches checkout\nmeter-plan mode=${mode} user_version=${mode === 'v1' ? 1 : 'none'} db_changing=yes\nERROR: Refusing automatic meter install: mode ${mode} changes the DB generation; migration is Devon's explicit manual operation.\nNo deployment changes made; no rollback snapshot exists.\n` };
    };
    await assert.rejects(main(host.effects), /health=refused/);
    const meter = `${host.stateDir}/releases/v0.3.0/meter-linux-x86_64`;
    assert.deepEqual(host.calls.filter(call => /^(plan|sudo)/.test(call)), ['plan meter', `sudo deploy/install-meter.sh --no-db-change ${meter}`]);
    const refused = line(`component=meter sha=${shas['v0.3.0']} health=refused rollback=none refusal=${refusal}`);
    assert.deepEqual(host.comments, [['MET-364', refused]]);
    assert.equal(host.ledger().lastTag, 'v0.2.9');
    assert.equal(host.ledger().receipt?.tag, 'v0.3.0', 'the refusal is held, not completed as a failed release');
    assert.equal(host.ledger().components.meter, undefined);
    const action = deploying(refused) as Extract<Action, { kind: 'page' }>;
    assert.equal(action.reason, 'irreversible-action');
    assert.equal(action.diagnose, undefined, 'no log reader');
  }
  // Control: an installer failure without a refusal plan line is still an ordinary red receipt. Before any
  // change it is `unchanged` (Todo + Bug) only when the meter is still healthy on its captured release;
  // degraded or unavailable beforehand it stays `none` and pages failed-rollback.
  for (const [name, options, rollback] of [['healthy', {}, 'unchanged'], ['degraded', { startDegraded: ['meter'] }, 'none'], ['unavailable', { unreachable: ['meter'] }, 'none']] as const) {
    const red = world({ ...meterRelease, tags: ['v0.2.9', 'v0.3.0'], ledger: baseline(), ...options });
    t.after(red.cleanup);
    const redSudo = red.effects.sudo;
    red.effects.sudo = (script, args) => args.includes('--no-db-change')
      ? (red.calls.push(`sudo ${script}`), { ok: false, output: `${v2Plan}\nERROR: Required command missing: zstd\nNo deployment changes made; no rollback snapshot exists.\n` })
      : redSudo(script, args);
    await assert.rejects(main(red.effects), new RegExp(`health=fail rollback=${rollback}$`), name);
    assert.deepEqual(sudoCalls(red.calls), ['sudo deploy/install-meter.sh'], `${name}: no rollback subprocess`);
    assert.equal(red.live.meter, shas['v0.2.9'], name);
    const fail = line(`component=meter sha=${shas['v0.3.0']} health=fail rollback=${rollback}`);
    assert.deepEqual(red.comments, [['MET-364', fail]], name);
    assert.equal(red.ledger().lastTag, 'v0.3.0', `${name}: a red receipt completes the release`);
    const action = deploying(fail);
    if (rollback === 'none') {
      assert.deepEqual([action.kind, (action as { reason?: string }).reason], ['page', 'failed-rollback'], name);
      continue;
    }
    const todo = action as Extract<Action, { kind: 'set-status' }>;
    assert.deepEqual([todo.kind, todo.status, todo.followUp?.title], ['set-status', 'Todo', 'Deploy failed: meter at 111111111111']);
    assert.deepEqual(todo.diagnose, parseDeployReceipt(fail), 'the log reader still attaches the installer output');
    assert.match(todo.followUp!.body, /refused before changing anything/);
    assert.doesNotMatch(`${todo.reason}\n${todo.followUp!.body}`, /rolled back/);
  }
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
  assert.deepEqual(tools.find(([tool]) => tool === 'linear.save_issue'), ['linear.save_issue', { id: 'MET-364', addLabels: ['escalated'] }]);
  assert.match(String(tools.at(-1)?.[1].body), /^odd-escalated reason=irreversible-action pr=- sha=1{40} done=label,page,archive\n/);
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

test('sandbox: a Cargo.lock-only release installs and probes meter, factory-api and kiosk instead of posting component=none; the rerun skips them', async t => {
  const changes = { 'v0.3.0': ['Cargo.lock'] };
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes, issues: { 'v0.3.0': ['MET-301'] }, ledger: baseline() });
  t.after(host.cleanup);
  await main(host.effects);
  const dir = `${host.stateDir}/releases/v0.3.0`;
  assert.deepEqual(sudoCalls(host.calls), [
    `sudo deploy/install-meter.sh --no-db-change ${dir}/meter-linux-x86_64`,
    `sudo deploy/install-factory-api.sh ${dir}/factory-api-linux-x86_64`,
    `sudo deploy/install-kiosk.sh ${dir}/kiosk`,
  ]);
  assert.equal(host.calls.filter(call => call === 'probe').length, 3 + 3 * (1 + 3), 'three baseline reads, then each component\'s pre-install identity and window');
  assert.deepEqual(host.live, { meter: shas['v0.3.0'], 'factory-api': shas['v0.3.0'], kiosk: shas['v0.3.0'] });
  assert.deepEqual(host.comments, [['MET-301', line(`component=meter+factory-api+kiosk sha=${shas['v0.3.0']} health=pass rollback=none`)]]);
  // Already installed at this SHA: a rerun of the same release installs nothing more.
  const rerun = world({ tags: ['v0.2.9', 'v0.3.0'], changes, live: host.live, ledger: { ...host.ledger(), lastTag: 'v0.2.9' } });
  t.after(rerun.cleanup);
  await main(rerun.effects);
  assert.deepEqual(sudoCalls(rerun.calls), []);
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

// --- Delayed recipients and receipt reconciliation (MET-353).

const DAY = 24 * 60 * 60_000;
const kioskAt = (tag: Tag) => line(`component=kiosk sha=${shas[tag]} health=pass rollback=none`);
const mergeLine = (pr: number, merge: string) => `odd-merge pr=${pr} head=${'d'.repeat(40)} merge=${merge} release=none`;
const verifyFail = (tag: Tag) => `odd-verify sha=${shas[tag]} result=fail bug=MET-900`;
const merged = (pr: number, merge: string, extra: Partial<{ title: string; headRefName: string; body: string }> = {}) =>
  ({ number: pr, title: `MET-${pr}: change`, headRefName: `met-${pr}-change`, body: `closes MET-${pr}`, mergeCommit: { oid: merge }, mergedAt: '2026-10-20T00:00:00Z', ...extra });
const issueComments = (host: ReturnType<typeof world>, issue: string) => host.comments.filter(([id]) => id === issue).map(([, body]) => body);
const decisions = (host: ReturnType<typeof world>, decision: string) => host.logs.filter(([name]) => name === decision).map(([, details]) => details);
/** What the control plane does next from the issue's own comments, through the authoritative derivation. */
const lifecycleOf = async (host: ReturnType<typeof world>, issue: string) =>
  nextAction(toSnapshot({ issue: { id: issue, status: 'Deploying', labels: ['odd'], comments: await host.effects.linear.comments(issue) } }), idle);

test('sandbox: a recipient not yet Deploying stays pending across later releases and gets exactly one receipt once it is, through a lost response, with no repeated install', async t => {
  const tags: Tag[] = ['v0.2.9', 'v0.3.0'];
  const notDeploying = ['MET-302'];
  const options = { tags, notDeploying, changes: { 'v0.3.0': ['kiosk/src/App.tsx'], 'v0.3.1': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-301', 'MET-302'], 'v0.3.1': ['MET-303'] } };
  const host = world({ ...options, ledger: baseline() });
  t.after(host.cleanup);
  await main(host.effects);
  const since = new Date(host.clock.now).toISOString();
  assert.deepEqual(host.comments, [['MET-301', kioskAt('v0.3.0')]]);
  assert.deepEqual(host.ledger().deliveries, [{ issue: 'MET-302', tag: 'v0.3.0', line: kioskAt('v0.3.0'), since }], 'retained, never marked delivered');
  assert.equal(host.ledger().lastTag, 'v0.3.0', 'a pending recipient never holds the release');
  // A later release ships without waiting for it; the recipient keeps its release and first-seen time.
  host.clock.now += 3 * DAY;
  tags.push('v0.3.1');
  await main(host.effects);
  assert.deepEqual(host.comments, [['MET-301', kioskAt('v0.3.0')], ['MET-303', kioskAt('v0.3.1')]]);
  assert.deepEqual(host.ledger().deliveries, [{ issue: 'MET-302', tag: 'v0.3.0', line: kioskAt('v0.3.0'), since }]);
  assert.equal(host.ledger().lastTag, 'v0.3.1');
  // It reaches Deploying on a tick with no new release; Linear stores the comment but the response is lost.
  notDeploying.length = 0;
  const lost = world({ ...options, ledger: host.ledger(), comments: host.comments, lostComment: 'MET-302', deploying: ['MET-301', 'MET-302', 'MET-303'] });
  t.after(lost.cleanup);
  await assert.rejects(main(lost.effects), /timed out/);
  assert.deepEqual(lost.ledger().deliveries?.map(delivery => delivery.issue), ['MET-302'], 'a crashed delivery keeps the recipient');
  // The restarted job finds the stored comment: dropped, never posted twice, and reconciliation adds nothing.
  for (let tick = 0; tick < 2; tick++) {
    const rerun = world({ ...options, ledger: lost.ledger(), comments: lost.comments, deploying: ['MET-301', 'MET-302', 'MET-303'] });
    t.after(rerun.cleanup);
    await main(rerun.effects);
    assert.deepEqual(issueComments(rerun, 'MET-302'), [kioskAt('v0.3.0')], 'exactly one receipt');
    assert.deepEqual(rerun.comments.length, 3);
    assert.deepEqual(rerun.ledger().deliveries, []);
    assert.deepEqual(sudoCalls(rerun.calls), []);
    assert.deepEqual(rerun.calls.filter(call => call.startsWith('verify') || call.startsWith('checkout')), []);
    assert.deepEqual(await lifecycleOf(rerun, 'MET-302'), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify kiosk at 111111111111', round: 1 });
  }
  assert.deepEqual(sudoCalls([...host.calls, ...lost.calls]), [`sudo deploy/install-kiosk.sh ${host.stateDir}/releases/v0.3.0/kiosk`, `sudo deploy/install-kiosk.sh ${host.stateDir}/releases/v0.3.1/kiosk`]);
});

test('sandbox: a pending recipient a later release ships again keeps one entry; it expires after seven days with a diagnostic and no receipt', async t => {
  const tags: Tag[] = ['v0.2.9', 'v0.3.0'];
  const host = world({ tags, notDeploying: ['MET-302'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'], 'v0.3.1': ['docs/x.md'] }, issues: { 'v0.3.0': ['MET-302'], 'v0.3.1': ['MET-302'] }, ledger: baseline() });
  t.after(host.cleanup);
  await main(host.effects);
  const since = new Date(host.clock.now).toISOString();
  host.clock.now += DAY;
  tags.push('v0.3.1');
  await main(host.effects);
  const v301 = line(`component=none sha=${shas['v0.3.1']} health=pass rollback=none`);
  assert.deepEqual(host.ledger().deliveries, [{ issue: 'MET-302', tag: 'v0.3.1', line: v301, since }], 'superseded by the newer receipt, first seen unchanged');
  host.clock.now = Date.parse(since) + 7 * DAY - 1;
  await main(host.effects);
  assert.equal(host.ledger().deliveries?.length, 1, 'still retried just inside the window');
  host.clock.now += 1;
  await main(host.effects);
  assert.deepEqual(host.ledger().deliveries, []);
  assert.deepEqual(decisions(host, 'receipt-expired'), [{ issue: 'MET-302', tag: 'v0.3.1', line: v301, since, reason: 'not Deploying within seven days of release; no receipt was delivered' }]);
  assert.deepEqual(host.comments, [], 'expired, never called delivered');
  assert.deepEqual(decisions(host, 'receipt').filter(details => details.issue === 'MET-302'), []);
  assert.equal(sudoCalls(host.calls).length, 1);
});

test('sandbox: bootstrap and failed-verification recovery: the next proven release receipts every Deploying issue it contains, once, without reinstalling', async t => {
  const tags: Tag[] = ['v0.2.9', 'v0.3.0'];
  const host = world({ tags, ledger: undefined, live: Object.fromEntries(recipes.map(recipe => [recipe.name, shas['v0.3.0']])),
    changes: { 'v0.3.0': ['kiosk/src/App.tsx'], 'v0.3.1': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.1': ['MET-301'] },
    deploying: ['MET-300', 'MET-301', 'MET-305'], prs: [merged(300, shas['v0.3.0']), merged(305, shas['v0.2.9'])],
    comments: [['MET-300', mergeLine(300, shas['v0.3.0'])], ['MET-305', mergeLine(305, shas['v0.2.9'])],
      ['MET-305', line(`component=kiosk sha=${shas['v0.2.9']} health=pass rollback=none`)], ['MET-305', verifyFail('v0.2.9')]] });
  t.after(host.cleanup);
  await bootstrap(host.effects, 'v0.3.0');
  await main(host.effects);
  assert.equal(host.comments.length, 4, 'an adopted release is no proven deployment: no historical receipt');
  assert.deepEqual(decisions(host, 'reconcile-skipped'), [{ reason: 'no pass release recorded by this deployer yet' }]);
  tags.push('v0.3.1');
  await main(host.effects);
  assert.deepEqual(sudoCalls(host.calls), [`sudo deploy/install-kiosk.sh ${host.stateDir}/releases/v0.3.1/kiosk`]);
  for (const issue of ['MET-300', 'MET-301']) assert.deepEqual(issueComments(host, issue).filter(body => body.startsWith('odd-deploy')), [kioskAt('v0.3.1')], issue);
  assert.deepEqual(issueComments(host, 'MET-305').at(-1), kioskAt('v0.3.1'));
  for (const issue of ['MET-300', 'MET-305']) assert.deepEqual(await lifecycleOf(host, issue), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify kiosk at 222222222222', round: 1 }, issue);
  // Ticks with no new release add nothing: no comment, verify, checkout or install.
  const count = host.comments.length;
  const calls = host.calls.length;
  await main(host.effects);
  await main(host.effects);
  assert.equal(host.comments.length, count);
  assert.deepEqual(host.calls.slice(calls).filter(call => !call.startsWith('gh pr list')), []);
});

test('sandbox: a no-new-release tick routes branch-, body- and edited-subject-owned work and failed verifications to the proven release, refusing unrelated or unproven ancestry', async t => {
  const v290 = line(`component=kiosk sha=${shas['v0.2.50']} health=pass rollback=none`);
  const issues = {
    'MET-310': { prs: [merged(310, shas['v0.2.50'])], comments: [mergeLine(310, shas['v0.2.50'])] }, // edited squash subject: no `(#310)`
    'MET-311': { prs: [merged(311, shas['v0.2.50'], { body: 'Fixes the kiosk.' })], comments: [] }, // branch-only, merged by hand
    'MET-312': { prs: [merged(900, shas['v0.2.50'], { title: 'MET-900: other', headRefName: 'met-900-other', body: 'closes MET-900\nNoticed while fixing MET-312.' })], comments: [] },
    'MET-313': { prs: [merged(313, 'e'.repeat(40))], comments: [] }, // merge commit unknown here
    'MET-314': { prs: [merged(314, shas['v0.3.1'])], comments: [mergeLine(314, shas['v0.3.1'])] }, // not deployed yet
    'MET-315': { prs: [merged(315, shas['v0.2.50'])], comments: [mergeLine(315, shas['v0.3.0'])] }, // merge receipt disagrees with GitHub
    'MET-316': { prs: [merged(316, shas['v0.2.50'])], comments: [mergeLine(999, shas['v0.2.50'])] }, // merge receipt names another PR
    'MET-320': { prs: [merged(320, shas['v0.2.50'])], comments: [mergeLine(320, shas['v0.2.50']), v290, verifyFail('v0.2.50')] },
    'MET-321': { prs: [merged(321, shas['v0.3.0'])], comments: [mergeLine(321, shas['v0.3.0']), kioskAt('v0.3.0'), verifyFail('v0.3.0')] },
    'MET-322': { prs: [merged(322, shas['v0.2.50'])], comments: [mergeLine(322, shas['v0.2.50']), kioskAt('v0.3.1'), verifyFail('v0.3.1')] },
    'MET-323': { prs: [merged(323, shas['v0.2.50'])], comments: [mergeLine(323, shas['v0.2.50']), v290] }, // awaiting its verifier
    'MET-324': { prs: [merged(324, shas['v0.3.0'])], comments: [mergeLine(324, shas['v0.2.50']), v290, mergeLine(324, shas['v0.3.0'])] }, // re-merged
  };
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: {}, lostComment: 'MET-310', deploying: Object.keys(issues),
    ledger: baseline({ lastTag: 'v0.3.0', deployed: { tag: 'v0.3.0', sha: shas['v0.3.0'], line: kioskAt('v0.3.0') } }),
    prs: Object.values(issues).flatMap(issue => issue.prs), comments: Object.entries(issues).flatMap(([id, issue]) => issue.comments.map(body => [id, body] as [string, string])) });
  t.after(host.cleanup);
  const before = Object.fromEntries(Object.keys(issues).map(id => [id, issueComments(host, id)]));
  await assert.rejects(main(host.effects), /timed out/);
  await main(host.effects);
  const receipted = ['MET-310', 'MET-311', 'MET-320', 'MET-324'];
  for (const id of Object.keys(issues)) {
    assert.deepEqual(issueComments(host, id), receipted.includes(id) ? [...before[id], kioskAt('v0.3.0')] : before[id], id);
  }
  assert.deepEqual(Object.fromEntries(decisions(host, 'reconcile-refused').map(details => [details.issue, details.reason])), {
    'MET-312': 'no merged PR owns MET-312',
    'MET-313': `merge ${'e'.repeat(40)} is not proven to be in v0.3.0`,
    'MET-314': `merge ${shas['v0.3.1']} is not proven to be in v0.3.0`,
    'MET-315': `PR #315 merged ${shas['v0.2.50']}, not the odd-merge commit ${shas['v0.3.0']}`,
    'MET-316': 'odd-merge PR #999 is not a merged PR that owns MET-316',
    'MET-321': `failed verification at ${shas['v0.3.0']} has no later proven deployment`,
    'MET-322': `failed verification at ${shas['v0.3.1']} has no later proven deployment`,
  });
  for (const id of receipted) assert.deepEqual(await lifecycleOf(host, id), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify kiosk at 111111111111', round: 1 }, id);
  assert.deepEqual(host.calls.filter(call => !call.startsWith('gh pr list')), [], 'no verify, checkout, probe or install');
  const count = host.comments.length;
  await main(host.effects);
  assert.equal(host.comments.length, count, 'idempotent from the issues\' own comments');
});

test('pending releases are immutable v-tags newer than the ledger, oldest first; a missing or cursorless ledger is never silently adopted', async t => {
  assert.deepEqual(pendingTags(['v0.2.10', 'v0.2.9', 'latest', 'v0.3.0', 'v0.2.8-rc1'], 'v0.2.9'), ['v0.2.10', 'v0.3.0']);
  assert.deepEqual(pendingTags(['v0.2.9'], 'v0.2.9'), []);
  for (const ledger of [undefined, emptyLedger()]) {
    const host = world({ tags: ['v0.2.9', 'v0.3.0'], changes: { 'v0.3.0': ['kiosk/src/App.tsx'] }, ledger });
    t.after(host.cleanup);
    await assert.rejects(main(host.effects), /Deploy ledger .* (is missing|has no valid lastTag and components); not deploying\. .*--bootstrap TAG/);
    assert.equal(host.exists(), ledger !== undefined);
    if (ledger) assert.deepEqual(host.ledger(), emptyLedger());
    assert.deepEqual(host.calls, []);
    assert.deepEqual(host.comments, []);
  }
  assert.equal(resume({ tag: 'v', sha, component: 'kiosk', phase: 'probing' }, 'fail'), 'rollback');
  assert.equal(resume({ tag: 'v', sha, component: 'kiosk', phase: 'installing' }, 'fail'), 'reinstall');
});

// --- Explicit bootstrap (MET-362): an absent ledger is adopted only on request, never by the job.

test('bootstrap: an absent ledger adopts one healthy published release without installing or historical receipts, then deploys forward only', async t => {
  const tags: Tag[] = ['v0.2.9', 'v0.3.0'];
  const host = world({ tags, ledger: undefined, live: Object.fromEntries(recipes.map(recipe => [recipe.name, shas['v0.3.0']])),
    changes: { 'v0.3.0': ['kiosk/src/App.tsx'], 'v0.3.1': ['kiosk/src/App.tsx'] }, issues: { 'v0.3.0': ['MET-300'], 'v0.3.1': ['MET-301'] } });
  t.after(host.cleanup);
  await bootstrap(host.effects, 'v0.3.0');
  assert.deepEqual(host.ledger(), { lastTag: 'v0.3.0', components: {} }, 'a cursor only: no invented component health');
  assert.deepEqual(host.calls, Array(9).fill('probe'), 'three healthy probes per component; no verify, checkout or installer');
  assert.deepEqual(host.comments, []);
  // Repeated invocation (a lost acknowledgement or a second operator) never replaces the baseline.
  for (const tag of ['v0.3.0', 'v0.2.9']) await assert.rejects(bootstrap(host.effects, tag), /already exists; bootstrap never overwrites it/);
  assert.deepEqual(host.ledger(), { lastTag: 'v0.3.0', components: {} });
  await main(host.effects);
  assert.deepEqual(sudoCalls(host.calls), []);
  assert.deepEqual(host.comments, [], 'no receipt for the adopted release');
  tags.push('v0.3.1');
  await main(host.effects);
  assert.deepEqual(sudoCalls(host.calls), [`sudo deploy/install-kiosk.sh ${host.stateDir}/releases/v0.3.1/kiosk`]);
  assert.deepEqual(host.comments, [['MET-301', line(`component=kiosk sha=${shas['v0.3.1']} health=pass rollback=none`)]]);
  assert.equal(host.ledger().lastTag, 'v0.3.1');
});

test('bootstrap refuses malformed, unpublished or off-main tags, mixed or unhealthy identities and existing or unreadable state, writing nothing', async t => {
  type Host = ReturnType<typeof world>;
  const probeWith = (override: object, only?: string) => (host: Host) => {
    const probe = host.effects.probe;
    host.effects.probe = url => !only || url === only ? JSON.stringify({ ...JSON.parse(probe(url)), ...override }) : probe(url);
  };
  const readFails = (error: Error) => (host: Host) => { host.effects.readLedger = () => { throw error; }; };
  const refusals: [string, string, RegExp, (host: Host) => void][] = [
    ['malformed', 'latest', /vX\.Y\.Z release tag/, () => {}],
    ['prerelease', 'v0.3.0-rc1', /vX\.Y\.Z release tag/, () => {}],
    ['unpublished', 'v0.3.1', /v0\.3\.1 is not a published stable release/, () => {}],
    ['off main', 'v0.3.0', /merge-base --is-ancestor/, host => {
      const run = host.effects.run;
      host.effects.run = (command, args, options) => {
        if (args.includes('merge-base')) throw new Error(`git ${args.join(' ')} exited 1`);
        return run(command, args, options);
      };
    }],
    ['mixed identities', 'v0.3.0', /Refusing bootstrap at v0\.3\.0: kiosk not healthy/, host => { host.live.kiosk = shas['v0.2.9']; }],
    ['newer identity', 'v0.3.0', /: meter not healthy/, host => { host.live.meter = shas['v0.3.1']; }],
    ['dirty', 'v0.3.0', /: meter, factory-api, kiosk not healthy/, probeWith({ git_dirty: true })],
    ['degraded', 'v0.3.0', /: factory-api not healthy/, probeWith({ status: 'degraded' }, recipes[1].health)],
    ['unreachable', 'v0.3.0', /: factory-api not healthy/, host => {
      const probe = host.effects.probe;
      host.effects.probe = url => { if (url === recipes[1].health) throw new Error('curl: (7) Failed to connect'); return probe(url); };
    }],
    ['existing ledger', 'v0.3.0', /already exists/, host => host.effects.writeLedger(baseline())],
    ['existing cursorless ledger', 'v0.3.0', /already exists/, host => host.effects.writeLedger(emptyLedger())],
    ['corrupt ledger', 'v0.3.0', /Unexpected end of JSON/, readFails(new SyntaxError('Unexpected end of JSON input'))],
    ['unreadable ledger', 'v0.3.0', /EACCES/, readFails(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))],
  ];
  for (const [name, tag, error, alter] of refusals) {
    const host = world({ tags: ['v0.2.9', 'v0.3.0'], ledger: undefined, changes: {},
      live: Object.fromEntries(recipes.map(recipe => [recipe.name, shas['v0.3.0']])) });
    t.after(host.cleanup);
    alter(host);
    const before = host.exists() ? host.ledger() : undefined;
    const write = host.effects.writeLedger;
    let writes = 0;
    host.effects.writeLedger = (ledger, options) => { writes++; write(ledger, options); };
    await assert.rejects(bootstrap(host.effects, tag), error, name);
    assert.equal(writes, 0, name);
    assert.equal(host.exists(), before !== undefined, name);
    if (before) assert.deepEqual(host.ledger(), before, name);
    assert.deepEqual(sudoCalls(host.calls), [], name);
    assert.deepEqual(host.comments, [], name);
  }
  // A ledger created while the probes ran (another writer) is kept: the exclusive create fails.
  const host = world({ tags: ['v0.2.9', 'v0.3.0'], ledger: undefined, changes: {}, live: Object.fromEntries(recipes.map(recipe => [recipe.name, shas['v0.3.0']])) });
  t.after(host.cleanup);
  const probe = host.effects.probe;
  host.effects.probe = url => { if (!host.exists()) host.effects.writeLedger(baseline()); return probe(url); };
  await assert.rejects(bootstrap(host.effects, 'v0.3.0'), /EEXIST/);
  assert.deepEqual(host.ledger(), baseline());
});

/** The real CLI with HOME relocating the ledger; stub gh, git, sudo, curl, python3 and tar record every call. */
const deployCli = new URL('./deploy.ts', import.meta.url).pathname;
function cliHost(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'odd-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  const state = join(home, '.local/state/factory-odd');
  for (const path of [bin, state]) mkdirSync(path, { recursive: true });
  const record = join(home, 'calls');
  for (const name of ['gh', 'git', 'sudo', 'curl', 'python3', 'tar']) {
    writeFileSync(join(bin, name), `#!/bin/bash
printf '%s\\n' "${name} $*" >> '${record}'
exit 1
`, { mode: 0o755 });
  }
  const run = (args: string[] = []) => spawnSync(process.execPath, [deployCli, ...args], { encoding: 'utf8', env: { HOME: home, PATH: bin } });
  const calls = () => existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
  return { home, bin, state, ledger: join(state, 'deploy.json'), run, calls };
}

test('real CLI: a missing, corrupt, invalid-shape or unreadable ledger exits nonzero before any remote read, sudo or ledger write; a valid ledger still runs', t => {
  const root = process.getuid?.() === 0;
  const cases: { name: string; content?: string; directory?: boolean; unreadable?: boolean; error: RegExp }[] = [
    { name: 'missing', error: /is missing/ },
    { name: 'corrupt', content: '{"lastTag": "v0.2.9", "compo', error: /is unreadable \(.*JSON/ },
    { name: 'empty', content: '', error: /is unreadable \(.*JSON/ },
    ...['null', '[]', '"v0.2.9"', '{"components":{}}', '{"lastTag":"latest","components":{}}', '{"lastTag":"v0.2.9"}', '{"lastTag":"v0.2.9","components":[]}']
      .map(content => ({ name: `shape ${content}`, content, error: /has no valid lastTag and components/ })),
    { name: 'directory', directory: true, error: /is unreadable \(EISDIR/ },
    // root reads mode 0000; the in-process EACCES refusal above still covers it there.
    ...(root ? [] : [{ name: 'permission', content: '{"lastTag":"v0.2.9","components":{}}', unreadable: true, error: /is unreadable \(EACCES/ }]),
  ];
  for (const { name, content, directory, unreadable, error } of cases) {
    const host = cliHost(t);
    if (directory) mkdirSync(host.ledger);
    if (content !== undefined) writeFileSync(host.ledger, content);
    if (unreadable) chmodSync(host.ledger, 0o000);
    const result = host.run();
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, error, name);
    assert.match(result.stderr, /not deploying\. Investigate \(docs\/odd\/deployer-recovery\.md\); .*`deploy\.ts --bootstrap TAG`/, name);
    assert.deepEqual(host.calls(), [], `${name}: no gh, git, curl, release download or sudo`);
    if (unreadable) chmodSync(host.ledger, 0o600);
    if (content !== undefined) assert.equal(readFileSync(host.ledger, 'utf8'), content, `${name}: byte-for-byte preserved`);
    assert.deepEqual(readdirSync(host.state), content !== undefined || directory ? ['deploy.json'] : [], `${name}: no ledger created`);
  }
  // Control: the same live ledger read accepts an established file. Only the release listing is
  // faked (gh runs in ROOT, which fixtures lack); nothing is pending, so nothing else runs.
  const host = cliHost(t);
  const ledger = '{"lastTag":"v0.2.9","components":{}}\n';
  writeFileSync(host.ledger, ledger);
  const releases = JSON.stringify([[{ tag_name: 'v0.2.9', draft: false, prerelease: false }]]);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { liveEffects, main } from ${JSON.stringify(pathToFileURL(deployCli).href)};
const effects = liveEffects();
const run = effects.run;
effects.run = (command, args, options) => command === 'gh' ? { stdout: ${JSON.stringify(releases)}, stderr: '' } : run(command, args, options);
await main(effects);`], { encoding: 'utf8', env: { HOME: host.home, PATH: host.bin } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"decision":"pending","lastTag":"v0.2.9","tags":\[\]/);
  assert.deepEqual(host.calls(), []);
  assert.equal(readFileSync(host.ledger, 'utf8'), ledger);
});

test('real CLI and files: --bootstrap never overwrites an existing or unreadable ledger, rejects malformed tags, and its exclusive create is atomic', t => {
  const host = cliHost(t);
  for (const [content, error] of [['{"lastTag":"v0.2.9","components":{}}\n', /already exists; bootstrap never overwrites it/], ['{"corrupt', /JSON/]] as const) {
    writeFileSync(host.ledger, content);
    for (const tag of ['v0.3.0', 'v0.2.9']) {
      const result = host.run(['--bootstrap', tag]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, error);
      assert.equal(readFileSync(host.ledger, 'utf8'), content);
    }
  }
  rmSync(host.ledger);
  for (const args of [['--bootstrap'], ['--bootstrap', 'latest'], ['--bootstrap', 'v0.3'], ['--bootstrap', 'v0.3.0', 'extra']]) {
    const result = host.run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Usage: deploy\.ts \[--bootstrap TAG \|/);
  }
  assert.deepEqual(host.calls(), []);
  assert.deepEqual(readdirSync(host.state), []);
  // liveEffects' create: link(2) publishes a complete file and refuses to replace one.
  const create = (tag: string) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { liveEffects } from ${JSON.stringify(pathToFileURL(deployCli).href)};
liveEffects().writeLedger({ lastTag: ${JSON.stringify(tag)}, components: {} }, { create: true });`], { encoding: 'utf8', env: { HOME: host.home } });
  const first = create('v0.3.0');
  assert.equal(first.status, 0, first.stderr);
  const created = readFileSync(host.ledger, 'utf8');
  assert.deepEqual(JSON.parse(created), { lastTag: 'v0.3.0', components: {} });
  const second = create('v0.3.1');
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /EEXIST/);
  assert.equal(readFileSync(host.ledger, 'utf8'), created);
  assert.deepEqual(readdirSync(host.state), ['deploy.json'], 'no temporary file left behind');
  // Killed right after link(2), then the next ordinary write is interrupted before its rename:
  // the published baseline must stay byte-for-byte intact (no staging name shares its inode).
  rmSync(host.ledger);
  const instrumented = (fn: string, patch: string, tag: string, create: boolean) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.${fn};
fs.${fn} = (...args) => { ${patch} };
syncBuiltinESMExports();
const { liveEffects } = await import(${JSON.stringify(pathToFileURL(deployCli).href)});
liveEffects().writeLedger({ lastTag: ${JSON.stringify(tag)}, components: {} }, { create: ${create} });`], { encoding: 'utf8', env: { HOME: host.home } });
  const crashed = instrumented('linkSync', 'real(...args); process.exit(77);', 'v0.3.0', true);
  assert.equal(crashed.status, 77, crashed.stderr);
  const baseline = readFileSync(host.ledger, 'utf8');
  assert.deepEqual(JSON.parse(baseline), { lastTag: 'v0.3.0', components: {} });
  const interrupted = instrumented('renameSync', "throw new Error('interrupted before rename');", 'v0.3.1', false);
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.stderr, /interrupted before rename/);
  assert.equal(readFileSync(host.ledger, 'utf8'), baseline);
  assert.equal(create('v0.3.1').status === 0, false, 'a retried create still refuses the published baseline');
  assert.equal(readFileSync(host.ledger, 'utf8'), baseline);
});
