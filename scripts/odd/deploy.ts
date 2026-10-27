#!/usr/bin/env node
// Outcome driven development, Deployer (docs/odd/README.md §4, §5.2). factory-deploy.timer runs
// this as `agent` on factory-gpu every 2 minutes, one run at a time (flock in the unit). No model:
// every published release newer than the ledger is verified, a separate source worktree is
// detached at its SHA, each enabled component whose inputs changed is installed through the sudoers
// allowlist, probed three times for the exact release SHA, rolled back once when red (and
// re-probed: the rollback counts only when the previous release is back and healthy), and every
// Deploying issue the release ships gets one `odd-deploy` receipt; one not yet Deploying stays a
// durable pending delivery for seven days. Each tick also gives every odd Deploying issue whose
// merged work the newest pass release contains, but which has no receipt since its merge or failed
// verification at an older release, that release's receipt, without installing anything. A pass
// receipt names each component the issue needs at its own healthy SHA (`issueReceipt`). The
// control plane turns the receipt into Done, Todo + Bug, or a page (scripts/odd/lifecycle.ts).
//
// The unprivileged runtime (this job, the dispatcher and the usage collector) runs from
// `~/factory-tools/current`, a link to an immutable `~/factory-tools/<tag>` tree of a release this
// job verified. It advances only forward, after every tool's side-effect-free self-check passes in
// the candidate and again through the link (`promoteTools`). sudo runs the privileged installers
// only from TRUSTED, the root-owned tree Devon staged from a verified release; before any privileged
// call, a release whose staged assets are missing, changed or not its own is held (`requireStaged`).
// Git history and the release verifier stay in the `/home/agent/work/factory` checkout (ROOT).
//
// Pure planning (`plan`, `pendingTags`, `issuesFromSubjects`, `parseSnapshot`, `healthySha`,
// `probeResult`, `restoredResult`, `receiptLine`, `meterPlan`, `resume`) is exported for tests; effects go
// through `Effects` so the sandbox fixture fakes sudo, curl, git, the release download and Linear.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployReceiptLine, oddLabel, type ComponentIdentity, type Refusal } from './lifecycle.ts';
import { prOwnsIssue, toSnapshot, type GitHubPullRequest } from './snapshot.ts';

/** Git history and the release verifier. Never the runtime, and never run as root. */
export const ROOT = '/home/agent/work/factory';
/** MET-375: the root-owned installer tree Devon stages from a verified release (deploy/sudoers/stage-trusted.sh);
 * the sudoers allowlist names only scripts in it. */
export const TRUSTED = '/usr/local/lib/factory-deploy';
export const HOST = 'factory-gpu';
export const STATE_DIR = join(homedir(), '.local/state/factory-odd');
export const LEDGER = join(STATE_DIR, 'deploy.json');
export const PROBES = 3;
export const PROBE_GAP_MS = 20_000;
export const LINEAR_KEY_FILE = '/etc/factory-dispatch/linear-api-key';
/** Versioned runtime trees and the `current` link the deploy, dispatch and usage units execute. */
export const TOOLS_DIR = join(homedir(), 'factory-tools');
export const CHECK_TIMEOUT_MS = 60_000;
/** Each tool's side-effect-free check; a candidate tree must pass all of them. */
export const toolChecks = [['scripts/odd/deploy.ts', '--self-check'], ['scripts/dispatch/dispatch.ts', 'check'], ['scripts/usage/collect.ts', '--self-check']] as const;

export type Recipe = {
  name: string;
  /** Deploy inputs beyond the component's `sources` in deploy/components.json. */
  deployFiles: readonly string[];
  /** Installer argument from the verified release directory. */
  artifact: (releaseDir: string) => string;
  installer: string;
  /** Restores the installer's snapshot: `sudo rollback ...rollbackArgs SNAPSHOT`. */
  rollback: string;
  rollbackArgs?: readonly string[];
  /** Every file the installer and rollback run or read as root from TRUSTED (deploy/sudoers/trusted-assets.sh callers). */
  staged: readonly string[];
  /** Health endpoint reporting `git_sha`. */
  health: string;
  /** The installer classifies DB-generation changes: preflighted with `--plan`, installed with `--no-db-change`. */
  dbGuard?: true;
};

/** Auto-deploy set settled by Devon 2026-10-24, in install order. The dispatcher's installer needs
 * a console runner list on stdin and retires in phase 7; usage waits for a rollback that restores
 * the previous timer (deploy/rollback-usage.sh removes it); pricing, ups, alerts, backup, reboot
 * and nut stay human-only (deploy/components.json). */
export const recipes: readonly Recipe[] = [
  { name: 'meter', deployFiles: ['deploy/install-meter.sh', 'deploy/meter.service'], artifact: dir => join(dir, 'meter-linux-x86_64'),
    installer: 'deploy/install-meter.sh', rollback: 'deploy/rollback-meter-v1.sh',
    staged: ['deploy/install-meter.sh', 'deploy/meter.service', 'deploy/set_ollama_host.py', 'deploy/rollback-meter-v1.sh'],
    health: 'http://127.0.0.1:11434/meter/health', dbGuard: true },
  { name: 'factory-api', deployFiles: ['deploy/install-factory-api.sh', 'deploy/factory-api.service'], artifact: dir => join(dir, 'factory-api-linux-x86_64'),
    installer: 'deploy/install-factory-api.sh', rollback: 'deploy/rollback-factory-api.sh',
    staged: ['deploy/install-factory-api.sh', 'deploy/factory-api.service', 'deploy/alerts/factory-api-alerts.conf', 'deploy/device-tokens.sh', 'deploy/rollback-factory-api.sh'],
    health: 'http://127.0.0.1:8080/v1/health' },
  { name: 'kiosk', deployFiles: ['deploy/install-kiosk.sh'], artifact: dir => join(dir, 'kiosk'),
    // rollback-kiosk.sh is not allowlisted: the installer validates the snapshot, then runs it (MET-375).
    installer: 'deploy/install-kiosk.sh', rollback: 'deploy/install-kiosk.sh', rollbackArgs: ['--rollback'],
    staged: ['deploy/install-kiosk.sh', 'deploy/rollback-kiosk.sh'],
    health: 'http://127.0.0.1:8080/version.json' },
];

/** Inputs scripts/release/release.py fingerprints for every component: a change to any one
 * intentionally selects every enabled recipe. */
export const releaseInputs = ['VERSION', 'Cargo.toml', 'Cargo.lock', 'deploy/components.json'] as const;

