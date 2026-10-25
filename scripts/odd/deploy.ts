#!/usr/bin/env node
// Outcome driven development, Deployer (docs/odd/README.md §4, §5.2). factory-deploy.timer runs
// this as `agent` on factory-gpu every 2 minutes, one run at a time (flock in the unit). No model:
// every published release newer than the ledger is verified, a separate source worktree is
// detached at its SHA, each enabled component whose inputs changed is installed through the sudoers
// allowlist, probed three times for the exact release SHA, rolled back once when red (and
// re-probed: the rollback counts only when the previous release is back and healthy), and every
// Deploying issue the release ships gets one `odd-deploy` receipt. The control plane turns the
// receipt into Done, Todo + Bug, or a page (scripts/odd/lifecycle.ts).
//
// Pure planning (`plan`, `pendingTags`, `issuesFromSubjects`, `parseSnapshot`, `healthySha`,
// `probeResult`, `restoredResult`, `receiptLine`, `resume`) is exported for tests; effects go
// through `Effects` so the sandbox fixture fakes sudo, curl, git, the release download and Linear.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = '/home/agent/work/factory';
export const HOST = 'factory-gpu';
export const STATE_DIR = join(homedir(), '.local/state/factory-odd');
export const LEDGER = join(STATE_DIR, 'deploy.json');
export const PROBES = 3;
export const PROBE_GAP_MS = 20_000;
export const LINEAR_KEY_FILE = '/etc/factory-dispatch/linear-api-key';

export type Recipe = {
  name: string;
  /** Deploy inputs beyond the component's `sources` in deploy/components.json. */
  deployFiles: readonly string[];
  /** Installer argument from the verified release directory. */
  artifact: (releaseDir: string) => string;
  installer: string;
  /** Restores the installer's snapshot. */
  rollback: string;
  /** Health endpoint reporting `git_sha`. */
  health: string;
};

/** Auto-deploy set settled by Devon 2026-10-24, in install order. The dispatcher's installer needs
 * a console runner list on stdin and retires in phase 7; usage waits for a rollback that restores
 * the previous timer (deploy/rollback-usage.sh removes it); pricing, ups, alerts, backup, reboot
 * and nut stay human-only (deploy/components.json). */
export const recipes: readonly Recipe[] = [
  { name: 'meter', deployFiles: ['deploy/install-meter.sh', 'deploy/meter.service'], artifact: dir => join(dir, 'meter-linux-x86_64'),
    installer: 'deploy/install-meter.sh', rollback: 'deploy/rollback-meter-v1.sh',
    health: 'http://127.0.0.1:11434/meter/health' },
  { name: 'factory-api', deployFiles: ['deploy/install-factory-api.sh', 'deploy/factory-api.service'], artifact: dir => join(dir, 'factory-api-linux-x86_64'),
    installer: 'deploy/install-factory-api.sh', rollback: 'deploy/rollback-factory-api.sh',
    health: 'http://127.0.0.1:8080/v1/health' },
  { name: 'kiosk', deployFiles: ['deploy/install-kiosk.sh'], artifact: dir => join(dir, 'kiosk'),
    installer: 'deploy/install-kiosk.sh', rollback: 'deploy/rollback-kiosk.sh',
    health: 'http://127.0.0.1:8080/version.json' },
];

export type ComponentRecord = { sha: string; tag: string; health: 'pass' | 'fail'; snapshot?: string };
export type InFlight = { tag: string; sha: string; component: string; phase: 'installing' | 'probing'; snapshot?: string };
/** A release's receipt, saved before delivery so a crashed delivery resumes without redeploying. `delivered` lists issues already handled. */
export type PendingReceipt = { tag: string; receipt: Receipt; delivered: string[] };
export type Ledger = { lastTag?: string; components: Record<string, ComponentRecord>; inFlight?: InFlight; receipt?: PendingReceipt };