export type ComponentRecord = { sha: string; tag: string; health: 'pass' | 'fail'; snapshot?: string };
/** `noDbChange`: the install ran with `--no-db-change`, so its snapshot never restores a DB generation (no `db-changing` marker). */
export type InFlight = { tag: string; sha: string; component: string; phase: 'installing' | 'probing'; snapshot?: string; noDbChange?: true };
/** A release's receipt, saved before delivery so a crashed delivery resumes without redeploying. `delivered` lists issues already handled. */
export type PendingReceipt = { tag: string; receipt: Receipt; delivered: string[] };
/** A shipped issue that was not Deploying yet: retried every tick until it is, posted once, or expired `DELIVERY_WINDOW_MS` after `since` (first seen). */
export type Delivery = { issue: string; tag: string; line: string; since: string };
export const DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** The newest release this job handled with a pass receipt: the proven deployment that catch-up and re-receipts carry. */
export type Deployed = { tag: string; sha: string; line: string };
/** A tools tree: release tag/SHA and the installer checkout's HEAD it ran beside. */
export type ToolsRecord = { tag: string; sha: string; installerSha: string };
/** `pending` is saved before staging and cleared only by delivery or rejection; `previous` is the link target to restore. */
export type Tools = { current?: ToolsRecord; pending?: ToolsRecord & { previous: string | null }; rejected?: ToolsRecord & { reason: string } };
export type Ledger = { lastTag?: string; components: Record<string, ComponentRecord>; inFlight?: InFlight; receipt?: PendingReceipt; deliveries?: Delivery[]; deployed?: Deployed; manualBaseline?: ManualBaseline; tools?: Tools };
export type ManualBaseline = {
  tag: string; sha: string; toolsSha: string; manifestSha256: string;
  priorLedger: Omit<Ledger, 'manualBaseline'>;
  releases: { tag: string; sha: string; issues: string[]; disposition: 'prior-attempt' | 'not-replayed' | 'manual-install'; requirements: 'unverified' }[];
  approval: string;
};

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
  if (!json || typeof json !== 'object') return undefined;
  const reported = typeof json.git_sha === 'string' ? json.git_sha : '';
  if (!/^[0-9a-f]{7,40}$/.test(reported) || json.git_dirty !== false) return undefined;
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

/** `refused`: nothing was installed, migrated or rolled back; the control plane pages irreversible-action. */
export type Receipt = { component: string; sha: string; health: 'pass' | 'fail' | 'refused'; rollback: string; refusal?: Refusal };
export const receiptLine = (receipt: Receipt) =>
  `odd-deploy host=${HOST} component=${receipt.component} sha=${receipt.sha} health=${receipt.health} rollback=${receipt.rollback}${receipt.refusal ? ` refusal=${receipt.refusal}` : ''}`;

/** A DB-guarded installer's verdict: `eligible` for exactly one v2 no-DB-change `meter-plan` line,
 * a refusal for any other plan line, undefined when the output carries no plan line. */
export function meterPlan(output: string): 'eligible' | Refusal | undefined {
  const lines = [...output.matchAll(/^meter-plan mode=(\S+) user_version=(?:\d+|none) db_changing=(yes|no)$/gm)];
  if (lines.length !== 1) return lines.length ? 'db-changing-unknown' : undefined;
  const [, mode, changing] = lines[0];
  if (mode === 'v2' && changing === 'no') return 'eligible';
  return mode === 'fresh' || mode === 'legacy' || mode === 'v1' ? `db-changing-${mode}` : 'db-changing-unknown';
}

/**
 * Components to install for a release, in recipe order: enabled recipes whose sources, deploy
 * files or shared release inputs changed since their baseline, skipping ones the ledger already
 * records healthy at this SHA. `changedSince(baseline)` lists the paths that changed in
 * (baseline, release]; a component with no baseline (never deployed, no health SHA) installs.
 * After checking the complete plan, a killed run's in-flight component is resumed before any
 * other install (installRelease).
 */
export function plan(input: {
  sha: string;
  sources: Record<string, readonly string[]>;
  baselines: Record<string, string | undefined>;
  ledger: Ledger;
  changedSince: (baseline: string) => readonly string[];
  isAncestor: (baseline: string, target: string) => boolean;
}): Recipe[] {
  // Check every baseline before filtering: even an unchanged component or a saved pass
  // cannot make a backwards/divergent deployment (or a historical pass receipt) safe.
  for (const [name, baseline] of Object.entries(input.baselines)) {
    if (baseline && !input.isAncestor(baseline, input.sha)) throw new Error(`Refusing older or divergent release for ${name}; reconcile the manual baseline first`);
  }
  return recipes.filter(recipe => {
    const record = input.ledger.components[recipe.name];
    if (record?.sha === input.sha && record.health === 'pass') return false;
    const baseline = input.baselines[recipe.name];
    if (!baseline) return true;
    return touches(recipe, input.sources, input.changedSince(baseline));
  });
}

/** Does any of `paths` change `recipe`'s inputs: its inventory sources, deploy files or the shared release inputs? */
function touches(recipe: Recipe, sources: Record<string, readonly string[]>, paths: readonly string[]): boolean {
  const inputs = [...(sources[recipe.name] ?? []), ...recipe.deployFiles, ...releaseInputs];
  return paths.some(path => inputs.some(prefix => path === prefix || path.startsWith(`${prefix}/`)));
}

/** What a run killed mid-component does first: a green probe means the install landed (no second install). */
export function resume(inFlight: InFlight, probe: 'pass' | 'fail'): 'installed' | 'rollback' | 'reinstall' {
  if (probe === 'pass') return 'installed';
  return inFlight.phase === 'probing' ? 'rollback' : 'reinstall';
}

export type Effects = {
  /** Holds the ledger's release directories (`releases/<tag>`) and inventories. */
  stateDir: string;
  /** Holds the runtime's `<tag>` trees and `current` link (TOOLS_DIR). */
  toolsDir: string;
  /** The staged installer tree sudo runs from (TRUSTED). */
  trustedDir: string;
  log: (decision: string, details?: object) => void;
  sleep: (ms: number) => Promise<void>;
  /** Epoch milliseconds: a delayed delivery's first-seen time and expiry. */
  now: () => number;
  /** Run a command; non-zero exit throws with stdout+stderr in the message. */
  run: (command: string, args: readonly string[], options?: { cwd?: string; timeout?: number }) => { stdout: string; stderr: string };
  /** Exit status 0? For git predicates such as merge-base --is-ancestor. */
  ok: (command: string, args: readonly string[]) => boolean;
  /** `sudo -n /usr/bin/bash <TRUSTED>/<script> args...`; returns combined output, `ok` false on non-zero exit. */
  sudo: (script: string, args: readonly string[]) => { ok: boolean; output: string };
  /** GET a health endpoint; throws when unreachable. */
  probe: (url: string) => string;
  /** Throws when unreadable; an absent ledger throws with code ENOENT. */
  readLedger: () => Ledger;
  /** Atomic replace; `create` refuses to overwrite an existing ledger. */
  writeLedger: (ledger: Ledger, options?: { create?: boolean }) => void;
  linear: {
    deploying: (identifier: string) => Promise<boolean>;
    /** Does the issue already carry a comment whose body is exactly `body`? */
    posted: (identifier: string, body: string) => Promise<boolean>;
    comment: (identifier: string, body: string) => Promise<void>;
    /** Every issue labelled `odd` in Deploying, all pages. */
    deployingIssues: () => Promise<string[]>;
    /** Every comment on the issue, all pages. */
    comments: (identifier: string) => Promise<{ body: string; createdAt: string }[]>;
  };
};

export const emptyLedger = (): Ledger => ({ components: {} });

/** Newest of the candidate baselines: a hand install after a ledger entry moves the baseline forward. */
function newest(effects: Effects, candidates: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!best || effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', best, candidate])) best = candidate;
    else if (!effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', candidate, best])) throw new Error('Inconsistent deployment baseline ancestry');
  }
  effects.log('baseline', { candidates: candidates.filter(Boolean), chosen: best });
  return best;
}

/** An unavailable/degraded service can need repair. A reported dirty, unknown,
 * newer or divergent identity must never be discarded to permit a downgrade. */
function healthIdentity(effects: Effects, recipe: Recipe, target: string): { sha: string; healthy: boolean } | undefined {
  let body: string;
  try { body = effects.probe(recipe.health); } catch { return undefined; }
  const json = JSON.parse(body);
  if (!json || typeof json.git_sha !== 'string' || !/^[a-f0-9]{7,40}$/.test(json.git_sha) || json.git_dirty !== false) {
    throw new Error(`Unverifiable installed identity for ${recipe.name}`);
  }
  const sha = effects.run('git', ['-C', ROOT, 'rev-parse', '--verify', `${json.git_sha}^{commit}`]).stdout.trim();
  if (!effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', sha, target])) throw new Error(`Refusing older or divergent release for ${recipe.name}; reconcile the manual baseline first`);
  return { sha, healthy: !!healthySha(body) };
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
  const result = effects.sudo(recipe.rollback, [...recipe.rollbackArgs ?? [], snapshot]);
  effects.log('rollback', { component: recipe.name, ok: result.ok, snapshot });
  if (!result.ok) return 'none';
  return (await probeWindow(effects, recipe, sha, restoredResult, 'rollback-probe')) === 'pass' ? snapshot : 'none';
}

/** An installer that failed before its snapshot ran no rollback: `unchanged` only when three probes
 * find the exact healthy identity captured before the install, else `none` (unproven recovery). */
async function unchanged(effects: Effects, recipe: Recipe, before: string | undefined): Promise<string> {
  if (!before) { effects.log('unchanged-unproven', { component: recipe.name, reason: 'no healthy identity before the install' }); return 'none'; }
  const same = (expected: string, body: string) => healthySha(body) === expected ? 'pass' : 'fail';
  return (await probeWindow(effects, recipe, before, same, 'unchanged-probe')) === 'pass' ? 'unchanged' : 'none';
}

/** Install, probe, roll back once on red. Returns the receipt for this component. */
export async function deployComponent(effects: Effects, recipe: Recipe, tag: string, sha: string, releaseDir: string): Promise<Receipt> {
  const ledger = effects.readLedger();
  let snapshot: string | undefined;
  let needInstall = true;
  const inFlight = ledger.inFlight;
  const resuming = inFlight && inFlight.sha === sha && inFlight.component === recipe.name;
  if (resuming) {
    const action = resume(inFlight, await probeWindow(effects, recipe, sha));
    effects.log('resume', { component: recipe.name, phase: inFlight.phase, action });
    snapshot = inFlight.snapshot;
    if (action === 'installed') needInstall = false;
    // Only a snapshot a --no-db-change install took is proven binary-only; any other snapshot
    // (an older installer's, possibly marked db-changing) may restore an older DB generation.
    if (action === 'rollback' && recipe.dbGuard && snapshot && !inFlight.noDbChange) {
      return refuse(effects, tag, { component: recipe.name, sha, health: 'refused', rollback: 'none', refusal: 'db-changing-snapshot' });
    }
    if (action === 'rollback') return finish(effects, recipe, tag, sha, { component: recipe.name, sha, health: 'fail', rollback: await rollback(effects, recipe, sha, snapshot) }, snapshot);
  }
  if (needInstall) {
    const guarded = recipe.dbGuard ? { noDbChange: true as const } : {};
    // The exact healthy identity before this install; an interrupted install's prior state is unproven.
    let before: string | undefined;
    if (!resuming) try { before = healthySha(effects.probe(recipe.health)); } catch { /* unavailable: unproven */ }
    effects.writeLedger({ ...ledger, inFlight: { tag, sha, component: recipe.name, phase: 'installing', ...guarded } });
    const install = effects.sudo(recipe.installer, ['--source-checkout', join(effects.stateDir, 'source'), ...(recipe.dbGuard ? ['--no-db-change'] : []), recipe.artifact(releaseDir)]);
    snapshot = parseSnapshot(install.output);
    effects.log('install', { component: recipe.name, ok: install.ok, snapshot });
    if (!install.ok) {
      effects.log('installer-output', { component: recipe.name, tail: install.output.split('\n').slice(-20) });
      // The installer's own recheck saw the DB generation change after the preflight: nothing changed.
      const verdict = recipe.dbGuard && !snapshot ? meterPlan(install.output) : undefined;
      if (verdict && verdict !== 'eligible') return refuse(effects, tag, { component: recipe.name, sha, health: 'refused', rollback: 'none', refusal: verdict });
      // A snapshot means it changed something; without one it refused before any change, proven only by the captured identity.
      return finish(effects, recipe, tag, sha, { component: recipe.name, sha, health: 'fail', rollback: snapshot ? await rollback(effects, recipe, sha, snapshot) : await unchanged(effects, recipe, before) }, snapshot);
    }
    effects.writeLedger({ ...effects.readLedger(), inFlight: { tag, sha, component: recipe.name, phase: 'probing', snapshot, ...guarded } });
    if ((await probeWindow(effects, recipe, sha)) === 'fail') {
      return finish(effects, recipe, tag, sha, { component: recipe.name, sha, health: 'fail', rollback: await rollback(effects, recipe, sha, snapshot) }, snapshot);
    }
  }
  return finish(effects, recipe, tag, sha, { component: recipe.name, sha, health: 'pass', rollback: 'none' }, snapshot);
}

/** Record the component; a failure also saves the release's receipt in the same write, so a rerun delivers it instead of redeploying. */
function finish(effects: Effects, recipe: Recipe, tag: string, sha: string, receipt: Receipt & { health: 'pass' | 'fail' }, snapshot: string | undefined): Receipt {
  const ledger = effects.readLedger();
  effects.writeLedger({
    ...ledger, inFlight: undefined,
    components: { ...ledger.components, [recipe.name]: { sha, tag, health: receipt.health, snapshot } },
    ...(receipt.health === 'fail' ? { receipt: { tag, receipt, delivered: [] } } : {}),
  });
  return receipt;
}

/** A refusal changed nothing, so only its receipt is saved: components, inFlight and lastTag stay as they were. */
function refuse(effects: Effects, tag: string, receipt: Receipt): Receipt {
  effects.log('refused', { tag, ...receipt });
  effects.writeLedger({ ...effects.readLedger(), receipt: { tag, receipt, delivered: [] } });
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
    effects.run('python3', [join(ROOT, 'scripts/release/release.py'), 'verify', '--tag', tag, '--sha', sha, '--inventory', inventory, '--directory', dir]);
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

/** MET-375: before any privileged call, every file any recipe runs or reads as root must be
 * staged in TRUSTED as a regular, non-symlinked file that is not group- or other-writable, still have
 * the digest stage-trusted.sh recorded, and be byte-identical to this release. Otherwise the release
 * is held: no sudo, receipt or ledger change, retried each tick until Devon restages. The installers
 * enforce root ownership themselves. Never falls back to the agent-writable checkout's scripts. */
function requireStaged(effects: Effects, tag: string, sha: string): void {
  const dir = effects.trustedDir;
  const problems: string[] = [];
  const sums = new Map<string, string>();
  try {
    for (const line of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)) {
      const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line);
      if (!match || sums.has(match[2])) throw new Error(`malformed or duplicate line: ${line}`);
      sums.set(match[2], match[1]);
    }
  } catch (error) { problems.push(`SHA256SUMS: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`); }
  for (const file of new Set(['deploy/sudoers/trusted-assets.sh', ...recipes.flatMap(recipe => recipe.staged)])) {
    const path = join(dir, file);
    let staged: Buffer;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || realpathSync(path) !== path) { problems.push(`${file}: symlinked or not a regular file`); continue; }
      if (info.mode & 0o022) { problems.push(`${file}: group- or other-writable`); continue; }
      staged = readFileSync(path);
    } catch { problems.push(`${file}: missing`); continue; }
    if (createHash('sha256').update(staged).digest('hex') !== sums.get(file)) { problems.push(`${file}: changed since staging`); continue; }
    let release: string | undefined;
    try { release = effects.run('git', ['-C', ROOT, 'show', `${sha}:${file}`]).stdout; } catch { /* absent from the release */ }
    if (release !== staged.toString()) problems.push(`${file}: ${release === undefined ? 'absent from' : 'differs from'} ${tag}`);
  }
  if (!problems.length) return;
  effects.log('staged-assets-held', { tag, sha, trustedDir: dir, problems });
  throw new Error(`${tag}: staged installers in ${dir} cannot install this release (${problems.join('; ')}); nothing installed. Devon restages (deploy/sudoers/README.md)`);
}