export const semver = (tag: string): [number, number, number] | undefined => {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};
const compareTags = (a: string, b: string) => {
  const [x, y] = [semver(a)!, semver(b)!];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Immutable `vX.Y.Z` tags newer than the ledger's last handled tag, oldest first. */
export function pendingTags(tags: readonly string[], lastTag: string | undefined): string[] {
  return tags.filter(tag => semver(tag) && (!lastTag || compareTags(tag, lastTag) > 0)).sort(compareTags);
}

/** Issues a release ships: `(#N)` squash subjects → PR bodies' `closes|contributes MET-n` lines. */
export function issuesFromSubjects(subjects: readonly string[], prBody: (pr: number) => string): string[] {
  const issues = new Set<string>();
  for (const subject of subjects) {
    const pr = /\(#(\d+)\)\s*$/.exec(subject);
    if (!pr) continue;
    for (const line of prBody(Number(pr[1])).matchAll(/^\s*(?:closes|contributes)\s+(MET-\d+)\b/gim)) issues.add(line[1].toUpperCase());
  }
  return [...issues];
}

/** Snapshot path an installer printed (`Rollback snapshot:` on the way in, `Snapshot:` from the kiosk ERR trap). */
export function parseSnapshot(output: string): string | undefined {
  const paths = [...output.matchAll(/^(?:Rollback snapshot|Snapshot): (\/\S+)/gm)].map(match => match[1].replace(/\.$/, ''));
  return paths.at(-1);
}

/** The SHA a healthy body reports (7-char local or full release builds): status ok when present, not dirty. */
export function healthySha(body: string): string | undefined {
  let json: Record<string, unknown>;
  try { json = JSON.parse(body) as Record<string, unknown>; } catch { return undefined; }
  const reported = typeof json.git_sha === 'string' ? json.git_sha : '';
  if (!/^[0-9a-f]{7,40}$/.test(reported) || json.git_dirty === true) return undefined;
  return 'status' in json && json.status !== 'ok' ? undefined : reported;
}

/** A probe passes when a healthy body reports the release SHA. */
export function probeResult(sha: string, body: string): 'pass' | 'fail' {
  const reported = healthySha(body);
  return reported && sha.startsWith(reported) ? 'pass' : 'fail';
}

/** After a rollback the component must be healthy on a release other than the one rolled back. */
export function restoredResult(sha: string, body: string): 'pass' | 'fail' {
  const reported = healthySha(body);
  return reported && !sha.startsWith(reported) ? 'pass' : 'fail';
}

export type Receipt = { component: string; sha: string; health: 'pass' | 'fail'; rollback: string };
export const receiptLine = (receipt: Receipt) =>
  `odd-deploy host=${HOST} component=${receipt.component} sha=${receipt.sha} health=${receipt.health} rollback=${receipt.rollback}`;

/**
 * Components to install for a release, in recipe order: enabled recipes whose sources or deploy
 * files changed since their baseline, skipping ones the ledger already records healthy at this
 * SHA. `changedSince(baseline)` lists the paths that changed in (baseline, release]; a component
 * with no baseline (never deployed, no health SHA) installs. A killed run's in-flight component
 * is resumed before planning (installRelease).
 */
export function plan(input: {
  sha: string;
  sources: Record<string, readonly string[]>;
  baselines: Record<string, string | undefined>;
  ledger: Ledger;
  changedSince: (baseline: string) => readonly string[];
}): Recipe[] {
  return recipes.filter(recipe => {
    const record = input.ledger.components[recipe.name];
    if (record?.sha === input.sha && record.health === 'pass') return false;
    const baseline = input.baselines[recipe.name];
    if (!baseline) return true;
    const inputs = [...(input.sources[recipe.name] ?? []), ...recipe.deployFiles];
    return input.changedSince(baseline).some(path => inputs.some(prefix => path === prefix || path.startsWith(`${prefix}/`)));
  });
}

/** What a run killed mid-component does first: a green probe means the install landed (no second install). */
export function resume(inFlight: InFlight, probe: 'pass' | 'fail'): 'installed' | 'rollback' | 'reinstall' {
  if (probe === 'pass') return 'installed';
  return inFlight.phase === 'probing' ? 'rollback' : 'reinstall';
}

export type Effects = {
  /** Holds the ledger's release directories (`releases/<tag>`) and inventories. */
  stateDir: string;
  log: (decision: string, details?: object) => void;
  sleep: (ms: number) => Promise<void>;
  /** Run a command; non-zero exit throws with stdout+stderr in the message. */
  run: (command: string, args: readonly string[], options?: { cwd?: string }) => { stdout: string; stderr: string };
  /** Exit status 0? For git predicates such as merge-base --is-ancestor. */
  ok: (command: string, args: readonly string[]) => boolean;
  /** `sudo -n /usr/bin/bash <ROOT>/<script> args...`; returns combined output, `ok` false on non-zero exit. */
  sudo: (script: string, args: readonly string[]) => { ok: boolean; output: string };
  /** GET a health endpoint; throws when unreachable. */
  probe: (url: string) => string;
  readLedger: () => Ledger;
  writeLedger: (ledger: Ledger) => void;
  linear: {
    deploying: (identifier: string) => Promise<boolean>;
    /** Does the issue already carry a comment whose body is exactly `body`? */
    posted: (identifier: string, body: string) => Promise<boolean>;
    comment: (identifier: string, body: string) => Promise<void>;
  };
};

export const emptyLedger = (): Ledger => ({ components: {} });

/** Newest of the candidate baselines: a hand install after a ledger entry moves the baseline forward. */
function newest(effects: Effects, candidates: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!best || effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', best, candidate])) best = candidate;
  }
  effects.log('baseline', { candidates: candidates.filter(Boolean), chosen: best });
  return best;
}

/** The commit a healthy endpoint reports; a degraded, dirty or unreachable one is no baseline. */
function healthSha(effects: Effects, recipe: Recipe): string | undefined {
  try {
    const reported = healthySha(effects.probe(recipe.health));
    return reported && effects.run('git', ['-C', ROOT, 'rev-parse', '--verify', `${reported}^{commit}`]).stdout.trim();
  } catch { return undefined; }
}

async function probeWindow(effects: Effects, recipe: Recipe, sha: string, check = probeResult, event = 'probe'): Promise<'pass' | 'fail'> {
  for (let attempt = 1; attempt <= PROBES; attempt++) {
    let body = '';
    try { body = effects.probe(recipe.health); } catch (error) { body = String(error); }
    const result = check(sha, body);
    effects.log(event, { component: recipe.name, attempt, result });
    if (result === 'fail') return 'fail';
    if (attempt < PROBES) await effects.sleep(PROBE_GAP_MS);
  }
  return 'pass';
}

/** Run the rollback once, then re-probe: the snapshot when the previous release is back and healthy, else `none`. */
async function rollback(effects: Effects, recipe: Recipe, sha: string, snapshot: string | undefined): Promise<string> {
  if (!snapshot) { effects.log('rollback-missing-snapshot', { component: recipe.name }); return 'none'; }
  const result = effects.sudo(recipe.rollback, [snapshot]);
  effects.log('rollback', { component: recipe.name, ok: result.ok, snapshot });
  if (!result.ok) return 'none';
  return (await probeWindow(effects, recipe, sha, restoredResult, 'rollback-probe')) === 'pass' ? snapshot : 'none';
}

/** Install, probe, roll back once on red. Returns the receipt for this component. */
export async function deployComponent(effects: Effects, recipe: Recipe, tag: string, sha: string, releaseDir: string): Promise<Receipt> {
  const ledger = effects.readLedger();
  let snapshot: string | undefined;
  let needInstall = true;
  const inFlight = ledger.inFlight;
  if (inFlight && inFlight.sha === sha && inFlight.component === recipe.name) {
    const action = resume(inFlight, await probeWindow(effects, recipe, sha));
    effects.log('resume', { component: recipe.name, phase: inFlight.phase, action });
    snapshot = inFlight.snapshot;
    if (action === 'installed') needInstall = false;
    if (action === 'rollback') return finish(effects, recipe, tag, sha, { component: recipe.name, sha, health: 'fail', rollback: await rollback(effects, recipe, sha, snapshot) }, snapshot);
  }
  if (needInstall) {
    effects.writeLedger({ ...ledger, inFlight: { tag, sha, component: recipe.name, phase: 'installing' } });
    const install = effects.sudo(recipe.installer, ['--source-checkout', join(effects.stateDir, 'source'), recipe.artifact(releaseDir)]);
    snapshot = parseSnapshot(install.output);
    effects.log('install', { component: recipe.name, ok: install.ok, snapshot });
    if (!install.ok) {
      effects.log('installer-output', { component: recipe.name, tail: install.output.split('\n').slice(-20) });
      // The installer's own ERR path already restored or never changed anything; a snapshot means it changed something.
      return finish(effects, recipe, tag, sha, { component: recipe.name, sha, health: 'fail', rollback: snapshot ? await rollback(effects, recipe, sha, snapshot) : 'none' }, snapshot);
    }
    effects.writeLedger({ ...effects.readLedger(), inFlight: { tag, sha, component: recipe.name, phase: 'probing', snapshot } });
    if ((await probeWindow(effects, recipe, sha)) === 'fail') {
      return finish(effects, recipe, tag, sha, { component: recipe.name, sha, health: 'fail', rollback: await rollback(effects, recipe, sha, snapshot) }, snapshot);
    }
  }
  return finish(effects, recipe, tag, sha, { component: recipe.name, sha, health: 'pass', rollback: 'none' }, snapshot);
}

/** Record the component; a failure also saves the release's receipt in the same write, so a rerun delivers it instead of redeploying. */
function finish(effects: Effects, recipe: Recipe, tag: string, sha: string, receipt: Receipt, snapshot: string | undefined): Receipt {
  const ledger = effects.readLedger();
  effects.writeLedger({
    ...ledger, inFlight: undefined,
    components: { ...ledger.components, [recipe.name]: { sha, tag, health: receipt.health, snapshot } },
    ...(receipt.health === 'fail' ? { receipt: { tag, receipt, delivered: [] } } : {}),
  });
  return receipt;
}

function prepareRelease(effects: Effects, tag: string): { sha: string; dir: string } {
  if (effects.run('git', ['-C', ROOT, 'status', '--porcelain']).stdout.trim()) throw new Error(`${ROOT} is dirty; not deploying ${tag}`);
  effects.run('git', ['-C', ROOT, 'fetch', '--quiet', '--tags', 'origin']);
  const sha = effects.run('git', ['-C', ROOT, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).stdout.trim();
  effects.run('git', ['-C', ROOT, 'merge-base', '--is-ancestor', sha, 'origin/main']);
  const dir = join(effects.stateDir, 'releases', tag);
  if (!existsSync(join(dir, '.verified'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    const inventory = join(effects.stateDir, `components-${sha}.json`);
    writeFileSync(inventory, effects.run('git', ['-C', ROOT, 'show', `${sha}:deploy/components.json`]).stdout);
    effects.run('python3', [join(ROOT, 'scripts/release/release.py'), 'verify', '--anonymous', '--tag', tag, '--sha', sha, '--inventory', inventory, '--directory', dir]);
    mkdirSync(join(dir, 'kiosk'));
    effects.run('tar', ['--no-same-owner', '-xzf', join(dir, 'kiosk.tar.gz'), '-C', join(dir, 'kiosk')]);
    writeFileSync(join(dir, '.verified'), `${sha}\n`);
  }
  // release.py writes assets without the execute bit; the meter and factory-api installers require -x.
  for (const recipe of recipes) {
    const artifact = recipe.artifact(dir);
    if (statSync(artifact).isFile()) chmodSync(artifact, statSync(artifact).mode | 0o100);
  }
  // Never check out a release over the running job, verifier or allowlisted installers.
  // Reuse one worktree, but never discard interrupted/operator changes in it.
  const source = join(effects.stateDir, 'source');
  if (!existsSync(source)) effects.run('git', ['-C', ROOT, 'worktree', 'add', '--quiet', '--detach', source, sha]);
  const gitDir = (path: string) => effects.run('git', ['-C', path, 'rev-parse', '--absolute-git-dir']).stdout.trim();
  if (gitDir(source) === gitDir(ROOT)) throw new Error(`Refusing ${tag}: source checkout aliases the deployer runtime; checkout would replace deployment tools`);
  if (effects.run('git', ['-C', source, 'status', '--porcelain']).stdout.trim()) throw new Error(`${source} is dirty; not deploying ${tag}`);
  effects.run('git', ['-C', source, 'checkout', '--quiet', '--detach', sha]);
  effects.log('checkout', { tag, sha, source });
  return { sha, dir };
}

/** Install the release's changed components; the receipt is saved in the ledger before any delivery. */
async function installRelease(effects: Effects, tag: string, sha: string, dir: string): Promise<Receipt> {
  // A killed run's component finishes first: any other install would overwrite its inFlight entry and snapshot.
  const inFlight = effects.readLedger().inFlight;
  const resumed = inFlight?.sha === sha ? recipes.find(recipe => recipe.name === inFlight.component) : undefined;
  if (resumed) {
    const result = await deployComponent(effects, resumed, tag, sha, dir);
    if (result.health === 'fail') return result;
  }
  const inventory = JSON.parse(effects.run('git', ['-C', ROOT, 'show', `${sha}:deploy/components.json`]).stdout) as { components: { id: string; sources: string[] }[] };
  const sources = Object.fromEntries(inventory.components.map(component => [component.id, component.sources]));
  const ledger = effects.readLedger();
  // Only a healthy record is a baseline: a failed target was rolled back, so its inputs are still undeployed.
  const recorded = (name: string) => ledger.components[name]?.health === 'pass' ? ledger.components[name].sha : undefined;
  const baselines = Object.fromEntries(recipes.map(recipe => [recipe.name, newest(effects, [recorded(recipe.name), healthSha(effects, recipe)])]));
  const changed = plan({ sha, sources, baselines, ledger, changedSince: baseline => effects.run('git', ['-C', ROOT, 'diff', '--name-only', `${baseline}..${sha}`]).stdout.split('\n').filter(Boolean) });
  effects.log('plan', { tag, sha, components: changed.map(recipe => recipe.name) });
  for (const recipe of changed) {
    const result = await deployComponent(effects, recipe, tag, sha, dir);
    if (result.health === 'fail') return result;
  }
  // Everything healthy at this SHA, including components a killed run finished.
  const done = effects.readLedger().components;
  const installed = recipes.filter(recipe => done[recipe.name]?.sha === sha && done[recipe.name].health === 'pass');
  const receipt: Receipt = { component: installed.length ? installed.map(recipe => recipe.name).join('+') : 'none', sha, health: 'pass', rollback: 'none' };
  effects.writeLedger({ ...effects.readLedger(), receipt: { tag, receipt, delivered: [] } });
  return receipt;
}

async function deployRelease(effects: Effects, tag: string, previousTag: string): Promise<void> {
  const { sha, dir } = prepareRelease(effects, tag);
  const saved = effects.readLedger().receipt;
  const receipt = saved?.tag === tag ? saved.receipt : await installRelease(effects, tag, sha, dir);
  if (saved?.tag === tag) effects.log('receipt-resume', { tag, delivered: saved.delivered });
  const subjects = effects.run('git', ['-C', ROOT, 'log', '--first-parent', '--format=%s', `${previousTag}..${sha}`]).stdout.split('\n').filter(Boolean);
  // A lookup failure propagates: the saved receipt keeps the release pending until discovery and delivery succeed.
  const issues = issuesFromSubjects(subjects, pr => {
    try { return (JSON.parse(effects.run('gh', ['pr', 'view', String(pr), '--json', 'body'], { cwd: ROOT }).stdout) as { body?: string }).body ?? ''; } catch (error) {
      if (/Could not resolve to a PullRequest/.test(String(error))) return '';
      throw error;
    }
  });
  const line = receiptLine(receipt);
  for (const identifier of issues) {
    const pending = effects.readLedger().receipt!;
    if (pending.delivered.includes(identifier)) continue;
    // A comment whose response was lost (or a crash before the ledger write) is already there: never post twice.
    if (await effects.linear.posted(identifier, line)) effects.log('receipt-exists', { issue: identifier, line });
    else if (await effects.linear.deploying(identifier)) {
      await effects.linear.comment(identifier, line);
      effects.log('receipt', { issue: identifier, line });
    } else effects.log('receipt-skipped', { issue: identifier, reason: 'not Deploying' });
    effects.writeLedger({ ...effects.readLedger(), receipt: { ...pending, delivered: [...pending.delivered, identifier] } });
  }
  effects.writeLedger({ ...effects.readLedger(), lastTag: tag, receipt: undefined });
  if (receipt.health === 'fail') throw new Error(`${tag}: ${line}`);
}

export async function main(effects: Effects): Promise<void> {
  const pages = JSON.parse(effects.run('gh', ['api', '--paginate', '--slurp', 'repos/Metacomet-Technologies/factory/releases?per_page=100'], { cwd: ROOT }).stdout) as { tag_name: string; draft: boolean; prerelease: boolean }[][];
  const tags = pages.flat().filter(release => !release.draft && !release.prerelease).map(release => release.tag_name);
  const ledger = effects.readLedger();
  if (!ledger.lastTag) {
    // First run records where the host already is; the next published release is the first auto-deploy.
    const latest = pendingTags(tags, undefined).at(-1);
    if (!latest) { effects.log('no-releases'); return; }
    effects.writeLedger({ ...ledger, lastTag: latest });
    effects.log('bootstrap', { lastTag: latest });
    return;
  }
  const pending = pendingTags(tags, ledger.lastTag);
  effects.log('pending', { lastTag: ledger.lastTag, tags: pending });
  let previous = ledger.lastTag;
  for (const tag of pending) {
    await deployRelease(effects, tag, previous);
    previous = tag;
  }
}

export function liveEffects(): Effects {
  const log: Effects['log'] = (decision, details = {}) => console.log(JSON.stringify({ decision, ...details }));
  const run: Effects['run'] = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
  };
  let key: string | undefined;
  async function graphql<T>(query: string, variables: object): Promise<T> {
    const authorization = key ??= readFileSync(LINEAR_KEY_FILE, 'utf8').trim();
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json() as { data?: T; errors?: { message: string }[] };
    if (!response.ok || payload.errors?.length || !payload.data) throw new Error(`Linear ${response.status}: ${payload.errors?.map(error => error.message).join('; ') ?? 'no data'}`);
    return payload.data;
  }
  const issueQuery = 'query Issue($id: String!) { issue(id: $id) { id state { name } comments(first: 250) { nodes { body } } } }';
  type IssueData = { issue: { id: string; state: { name: string }; comments: { nodes: { body: string }[] } } };
  return {
    stateDir: STATE_DIR,
    log,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    run,
    ok: (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status === 0,
    sudo: (script, args) => {
      const result = spawnSync('sudo', ['-n', '/usr/bin/bash', join(ROOT, script), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
    },
    probe: url => run('curl', ['-fsS', '--max-time', '10', url]).stdout,
    readLedger: () => {
      try { return JSON.parse(readFileSync(LEDGER, 'utf8')) as Ledger; } catch { return emptyLedger(); }
    },
    writeLedger: ledger => {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(`${LEDGER}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
      renameSync(`${LEDGER}.tmp`, LEDGER);
    },
    linear: {
      deploying: async identifier => (await graphql<IssueData>(issueQuery, { id: identifier })).issue.state.name === 'Deploying',
      posted: async (identifier, body) => (await graphql<IssueData>(issueQuery, { id: identifier })).issue.comments.nodes.some(comment => comment.body.trim() === body),
      comment: async (identifier, body) => {
        const { issue } = await graphql<IssueData>(issueQuery, { id: identifier });
        await graphql('mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: issue.id, body } });
      },
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const effects = liveEffects();
  main(effects).catch(error => { console.error(String(error instanceof Error ? error.message : error)); process.exit(1); });
}