/** Each component's sources in the release's deploy/components.json. */
function inventorySources(effects: Effects, sha: string): Record<string, string[]> {
  const inventory = JSON.parse(effects.run('git', ['-C', ROOT, 'show', `${sha}:deploy/components.json`]).stdout) as { components: { id: string; sources: string[] }[] };
  return Object.fromEntries(inventory.components.map(component => [component.id, component.sources]));
}

/** Install the release's changed components; the receipt is saved in the ledger before any delivery. */
async function installRelease(effects: Effects, tag: string, sha: string, dir: string): Promise<Receipt> {
  const inFlight = effects.readLedger().inFlight;
  const resumed = inFlight?.sha === sha ? recipes.find(recipe => recipe.name === inFlight.component) : undefined;
  const sources = inventorySources(effects, sha);
  const select = (recovering = false) => {
    const ledger = effects.readLedger();
    // Only a healthy record is a baseline: a failed target was rolled back, so its inputs are still undeployed.
    const recorded = (name: string) => ledger.components[name]?.health === 'pass' ? ledger.components[name].sha : undefined;
    const baselines = Object.fromEntries(recipes.map(recipe => {
      const identity = healthIdentity(effects, recipe, sha);
      const live = identity?.healthy ? identity.sha : undefined;
      // API serves /version.json too. Only a transport outage during recorded API recovery
      // can defer kiosk evidence; any usable identity must still pass all ancestry checks.
      const dependentOutage = recovering && resumed?.name === 'factory-api' && recipe.name === 'kiosk' && !identity;
      const floor = ledger.manualBaseline?.sha;
      if (floor && ((!live && !(recovering && recipe === resumed) && !dependentOutage) ||
          (identity && !effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', floor, identity.sha])))) {
        throw new Error(`Manual baseline drift for ${recipe.name}; review before deployment`);
      }
      return [recipe.name, newest(effects, [floor, recorded(recipe.name), live])];
    }));
    return plan({ sha, sources, baselines, ledger,
      isAncestor: (baseline, target) => effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', baseline, target]),
      changedSince: baseline => effects.run('git', ['-C', ROOT, 'diff', '--name-only', `${baseline}..${sha}`]).stdout.split('\n').filter(Boolean) });
  };
  // Read-only installer plans for every DB-guarded component, before any install, rollback or resume.
  // Only an eligible plan proceeds; a refused, unparseable or failed plan refuses the whole release.
  const planned = new Set<Recipe>();
  const preflight = (selected: readonly Recipe[]): Receipt | undefined => {
    for (const recipe of selected) {
      if (!recipe.dbGuard || planned.has(recipe)) continue;
      planned.add(recipe);
      const result = effects.sudo(recipe.installer, ['--source-checkout', join(effects.stateDir, 'source'), '--plan', recipe.artifact(dir)]);
      const verdict = result.ok ? meterPlan(result.output) : undefined;
      effects.log('preflight', { component: recipe.name, ok: result.ok, verdict });
      if (verdict !== 'eligible') return refuse(effects, tag, { component: recipe.name, sha, health: 'refused', rollback: 'none', refusal: verdict ?? 'db-changing-unknown' });
    }
  };
  let changed = select(true);
  effects.log('plan', { tag, sha, components: changed.map(recipe => recipe.name) });
  // Every recipe's assets, so a later re-selection or rollback can never reach an unchecked file.
  if (resumed || changed.length) requireStaged(effects, tag, sha);
  // Guard the entire plan before resuming even one interrupted installer.
  const refused = preflight(resumed ? [resumed, ...changed] : changed);
  if (refused) return refused;
  if (resumed) {
    const result = await deployComponent(effects, resumed, tag, sha, dir);
    if (resumed.name === 'factory-api') changed = select();
    if (result.health !== 'pass') return result;
    const again = preflight(changed);
    if (again) return again;
  }
  for (const recipe of changed) {
    if (recipe === resumed) continue;
    const result = await deployComponent(effects, recipe, tag, sha, dir);
    if (result.health !== 'pass') return result;
  }
  // Everything healthy at this SHA, including components a killed run finished.
  const done = effects.readLedger().components;
  const installed = recipes.filter(recipe => done[recipe.name]?.sha === sha && done[recipe.name].health === 'pass');
  const receipt: Receipt = { component: installed.length ? installed.map(recipe => recipe.name).join('+') : 'none', sha, health: 'pass', rollback: 'none' };
  effects.writeLedger({ ...effects.readLedger(), receipt: { tag, receipt, delivered: [] } });
  return receipt;
}

function releaseIssues(effects: Effects, sha: string, previousTag: string, strict = false): string[] {
  const subjects = effects.run('git', ['-C', ROOT, 'log', '--first-parent', '--format=%s', `${previousTag}..${sha}`]).stdout.split('\n').filter(Boolean);
  // A lookup failure propagates: the saved receipt keeps the release pending until discovery and delivery succeed.
  return issuesFromSubjects(subjects, pr => {
    try { return (JSON.parse(effects.run('gh', ['pr', 'view', String(pr), '--json', 'body'], { cwd: ROOT }).stdout) as { body?: string }).body ?? ''; } catch (error) {
      if (!strict && /Could not resolve to a PullRequest/.test(String(error))) return '';
      throw error;
    }
  });
}

async function deployRelease(effects: Effects, tag: string, previousTag: string): Promise<void> {
  const { sha, dir } = prepareRelease(effects, tag);
  const saved = effects.readLedger().receipt;
  const receipt = saved?.tag === tag ? saved.receipt : await installRelease(effects, tag, sha, dir);
  if (saved?.tag === tag) effects.log('receipt-resume', { tag, delivered: saved.delivered });
  const issues = releaseIssues(effects, sha, previousTag);
  const line = receiptLine(receipt);
  for (const identifier of issues) {
    const pending = effects.readLedger().receipt!;
    if (pending.delivered.includes(identifier)) continue;
    // This release's receipt supersedes an older one still pending for the issue; the first-seen time stays.
    const earlier = effects.readLedger().deliveries?.find(delivery => delivery.issue === identifier);
    // A pass release gives each issue its own receipt (issueReceipt); an incomplete set posts nothing and drops an older pending
    // receipt, and reconcile publishes the complete set once the issue is Deploying and every component is covered.
    const issue = receipt.health === 'pass' ? issueReceipt(effects, identifier, { tag, sha, line }) : { line };
    let delayed: Delivery | undefined;
    // A comment whose response was lost (or a crash before the ledger write) is already there: never post twice.
    if (!('line' in issue)) effects.log('receipt-partial', { issue: identifier, tag, missing: issue.missing });
    else if (await effects.linear.posted(identifier, issue.line)) effects.log('receipt-exists', { issue: identifier, line: issue.line });
    else if (await effects.linear.deploying(identifier)) {
      await effects.linear.comment(identifier, issue.line);
      effects.log('receipt', { issue: identifier, line: issue.line });
    } else {
      delayed = { issue: identifier, tag, line: issue.line, since: earlier?.since ?? new Date(effects.now()).toISOString() };
      effects.log('receipt-skipped', { ...delayed, reason: 'not Deploying; kept as a pending delivery' });
    }
    const ledger = effects.readLedger();
    const deliveries = [...(ledger.deliveries ?? []).filter(delivery => delivery.issue !== identifier), ...(delayed ? [delayed] : [])];
    effects.writeLedger({ ...ledger, deliveries, receipt: { ...pending, delivered: [...pending.delivered, identifier] } });
  }
  // An unhandled refusal holds lastTag and its delivered receipt: every rerun stops here until Devon acts.
  if (receipt.health === 'refused') throw new Error(`${tag}: ${line}; held until Devon handles the refusal`);
  effects.writeLedger({ ...effects.readLedger(), lastTag: tag, receipt: undefined, ...(receipt.health === 'pass' ? { deployed: { tag, sha, line } } : {}) });
  if (receipt.health === 'fail') throw new Error(`${tag}: ${line}`);
}

/** Retry every pending delivery: posted once when its issue reaches Deploying, never twice, and
 * dropped with an explicit `receipt-expired` diagnostic, never as delivered, after seven days. */
async function deliverDelayed(effects: Effects): Promise<void> {
  for (const delivery of effects.readLedger().deliveries ?? []) {
    const { issue, line } = delivery;
    if (await effects.linear.posted(issue, line)) effects.log('receipt-exists', { issue, line });
    else if (await effects.linear.deploying(issue)) {
      await effects.linear.comment(issue, line);
      effects.log('receipt', { issue, line, delayedSince: delivery.since });
    } else if (effects.now() - Date.parse(delivery.since) >= DELIVERY_WINDOW_MS) {
      effects.log('receipt-expired', { ...delivery, reason: 'not Deploying within seven days of release; no receipt was delivered' });
    } else continue;
    const ledger = effects.readLedger();
    effects.writeLedger({ ...ledger, deliveries: (ledger.deliveries ?? []).filter(other => other.issue !== issue || other.line !== line) });
  }
}

const mergeReceipt = /^odd-merge pr=(\d+) head=\S+ merge=([a-f0-9]{40})\b/m;

/** Is `commit` known here and contained in `target`? An unknown commit is unproven, never contained. */
function contains(effects: Effects, commit: string, target: string): boolean {
  let full: string;
  try { full = effects.run('git', ['-C', ROOT, 'rev-parse', '--verify', `${commit}^{commit}`]).stdout.trim(); } catch { return false; }
  return effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', full, target]);
}

/** Merged PRs that own the issue (prOwnsIssue) with a full merge commit, newest merge first. A malformed or truncated list throws. */
function ownedMerges(effects: Effects, identifier: string): (GitHubPullRequest & { mergeCommit: { oid: string } })[] {
  const limit = 1000;
  const listed = JSON.parse(effects.run('gh', ['pr', 'list', '--search', `"${identifier}"`, '--state', 'merged', '--json', 'number,headRefName,body,mergeCommit,mergedAt', '--limit', String(limit)], { cwd: ROOT }).stdout) as GitHubPullRequest[];
  if (!Array.isArray(listed) || listed.length >= limit) throw new Error(`gh pr list for ${identifier} returned a malformed or truncated PR list`);
  return listed.filter((pr): pr is GitHubPullRequest & { mergeCommit: { oid: string } } => prOwnsIssue(pr, identifier) && /^[a-f0-9]{40}$/.test(pr.mergeCommit?.oid ?? ''))
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''));
}

/**
 * MET-386: the receipt `identifier` gets at `round`, a release this job handled with a pass receipt. The issue
 * requires each enabled component whose inputs one of its merges in the round changed (ownedMerges). When every
 * required component is healthy in the ledger at the round's own SHA, the round's line is already true for it.
 * Otherwise the receipt is a complete set naming each required component at its own healthy ledger SHA and tag,
 * never the round's: each must be healthy in the ledger, contained in the round, contain every issue merge that
 * changed it, and be reported by a read-only health probe. Any gap is `missing`, and nothing is published.
 */
function issueReceipt(effects: Effects, identifier: string, round: Deployed): { line: string } | { missing: string } {
  const sources = inventorySources(effects, round.sha);
  const changed = new Map(ownedMerges(effects, identifier).map(pr => pr.mergeCommit.oid).filter(commit => contains(effects, commit, round.sha))
    .map(commit => [commit, effects.run('git', ['-C', ROOT, 'diff', '--name-only', `${commit}^..${commit}`]).stdout.split('\n').filter(Boolean)]));
  const merges = (recipe: Recipe) => [...changed].filter(([, paths]) => touches(recipe, sources, paths)).map(([commit]) => commit);
  const required = recipes.filter(recipe => merges(recipe).length);
  const { components } = effects.readLedger();
  if (required.every(recipe => components[recipe.name]?.health === 'pass' && components[recipe.name].sha === round.sha)) return { line: round.line };
  const ancestor = (commit: string, target: string) => effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', commit, target]);
  const set: ComponentIdentity[] = [];
  for (const recipe of required) {
    const record = components[recipe.name];
    if (record?.health !== 'pass') return { missing: `${recipe.name} has no healthy ledger record` };
    if (!ancestor(record.sha, round.sha)) return { missing: `${recipe.name} at ${record.sha} is not in ${round.tag}` };
    const unshipped = merges(recipe).find(commit => !ancestor(commit, record.sha));
    if (unshipped) return { missing: `${recipe.name} at ${record.sha} does not contain merge ${unshipped}` };
    let reported: string | undefined;
    try { reported = healthySha(effects.probe(recipe.health)); } catch { /* unreachable: unproven */ }
    if (!reported || !record.sha.startsWith(reported)) return { missing: `${recipe.name} is not reported healthy at ${record.sha}` };
    set.push({ component: recipe.name, sha: record.sha, tag: record.tag });
  }
  return { line: deployReceiptLine({ host: HOST, component: set.map(entry => entry.component).join('+'), sha: round.sha, health: 'pass', rollback: 'none', round: round.tag, set }) };
}

/** The merged PR an issue's receipt rests on: the one its latest `odd-merge` names, else (a manual
 * merge) the newest merged PR that owns it by branch or link line (prOwnsIssue). Never a PR that only
 * mentions the issue, and never one whose merge commit differs from the merge receipt. */
function authoritativeMerge(effects: Effects, identifier: string, comments: readonly { body: string; createdAt: string }[]): { commit: string } | { refusal: string } {
  const latest = comments.filter(comment => mergeReceipt.test(comment.body)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const named = latest && mergeReceipt.exec(latest.body)!;
  const owned = ownedMerges(effects, identifier);
  const pr = named ? owned.find(candidate => candidate.number === Number(named[1])) : owned[0];
  if (!pr) return { refusal: named ? `odd-merge PR #${named[1]} is not a merged PR that owns ${identifier}` : `no merged PR owns ${identifier}` };
  if (named && pr.mergeCommit!.oid !== named[2]) return { refusal: `PR #${pr.number} merged ${pr.mergeCommit!.oid}, not the odd-merge commit ${named[2]}` };
  return { commit: pr.mergeCommit!.oid };
}

/**
 * Every tick, with or without a new release: an odd Deploying issue with no receipt since its
 * latest merge, or whose pass receipt failed verification at an older release, gets the newest
 * pass release's receipt once its authoritative merge (and the failed receipt) is proven to be in
 * that release. Nothing is installed; the issue's own comments make a repeat (a lost response) a no-op.
 */
async function reconcile(effects: Effects): Promise<void> {
  const { deployed, deliveries = [] } = effects.readLedger();
  if (!deployed) { effects.log('reconcile-skipped', { reason: 'no pass release recorded by this deployer yet' }); return; }
  for (const identifier of await effects.linear.deployingIssues()) {
    // A pending delivery is this issue's receipt; posting another first would reorder them.
    if (deliveries.some(delivery => delivery.issue === identifier)) continue;
    const comments = await effects.linear.comments(identifier);
    const { deployReceipt: receipt, verify } = toSnapshot({ issue: { id: identifier, status: 'Deploying', labels: [oddLabel], comments } });
    const failed = receipt?.health === 'pass' && verify?.sha === receipt.sha && verify.result === 'fail';
    if (receipt && !failed) continue;
    const refuse = (reason: string) => effects.log('reconcile-refused', { issue: identifier, tag: deployed.tag, reason });
    if (receipt && (receipt.sha === deployed.sha || !contains(effects, receipt.sha, deployed.sha))) {
      refuse(`failed verification at ${receipt.sha} has no later proven deployment`);
      continue;
    }
    const merge = authoritativeMerge(effects, identifier, comments);
    if ('refusal' in merge) { refuse(merge.refusal); continue; }
    if (!contains(effects, merge.commit, deployed.sha)) { refuse(`merge ${merge.commit} is not proven to be in ${deployed.tag}`); continue; }
    const issue = issueReceipt(effects, identifier, deployed);
    if (!('line' in issue)) { refuse(`receipt set incomplete: ${issue.missing}`); continue; }
    await effects.linear.comment(identifier, issue.line);
    effects.log('receipt', { issue: identifier, line: issue.line, reason: receipt ? 'failed-verification-refresh' : 'missing-receipt' });
  }
}

function publishedTags(effects: Effects): string[] {
  const pages = JSON.parse(effects.run('gh', ['api', '--paginate', '--slurp', 'repos/Metacomet-Technologies/factory/releases?per_page=100'], { cwd: ROOT }).stdout) as { tag_name: string; draft: boolean; prerelease: boolean }[][];
  return pages.flat().filter(release => !release.draft && !release.prerelease).map(release => release.tag_name);
}

/** Explicit adoption, never a historical deployment receipt. Preview and approval both
 * reverify the immutable bundle and three healthy full-SHA observations of every component.
 * The approval binds the original ledger, tools and complete deferred issue inventory. */
export async function reconcileManual(effects: Effects, tag: string, approval?: string): Promise<ManualBaseline> {
  const ledger = effects.readLedger();
  if (ledger.manualBaseline) {
    if (approval && ledger.manualBaseline.tag === tag && ledger.manualBaseline.approval === approval) return ledger.manualBaseline;
    throw new Error('A manual baseline is already recorded; review it rather than replacing historical evidence');
  }
  if (!ledger.lastTag || !semver(ledger.lastTag) || !semver(tag) || compareTags(tag, ledger.lastTag) <= 0 || ledger.inFlight || ledger.receipt) {
    throw new Error('Manual reconciliation requires an existing older lastTag and no in-flight install or pending receipt');
  }
  if (effects.run('git', ['-C', ROOT, 'status', '--porcelain']).stdout.trim()) throw new Error('Deployment tools are dirty');
  const source = join(effects.stateDir, 'source');
  if (existsSync(source) && effects.run('git', ['-C', source, 'status', '--porcelain']).stdout.trim()) throw new Error('Deployment source is dirty');
  effects.run('git', ['-C', ROOT, 'fetch', '--quiet', '--tags', 'origin']);
  const tags = pendingTags(publishedTags(effects), undefined);
  if (!tags.includes(tag) || !tags.includes(ledger.lastTag)) throw new Error('Baseline and lastTag must be published stable releases');
  const resolve = (ref: string) => effects.run('git', ['-C', ROOT, 'rev-parse', '--verify', `refs/tags/${ref}^{commit}`]).stdout.trim();
  const sha = resolve(tag);
  effects.run('git', ['-C', ROOT, 'merge-base', '--is-ancestor', sha, 'origin/main']);
  for (const [name, record] of Object.entries(ledger.components)) {
    if (!recipes.some(recipe => recipe.name === name) || !semver(record.tag) || compareTags(record.tag, ledger.lastTag) > 0 ||
        !['pass', 'fail'].includes(record.health) || resolve(record.tag) !== record.sha) throw new Error(`Inconsistent ledger component: ${name}`);
  }
  const toolsSha = effects.run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).stdout.trim();
  const inventory = join(effects.stateDir, `components-${sha}.json`);
  writeFileSync(inventory, effects.run('git', ['-C', ROOT, 'show', `${sha}:deploy/components.json`]).stdout);
  const dir = mkdtempSync(join(effects.stateDir, 'manual-verify-'));
  let manifest: { build_identity: Record<string, Record<string, unknown>> };
  let manifestSha256: string;
  let kioskVersion: { build: string; git_sha: string; git_dirty: boolean };
  try {
    // Never trust a cached .verified marker or a handoff alone for adoption.
    effects.run('python3', [join(ROOT, 'scripts/release/release.py'), 'verify', '--tag', tag, '--sha', sha, '--inventory', inventory, '--directory', dir]);
    const raw = readFileSync(join(dir, 'manifest.json'));
    manifest = JSON.parse(raw.toString());
    manifestSha256 = createHash('sha256').update(raw).digest('hex');
    // The verifier has checked every archive entry/digest. Read data only, without extracting
    // or executing it: the live endpoint exposes this bundle hash, not release-build.json.
    kioskVersion = JSON.parse(effects.run('tar', ['-xOf', join(dir, 'kiosk.tar.gz'), 'version.json']).stdout);
    if (!kioskVersion || kioskVersion.git_sha !== sha || kioskVersion.git_dirty !== false ||
        typeof kioskVersion.build !== 'string' || !/^[a-f0-9]{64}$/.test(kioskVersion.build)) throw new Error('Invalid verified kiosk version identity');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (let attempt = 0; attempt < PROBES; attempt++) {
    const bodies: Record<string, Record<string, unknown>> = {};
    for (const recipe of recipes) {
      const body = JSON.parse(effects.probe(recipe.health));
      const matches = recipe.name === 'kiosk' ? body?.build === kioskVersion.build :
        body?.version === tag.slice(1) && body?.status === 'ok' &&
        ['version', 'git_sha', 'git_dirty', 'built_at_ms', 'inputs_fingerprint'].every(key => body[key] === manifest.build_identity[recipe.name][key]);
      if (!body || body.git_sha !== sha || body.git_dirty !== false || !matches) throw new Error(`Manual baseline is not uniformly clean and healthy at ${tag}: ${recipe.name}`);
      bodies[recipe.name] = body;
    }
    const contract = bodies.meter.openapi_sha256;
    if (typeof contract !== 'string' || !/^[a-f0-9]{12}$/.test(contract) || bodies['factory-api'].meter_openapi_expected !== contract ||
        bodies['factory-api'].meter_openapi_sha256 !== contract) throw new Error('Manual baseline API/meter contracts disagree');
    if (attempt + 1 < PROBES) await effects.sleep(PROBE_GAP_MS);
  }
  const releases: ManualBaseline['releases'] = [];
  let previous = `${ledger.lastTag}^`;
  let previousSha: string | undefined;
  for (const release of tags.filter(candidate => compareTags(candidate, ledger.lastTag!) >= 0 && compareTags(candidate, tag) <= 0)) {
    const releaseSha = resolve(release);
    if (!effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', releaseSha, sha]) ||
        (previousSha && !effects.ok('git', ['-C', ROOT, 'merge-base', '--is-ancestor', previousSha, releaseSha]))) throw new Error(`Non-monotonic release ancestry: ${release}`);
    releases.push({ tag: release, sha: releaseSha, issues: releaseIssues(effects, releaseSha, previous, true),
      disposition: release === ledger.lastTag ? 'prior-attempt' : release === tag ? 'manual-install' : 'not-replayed', requirements: 'unverified' });
    previous = release;
    previousSha = releaseSha;
  }
  const report = { tag, sha, toolsSha, manifestSha256, priorLedger: ledger, releases };
  const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  if (approval && approval !== digest) throw new Error('Reconciliation plan changed; review the new preview before approving');
  const result = { ...report, approval: digest };
  if (approval) {
    if (JSON.stringify(effects.readLedger()) !== JSON.stringify(ledger)) throw new Error('Ledger changed during reconciliation; review again');
    effects.writeLedger({ ...ledger, manualBaseline: result });
  }
  effects.log(approval ? 'manual-baseline-approved' : 'manual-baseline-preview', result);
  return result;
}

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Explicit baseline for an absent ledger only: a published stable tag at an immutable SHA on
 * main that every enabled component already reports healthy. Records `lastTag` and nothing else:
 * no install, component health or receipt. Existing ledgers use reconcile-manual. */
export async function bootstrap(effects: Effects, tag: string): Promise<void> {
  if (!semver(tag)) throw new Error(`Bootstrap needs a vX.Y.Z release tag, not ${tag}`);
  // An unreadable or corrupt ledger is existing state too: its read error propagates.
  let exists = true;
  try { effects.readLedger(); } catch (error) { if (!absent(error)) throw error; exists = false; }
  if (exists) throw new Error('A deploy ledger already exists; bootstrap never overwrites it (use reconcile-manual for a stale ledger)');
  effects.run('git', ['-C', ROOT, 'fetch', '--quiet', '--tags', 'origin']);
  if (!publishedTags(effects).includes(tag)) throw new Error(`${tag} is not a published stable release`);
  const sha = effects.run('git', ['-C', ROOT, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).stdout.trim();
  effects.run('git', ['-C', ROOT, 'merge-base', '--is-ancestor', sha, 'origin/main']);
  const incompatible: string[] = [];
  for (const recipe of recipes) if ((await probeWindow(effects, recipe, sha, probeResult, 'bootstrap-probe')) === 'fail') incompatible.push(recipe.name);
  if (incompatible.length) throw new Error(`Refusing bootstrap at ${tag}: ${incompatible.join(', ')} not healthy at ${sha}`);
  effects.writeLedger({ lastTag: tag, components: {} }, { create: true });
  effects.log('bootstrap', { lastTag: tag, sha });
}

/** The job never adopts a missing, unreadable or malformed ledger: it stops before any remote read. */
function readValidLedger(effects: Effects): Ledger & { lastTag: string } {
  const stop = (reason: string) => new Error(`Deploy ledger ${LEDGER} ${reason}; not deploying. Investigate (docs/odd/deployer-recovery.md); a genuinely missing ledger needs an explicit reviewed \`deploy.ts --bootstrap TAG\`.`);
  let ledger: Ledger;
  try { ledger = effects.readLedger(); } catch (error) {
    throw stop(absent(error) ? 'is missing' : `is unreadable (${error instanceof Error ? error.message : error})`);
  }
  const components = (ledger as Partial<Ledger> | null)?.components;
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || typeof ledger.lastTag !== 'string' || !semver(ledger.lastTag) ||
      !components || typeof components !== 'object' || Array.isArray(components)) throw stop('has no valid lastTag and components');
  return ledger as Ledger & { lastTag: string };
}

export async function main(effects: Effects): Promise<void> {
  const ledger = readValidLedger(effects);
  const tags = publishedTags(effects);
  const cursor = ledger.manualBaseline && compareTags(ledger.manualBaseline.tag, ledger.lastTag) > 0 ? ledger.manualBaseline.tag : ledger.lastTag;
  const pending = pendingTags(tags, cursor);
  effects.log('pending', { lastTag: ledger.lastTag, tags: pending, deliveries: ledger.deliveries?.length ?? 0 });
  // Before any release, so a held or failing release never strands an earlier one's recipients.
  await deliverDelayed(effects);
  // At most the oldest pending release per tick: the timer drains the rest one invocation at a time.
  // A saved receipt or in-flight install always belongs to this release, since its cursor has not moved.
  const [tag] = pending;
  if (tag) await deployRelease(effects, tag, cursor);
  // Only the release this tick handled: older ones never move the runtime.
  promoteTools(effects, tag ?? cursor);
  await reconcile(effects);
}

/** Side-effect-free check of the tree this module was loaded from (realpath, so a `current`
 * link resolves to its version): imports, inventory and planning only. No ledger, lock, Git,
 * network, sudo or write. */
export function selfCheck() {
  const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
  const inventory = JSON.parse(readFileSync(join(root, 'deploy/components.json'), 'utf8')) as { components: { id: string; sources: string[] }[] };
  const sources = Object.fromEntries(inventory.components.map(component => [component.id, component.sources]));
  const missing = recipes.filter(recipe => !Array.isArray(sources[recipe.name])).map(recipe => recipe.name);
  if (missing.length) throw new Error(`deploy/components.json lacks ${missing.join(', ')}`);
  const planned = plan({ sha: 'f'.repeat(40), sources, baselines: {}, ledger: emptyLedger(), changedSince: () => [], isAncestor: () => true });
  if (planned.length !== recipes.length || parseSnapshot('Rollback snapshot: /x\n') !== '/x') throw new Error('Deploy planning self-check failed');
  return { decision: 'self-check', tool: 'deploy', root, installerRoot: ROOT };
}

/** Run every tool's self-check in `root` (a tree or the `current` link) under a read-only,
 * no-subprocess Node permission model and a timeout; each must report the expected tree. */
function checkTools(effects: Effects, root: string, expected: string): void {
  for (const [script, arg] of toolChecks) {
    let stdout: string;
    try { ({ stdout } = effects.run(process.execPath, ['--permission', '--allow-fs-read=*', join(root, script), arg], { cwd: root, timeout: CHECK_TIMEOUT_MS })); } catch (error) {
      throw new Error(`${script} ${arg} failed in ${root}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
    }
    let report: { decision?: string; root?: string };
    try { report = JSON.parse(stdout.trim().split('\n').at(-1) ?? ''); } catch { report = {}; }
    if (report.decision !== 'self-check' || report.root !== expected) throw new Error(`${script} ${arg} did not report a self-check of ${expected}`);
  }
}

const readLink = (path: string) => { try { return readlinkSync(path); } catch (error) { if (absent(error)) return null; throw error; } };

/** Atomically point `link` at `target` (relative), or remove it when there was no link. */
function setLink(link: string, target: string | null): void {
  if (target === null) { rmSync(link, { force: true }); return; }
  const next = `${link}.next-${randomUUID()}`;
  symlinkSync(target, next);
  try { renameSync(next, link); } finally { rmSync(next, { force: true }); }
}

/** An existing version is immutable: reused only when it records the same commit, never replaced. */
function stageTools(effects: Effects, record: ToolsRecord): string {
  const dir = join(effects.toolsDir, record.tag);
  if (existsSync(dir)) {
    const marker = JSON.parse(readFileSync(join(dir, '.factory-tools.json'), 'utf8')) as Partial<ToolsRecord>;
    if (marker.sha !== record.sha) throw new Error(`${dir} records ${marker.sha}, not ${record.sha}; refusing to replace a tools version`);
    return dir;
  }
  mkdirSync(effects.toolsDir, { recursive: true });
  const staging = mkdtempSync(join(effects.toolsDir, `.stage-${record.tag}-`));
  try {
    effects.run('git', ['-C', ROOT, 'archive', '--format=tar', '-o', `${staging}.tar`, record.sha]);
    effects.run('tar', ['--no-same-owner', '-xf', `${staging}.tar`, '-C', staging]);
    writeFileSync(join(staging, '.factory-tools.json'), `${JSON.stringify({ tag: record.tag, sha: record.sha })}\n`);
    renameSync(staging, dir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(`${staging}.tar`, { force: true });
  }
  effects.log('tools-staged', { tag: record.tag, sha: record.sha, dir });
  return dir;
}

/**
 * Advance `<toolsDir>/current` to `tag`, a release this job verified, never backwards. The
 * pending promotion is saved before staging; a crash retries it, and only a passing check of the
 * candidate and then of the link (activation) records `current`. A failed check restores the
 * prior link and rejects that tag; a staging error keeps it pending. Installers stay in TRUSTED.
 */
export function promoteTools(effects: Effects, tag: string): void {
  const ledger = effects.readLedger();
  const tools = ledger.tools ?? {};
  const link = join(effects.toolsDir, 'current');
  let pending = tools.pending;
  if (pending) effects.log('tools-resume', pending);
  else {
    if (tools.rejected?.tag === tag || (tools.current && compareTags(tag, tools.current.tag) <= 0)) return;
    const marker = join(effects.stateDir, 'releases', tag, '.verified');
    if (!existsSync(marker)) { effects.log('tools-waiting', { tag, reason: 'release not verified by this deployer' }); return; }
    pending = { tag, sha: readFileSync(marker, 'utf8').trim(), installerSha: effects.run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).stdout.trim(), previous: readLink(link) };
    effects.writeLedger({ ...ledger, tools: { ...tools, pending } });
  }
  const { previous, ...record } = pending;
  const dir = stageTools(effects, record);
  const expected = realpathSync(dir);
  try {
    checkTools(effects, dir, expected);
    setLink(link, record.tag);
    if (realpathSync(link) !== expected) throw new Error(`${link} does not resolve to ${expected}`);
    checkTools(effects, link, expected);
  } catch (error) {
    setLink(link, previous);
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    effects.writeLedger({ ...effects.readLedger(), tools: { current: tools.current, rejected: { ...record, reason } } });
    effects.log('tools-rejected', { ...record, reason, restored: previous });
    throw new Error(`Tools ${record.tag} rejected; ${link} restored to ${previous ?? 'none'}: ${reason}`);
  }
  effects.writeLedger({ ...effects.readLedger(), tools: { current: record, rejected: tools.rejected } });
  // Installers never advance here: a release that changes them waits for Devon to restage TRUSTED.
  const installers = effects.run('git', ['-C', ROOT, 'diff', '--name-only', record.installerSha, record.sha, '--', 'deploy']).stdout.split('\n').filter(Boolean);
  effects.log('tools-promoted', { ...record, link, root: expected, installerRoot: ROOT, installerChanges: installers });
}

export function liveEffects(): Effects {
  const log: Effects['log'] = (decision, details = {}) => console.log(JSON.stringify({ decision, ...details }));
  const run: Effects['run'] = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: options.cwd, timeout: options.timeout, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  const issueQuery = 'query Issue($id: String!) { issue(id: $id) { id state { name } } }';
  type IssueData = { issue: { id: string; state: { name: string } } };
  type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  /** Every page of a connection; a page without a cursor to continue from is a failed read, never the end. */
  async function all<T>(read: (after: string | null) => Promise<Page<T>>): Promise<T[]> {
    const nodes: T[] = [];
    for (let after: string | null = null; ;) {
      const page = await read(after);
      nodes.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return nodes;
      if (!page.pageInfo.endCursor) throw new Error('Linear page has more results but no cursor');
      after = page.pageInfo.endCursor;
    }
  }
  const comments = (identifier: string) => all(async after => (await graphql<{ issue: { comments: Page<{ body: string; createdAt: string }> } }>(
    'query Comments($id: String!, $after: String) { issue(id: $id) { comments(first: 250, after: $after) { nodes { body createdAt } pageInfo { hasNextPage endCursor } } } }',
    { id: identifier, after })).issue.comments);
  return {
    stateDir: STATE_DIR,
    toolsDir: TOOLS_DIR,
    trustedDir: TRUSTED,
    log,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    run,
    ok: (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status === 0,
    sudo: (script, args) => {
      const result = spawnSync('sudo', ['-n', '/usr/bin/bash', join(TRUSTED, script), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
    },
    probe: url => run('curl', ['-fsS', '--max-time', '10', url]).stdout,
    readLedger: () => JSON.parse(readFileSync(LEDGER, 'utf8')) as Ledger,
    writeLedger: (ledger, options) => {
      mkdirSync(STATE_DIR, { recursive: true });
      const body = `${JSON.stringify(ledger, null, 2)}\n`;
      if (options?.create) {
        // link(2) publishes the complete file atomically and fails with EEXIST instead of replacing.
        // The staging name is this call's alone: a crash after the link must not leave the ledger
        // hard-linked to the `.tmp` that ordinary writes truncate.
        const staging = `${LEDGER}.create-${randomUUID()}`;
        writeFileSync(staging, body, { flag: 'wx' });
        try { linkSync(staging, LEDGER); } finally { rmSync(staging, { force: true }); }
        return;
      }
      writeFileSync(`${LEDGER}.tmp`, body);
      renameSync(`${LEDGER}.tmp`, LEDGER);
    },
    linear: {
      deploying: async identifier => (await graphql<IssueData>(issueQuery, { id: identifier })).issue.state.name === 'Deploying',
      posted: async (identifier, body) => (await comments(identifier)).some(comment => comment.body.trim() === body),
      comment: async (identifier, body) => {
        const { issue } = await graphql<IssueData>(issueQuery, { id: identifier });
        await graphql('mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: issue.id, body } });
      },
      deployingIssues: async () => (await all(async after => (await graphql<{ issues: Page<{ identifier: string }> }>(
        'query Deploying($after: String) { issues(first: 100, after: $after, filter: { state: { name: { eq: "Deploying" } }, labels: { name: { eq: "odd" } } }) { nodes { identifier } pageInfo { hasNextPage endCursor } } }',
        { after })).issues)).map(issue => issue.identifier),
      comments,
    },
  };
}

// argv[1] is the `current` link path; import.meta.url is the version it resolves to.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const run = async () => {
    if (args.length === 1 && args[0] === '--self-check') return console.log(JSON.stringify(selfCheck()));
    const effects = liveEffects();
    if (!args.length) return main(effects);
    if (args[0] === '--bootstrap' && args.length === 2 && semver(args[1])) return bootstrap(effects, args[1]);
    if (args[0] !== 'reconcile-manual' || !semver(args[1] ?? '') ||
        !(args.length === 2 || (args.length === 4 && args[2] === '--approve' && /^[a-f0-9]{64}$/.test(args[3])))) {
      throw new Error('Usage: deploy.ts [--bootstrap TAG | reconcile-manual TAG [--approve PREVIEW_SHA256]]');
    }
    await reconcileManual(effects, args[1], args[3]);
  };
  run().catch(error => { console.error(String(error instanceof Error ? error.message : error)); process.exit(1); });
}
