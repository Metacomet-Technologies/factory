// Outcome driven development: the deterministic lifecycle (docs/odd/README.md §4-§8).
// Pure functions only. The control-plane plugin (.amp/plugins/factory-odd.ts) and
// the runner backstop both derive state from Linear and GitHub and call nextAction.

import { createHash } from 'node:crypto';

export const roles = ['intake', 'spec', 'builder', 'reviewer', 'shipper', 'deployer', 'verifier', 'watchdog'] as const;
export type Role = typeof roles[number];
export type Executor = 'orb' | 'runner' | 'none';

export type RoleContract = {
  executor: Executor;
  /** Agent turns the plugin may chain after the first one (Ralph loop). 0 = deterministic job. */
  continuations: number;
  /** Full attempts (fresh threads or rounds) per issue before Watchdog escalates. */
  rounds: number;
  /** External condition that ends the loop. Checked by the control plane, never self-reported. */
  stop: 'issue-triaged' | 'spec-complete' | 'pr-open-ci-green' | 'verdict-posted' | 'merged' | 'deploy-receipt' | 'done-means-verified' | 'none';
  skill: string;
};

export const contracts: Record<Role, RoleContract> = Object.freeze({
  intake:   { executor: 'orb',    continuations: 2, rounds: 1, stop: 'issue-triaged',       skill: 'odd-intake' },
  spec:     { executor: 'orb',    continuations: 3, rounds: 1, stop: 'spec-complete',       skill: 'odd-spec' },
  builder:  { executor: 'orb',    continuations: 8, rounds: 3, stop: 'pr-open-ci-green',    skill: 'odd-builder' },
  // One retry after the Watchdog cancels a stuck thread; the second spent round pages (budget-ceiling).
  reviewer: { executor: 'orb',    continuations: 2, rounds: 2, stop: 'verdict-posted',      skill: 'odd-reviewer' },
  shipper:  { executor: 'none',   continuations: 0, rounds: 1, stop: 'merged',              skill: 'odd-shipper' },
  deployer: { executor: 'runner', continuations: 0, rounds: 1, stop: 'deploy-receipt',      skill: 'odd-deployer' },
  verifier: { executor: 'orb',    continuations: 2, rounds: 2, stop: 'done-means-verified', skill: 'odd-verifier' },
  watchdog: { executor: 'none',   continuations: 0, rounds: 1, stop: 'none',                skill: 'odd-watchdog' },
});

/** Soft caps: orbs and runner slots count running role threads; buildIssues counts issues with a live builder thread. */
export const capacity = Object.freeze({ orbs: 4, runnerSlots: 2, buildIssues: 2 });

/** Linear label that hands an issue to ODD from Todo on; without it the dispatcher owns Todo and later. */
export const oddLabel = 'odd';
/** Linear label the control plane sets when a round budget is spent; it waits while the label is present. */
export const escalatedLabel = 'escalated';

/** `Unknown` is any Linear status not listed here (snapshot.ts keeps its name in `unknownStatus`); it pages, never parks as Backlog. */
export type Status = 'Backlog' | 'Triage' | 'Todo' | 'In Progress' | 'In Review' | 'Deploying' | 'Done' | 'Canceled' | 'Duplicate' | 'Unknown';
export type RiskClass = 'ordinary' | 'security' | 'authority' | 'irreversible';
export type Verdict = { state: 'ready' | 'changes'; sha: string };

export type IssueSnapshot = {
  identifier: string;
  status: Status;
  /** The Linear status name when `status` is `Unknown`. */
  unknownStatus?: string;
  labels: readonly string[];
  description: string;
  openBlockers: readonly string[];
  risk?: RiskClass;
  /**
   * Live thread owning the issue, derived from Amp thread labels odd-issue-<id>, odd-role-<role>, odd-round-<n>.
   * `idleSince` is the thread's last activity: thread search `updatedAt`, or for a running owner its agent state's `updatedAt` (P3.10). The Watchdog cancels an idle or running owner after `staleMs` without activity.
   */
  owner?: { role: Role; threadID: string; round: number; state: 'idle' | 'running' | 'awaiting-approval' | 'error'; idleSince?: string };
  /**
   * `changesRounds` counts the distinct `changes` verdicts on this issue: the builder thread persists across rounds, so rounds live on the reviewer side.
   * `headAt` is the head commit's time and `mergedAt` the merge time (GitHub); either is absent when GitHub did not report it.
   * `conflicting` is GitHub's `mergeable: CONFLICTING`: CI never runs on such a head, so the builder must rebase.
   */
  pr?: { number: number; headSha: string; ci: 'pending' | 'success' | 'failure'; verdict?: Verdict; merged: boolean; mergeSha?: string; changesRounds?: number; headAt?: string; mergedAt?: string; conflicting?: boolean };
  /** Latest `odd-deploy` receipt posted after the latest `odd-merge` receipt (scripts/odd/deploy.ts posts one per release per issue). */
  deployReceipt?: DeployReceipt;
  /** Latest `odd-verify` comment (the Verifier's judgement); it counts only when its SHA is the receipt's. */
  verify?: Verify;
  /** The Verifier's `odd_verify` output for the current receipt (labels on its own thread, snapshot.verifiedFor); the control plane records it as the `odd-verify` comment. */
  verified?: Verify;
  /** Highest `odd-round-<n>` per role among live threads that have not produced their artifact (snapshot.ts `delivered`). */
  openRounds?: Partial<Record<Role, number>>;
  /** Rounds the Watchdog cancelled per role since the current correction epoch began (`odd-watchdog cancelled` comments); verifier rounds since the latest receipt. */
  cancelledRounds?: Partial<Record<Role, number>>;
  /** Steers delivered to the builder (`odd-steer` comments, written only after delivery): steer key -> comment `createdAt` ('' when Linear gave none). */
  steers?: Readonly<Record<string, string>>;
  /** Spawn records (`odd-spawn` comments), one per role, round and key; `thread` is absent while the create is unconfirmed. */
  spawns?: SpawnRecord[];
  /** The escalation latch (`odd-escalated … done=`) no `odd-resume` has released; absent for legacy escalations, whose label alone holds. */
  escalation?: Escalation;
  /** The correction epoch and its budget (snapshot.toSnapshot). Absent only in hand-built snapshots, read as a fresh epoch 1. */
  correction?: Correction;
};

/**
 * Escalation (§8) is a latch: the `odd-escalated` comment is written before any side effect and
 * records each step once it succeeded, so a partial failure is retried step by step while the
 * issue holds. `id` is the comment's; a latch without one can never be released.
 */
export const escalationSteps = ['label', 'draft', 'page', 'archive'] as const;
export type EscalationStep = typeof escalationSteps[number];
export type Escalation = { id?: string; reason: PageReason; pr?: number; sha?: string; done: readonly EscalationStep[]; detail: string };

/**
 * The outcome correction budget (MET-348): a fixed wall-clock window granted per epoch and bound
 * to the issue's accepted contract, never to a head or a worker. Epoch 1 starts with the issue;
 * each `odd-resume` (or a legacy `odd-escalated` comment) starts the next. `corrected` says a
 * `changes` steer was delivered in this epoch without a budget (a legacy history); `invalid`
 * names budget state that cannot be trusted, which holds the issue instead of granting time.
 */
export type Budget = { epoch: number; start: string; deadline: string; contract: string };
export type Correction = { epoch: number; corrected: boolean; budget?: Budget; invalid?: string };
export const correctionWindowMs = 120 * 60_000;
/** How far a budget's recorded start may sit from its comment's `createdAt`: a start Linear did not witness grants nothing. */
export const budgetSkewMs = 5 * 60_000;

/** What the budget binds to: Goal, Isolation, Build, Done means, Evidence and risk. Other sections and PR edits are cosmetic. */
export function contractOf(description: string, risk: RiskClass | undefined): string {
  const text = [...sections.map(heading => `${heading}\n${section(description, heading).split('\n').map(line => line.trimEnd()).join('\n')}`), `risk: ${risk ?? 'none'}`].join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** `component` is the `+`-joined set the release installed (`none` when it touched no enabled component), or the component that failed or was refused.
 * `rollback` is the restored snapshot, `unchanged` (fail only: refused before any change, prior healthy release re-proven), or `none`.
 * A complete receipt set (MET-386, pass only) adds `round`, the tag of the proven release `sha` that published it, and `set`, each
 * component the issue requires at its own healthy SHA and tag; `component` then joins exactly the set's components.
 * `tag` is the verified release the Deployer handled (MET-367; a set's `round`); receipts from before it carry none. */
export type DeployReceipt = { host: string; component: string; sha: string; tag?: string; health: 'pass' | 'fail' | 'refused'; rollback: 'none' | string; refusal?: Refusal; round?: string; set?: readonly ComponentIdentity[] };
export type ComponentIdentity = { component: string; sha: string; tag: string };

/** Why the Deployer installed nothing: the meter plan would change the DB generation (fresh, legacy or v1 migration) or could not be
 * classified, or an interrupted install's rollback snapshot is not proven free of a DB-generation restore (`snapshot`). */
export type Refusal = 'db-changing-fresh' | 'db-changing-legacy' | 'db-changing-v1' | 'db-changing-unknown' | 'db-changing-snapshot';

/** The Verifier's receipt: `bug` is the Bug issue it filed for a failing Done-means item. */
export type Verify = { sha: string; result: 'pass' | 'fail'; bug?: string };

export type Load = { orbs: number; runnerSlots: number; buildIssues: number };

/**
 * What a wait is for (audit P3.1). Machine waits page once per episode past their budget; human
 * waits (a risk decision, a failed verification) go to the daily digest instead. `since` is the
 * durable start (head commit, merge, steer comment, thread activity), never the last sweep; it is
 * absent when the source did not report it, and the age is then unknown, not zero. `key` names
 * the episode: it stays the same until the head, merge, thread or steer behind the wait changes.
 */
export type WaitKind = 'ci' | 'receipt' | 'steer' | 'approval' | 'activity' | 'risk' | 'verification';
export type Wait = { kind: WaitKind; key: string; since?: string };

/** `activity` (P3.10) is a running owner's last activity: past its budget the Watchdog cancels the thread instead of paging. */
export const waitBudgets: Readonly<Record<WaitKind, { notify: 'page' | 'cancel'; ms: number } | { notify: 'digest' }>> = Object.freeze({
  ci: { notify: 'page', ms: 60 * 60_000 },
  receipt: { notify: 'page', ms: 2 * 60 * 60_000 },
  steer: { notify: 'page', ms: 30 * 60_000 },
  approval: { notify: 'page', ms: 30 * 60_000 },
  activity: { notify: 'cancel', ms: 15 * 60_000 },
  risk: { notify: 'digest' },
  verification: { notify: 'digest' },
});

/** A machine wait is overdue at its budget exactly; one with no durable start has an unknown age. */
export function waitAge(wait: Wait, now: number): { state: 'human' } | { state: 'unknown' } | { state: 'within' | 'over'; ageMs: number } {
  const budget = waitBudgets[wait.kind];
  if (budget.notify === 'digest') return { state: 'human' };
  const since = wait.since ? Date.parse(wait.since) : Number.NaN;
  if (Number.isNaN(since)) return { state: 'unknown' };
  const ageMs = now - since;
  return { state: ageMs >= budget.ms ? 'over' : 'within', ageMs };
}

const waiting = (reason: string, kind: WaitKind, key: string, since?: string): Extract<Action, { kind: 'wait' }> =>
  ({ kind: 'wait', reason, wait: { kind, key, ...(since ? { since } : {}) } });

export type Action =
  | { kind: 'spawn'; role: Role; executor: Executor; reason: string; round: number }
  /** `key` names the steer (`<cause>-<head12>`); the control plane writes `odd-steer key=<key>` after delivering it. */
  | { kind: 'steer'; role: Role; threadID: string; key: string; message: string }
  | { kind: 'merge'; pr: number; sha: string }
  | { kind: 'set-status'; status: Status; reason: string; followUp?: { title: string; body: string }; diagnose?: DeployReceipt }
  /** `latch` is an escalation already recorded; the control plane finishes its missing steps instead of starting another. */
  | { kind: 'page'; reason: PageReason; detail: string; pr?: number; sha?: string; diagnose?: DeployReceipt; latch?: { id: string; done: readonly EscalationStep[] } }
  /** Record the epoch's correction budget (`odd-budget`) before the first correction of the epoch is steered or spawned. */
  | { kind: 'admit'; budget: Budget }
  /** Devon removed `escalated` from a latched issue: record `odd-resume`, which starts the next epoch once. */
  | { kind: 'resume'; escalation: string; epoch: number }
  /** Write the Verifier's `odd_verify` output as the complete `odd-verify` comment (verifyLine) for the receipt SHA. */
  | { kind: 'record-verify'; verify: Verify }
  /** `stuck` names the idle role whose thread the wait depends on; the Watchdog cancels it once stale. */
  | { kind: 'wait'; reason: string; stuck?: Role; wait?: Wait };

/** `diagnose` on a red deploy: after acting, the control plane starts one log-reading Deployer on the receipt's host (odd-deployer skill). */
export type PageReason = 'third-failed-qa-round' | 'failed-rollback' | 'irreversible-action' | 'security-finding' | 'budget-ceiling' | 'control-plane-blind' | 'control-plane-silent' | 'subscription-mismatch' | 'wait-overdue' | 'action-failed' | 'plane-blocked' | 'unknown-status';

/** What happens when Devon does not answer a page (docs/odd/README.md §8); every page states it. */
export const pageDefaults: Record<PageReason, string> = Object.freeze({
  'third-failed-qa-round': 'issue stays In Progress and the PR stays a draft until the `escalated` label is removed',
  'failed-rollback': 'recovery is not confirmed: the component may stay degraded on the failed release or in an unknown state and needs attention; nothing pauses, and the next release retries it',
  'irreversible-action': 'not executed',
  'security-finding': 'issue stays In Progress; nothing merges',
  'budget-ceiling': 'nothing more is started, steered or merged for the issue; running work and its results are kept until the `escalated` label is removed',
  'control-plane-blind': 'the runner backstop poller runs the lifecycle at 60 s cadence',
  'control-plane-silent': 'the runner backstop poller runs the lifecycle until a fresh heartbeat',
  'subscription-mismatch': 'roles keep their pinned models; nothing is relaunched on another engine',
  'wait-overdue': 'the issue keeps waiting; nothing is cancelled or escalated',
  'action-failed': 'every evaluation retries the action; nothing is recovered automatically',
  'plane-blocked': 'the build slots stay occupied; nothing is freed, replaced or recovered automatically',
  'unknown-status': 'nothing is started, steered, merged, archived or moved for the issue until the `escalated` label is removed',
});

/** The one page format (§8): `ODD page: <condition> | issue MET-<n> | <pr or host> | <sha> | default if silent: <action>`. */
export function pageText(issue: string, action: Extract<Action, { kind: 'page' }>): string {
  const where = action.pr !== undefined ? `PR #${action.pr}` : action.diagnose ? `host ${action.diagnose.host}` : '-';
  const sha = action.sha ?? action.diagnose?.sha ?? '-';
  return `ODD page: ${action.reason} | issue ${issue} | ${where} | ${sha} | default if silent: ${pageDefaults[action.reason]}. ${action.detail}`;
}

/**
 * The control plane's heartbeat (docs/odd/README.md §9). One Software Factory project status
 * update, rewritten after each successful sweep. The runner poller reads it; plugin thread
 * state is not readable from factory-gpu.
 */
export const heartbeatProject = 'Software Factory';
export const heartbeatProjectId = '8f96ac34-a8ba-4328-933d-9f0ab063fa23';
/** A heartbeat this old, or missing, means the control plane is silent and the poller runs the lifecycle. */
export const silenceMs = 20 * 60_000;

export const heartbeatLine = (at: string) => `odd-heartbeat at=${at}`;

/** The timestamp of an `odd-heartbeat` line, or nothing when the body is not one. */
export function parseHeartbeat(text: string): string | undefined {
  const match = /^odd-heartbeat at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/m.exec(text);
  if (!match || Number.isNaN(Date.parse(match[1]))) return undefined;
  return match[1];
}

/** True when no heartbeat parses, or the newest one is `silenceMs` old or older. */
export function controlPlaneSilent(heartbeats: readonly string[], now: number): boolean {
  const times = heartbeats.map(parseHeartbeat).flatMap(at => (at === undefined ? [] : [Date.parse(at)]));
  if (!times.length) return true;
  return now - Math.max(...times) >= silenceMs;
}

export const verifyLine = (verify: Verify) => `odd-verify sha=${verify.sha} result=${verify.result} bug=${verify.bug ?? 'none'}`;

export function parseVerify(text: string): Verify | undefined {
  const match = /^odd-verify sha=([a-f0-9]{7,40}) result=(pass|fail) bug=(\S+)$/m.exec(text);
  if (!match) return undefined;
  return { sha: match[1], result: match[2] as Verify['result'], bug: match[3] === 'none' ? undefined : match[3].toUpperCase() };
}

export const steerLine = (key: string, threadID: string) => `odd-steer key=${key} thread=${threadID}`;

export function parseSteer(text: string): { key: string; threadID: string } | undefined {
  const match = /^odd-steer key=(\S+) thread=(\S+)$/m.exec(text);
  return match ? { key: match[1], threadID: match[2] } : undefined;
}

/** The latch's first line; the page detail follows after a blank line. Legacy latches carry only `reason=`. */
export const escalationLine = (latch: Omit<Escalation, 'id' | 'detail'>) =>
  `odd-escalated reason=${latch.reason} pr=${latch.pr ?? '-'} sha=${latch.sha ?? '-'} done=${latch.done.length ? escalationSteps.filter(step => latch.done.includes(step)).join(',') : '-'}`;

/** A latch; `legacy` for a pre-latch escalation comment (`odd-escalated reason=<r>` alone on its line); `malformed` for any other `odd-escalated` line. */
export function parseEscalation(text: string): Omit<Escalation, 'id'> | 'legacy' | 'malformed' | undefined {
  if (!/^odd-escalated\b/m.test(text)) return undefined;
  if (/^odd-escalated reason=[a-z-]+$/m.test(text)) return 'legacy';
  const match = /^odd-escalated reason=([a-z-]+) pr=(\d+|-) sha=([a-f0-9]{7,40}|-) done=((?:label|draft|page|archive)(?:,(?:label|draft|page|archive))*|-)$/m.exec(text);
  if (!match || !(match[1] in pageDefaults)) return 'malformed';
  const detail = text.slice(text.indexOf(match[0]) + match[0].length).trim();
  return { reason: match[1] as PageReason, ...(match[2] !== '-' ? { pr: Number(match[2]) } : {}), ...(match[3] !== '-' ? { sha: match[3] } : {}), done: match[4] === '-' ? [] : match[4].split(',') as EscalationStep[], detail };
}

export const budgetLine = (budget: Budget) => `odd-budget epoch=${budget.epoch} start=${budget.start} deadline=${budget.deadline} contract=${budget.contract}`;

/** A budget record, `malformed` for an `odd-budget` line that does not parse or whose deadline is not its start plus the window. */
export function parseBudget(text: string): Budget | 'malformed' | undefined {
  if (!/^odd-budget\b/m.test(text)) return undefined;
  const match = /^odd-budget epoch=([1-9]\d*) start=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) deadline=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) contract=([a-f0-9]{12})$/m.exec(text);
  if (!match || Date.parse(match[3]) - Date.parse(match[2]) !== correctionWindowMs) return 'malformed';
  return { epoch: Number(match[1]), start: match[2], deadline: match[3], contract: match[4] };
}

export const resumeLine = (escalation: string, epoch: number) => `odd-resume escalation=${escalation} epoch=${epoch}`;

export function parseResume(text: string): { escalation: string; epoch: number } | 'malformed' | undefined {
  if (!/^odd-resume\b/m.test(text)) return undefined;
  const match = /^odd-resume escalation=(\S+) epoch=([1-9]\d*)$/m.exec(text);
  return match ? { escalation: match[1], epoch: Number(match[2]) } : 'malformed';
}

export const cancelledLine = (role: Role, threadID: string, round: number) => `odd-watchdog cancelled role=${role} thread=${threadID} round=${round}`;

export function parseCancelled(text: string): { role: Role; threadID: string; round: number } | undefined {
  const match = /^odd-watchdog cancelled role=(\S+) thread=(\S+) round=(\d+)$/m.exec(text);
  if (!match || !roles.includes(match[1] as Role)) return undefined;
  return { role: match[1] as Role, threadID: match[2], round: Number(match[3]) };
}

/**
 * A spawn record (P4.1): the plane writes `thread=pending` before it creates a role thread and
 * the same line with the returned thread ID before it sends the outcome. Records are append-only:
 * a role, round and key stays pending until a bound line for it exists. `key` names the stage the
 * spawn serves: the role, plus the PR head for a reviewer and the receipt for a verifier.
 */
export type SpawnRecord = { role: Role; round: number; key: string; thread?: string };

export const spawnLine = (record: SpawnRecord) => `odd-spawn role=${record.role} round=${record.round} key=${record.key} thread=${record.thread ?? 'pending'}`;

export function parseSpawn(text: string): SpawnRecord | undefined {
  const match = /^odd-spawn role=(\S+) round=(\d+) key=(\S+) thread=(pending|T-\S+)$/m.exec(text);
  if (!match || !roles.includes(match[1] as Role)) return undefined;
  return { role: match[1] as Role, round: Number(match[2]), key: match[3], ...(match[4] === 'pending' ? {} : { thread: match[4] }) };
}

/** The stage key of a spawn of `role` on `issue`: the reviewer's head and the verifier's receipt (12-character prefixes). */
export function spawnKey(issue: Pick<IssueSnapshot, 'pr' | 'deployReceipt'>, role: Role): string {
  if (role === 'reviewer' && issue.pr) return `reviewer-${issue.pr.headSha.slice(0, 12)}`;
  if (role === 'verifier' && issue.deployReceipt) return `verifier-${issue.deployReceipt.sha.slice(0, 12)}`;
  return role;
}

const sections = ['## Goal', '## Isolation', '## Build', '## Done means', '## Evidence'] as const;

function section(description: string, heading: string): string {
  const lines = description.split('\n');
  const start = lines.findIndex(line => line.trim() === heading);
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

const bullets = (text: string) => text.split('\n').filter(line => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line));

/** A spec is complete when every section exists and each Done-means item has an Evidence line. */
export function specComplete(description: string): boolean {
  if (sections.some(heading => !section(description, heading))) return false;
  const done = bullets(section(description, '## Done means')).length;
  const evidence = bullets(section(description, '## Evidence')).length;
  return done > 0 && evidence >= done;
}

export const typeLabels = ['Bug', 'Feature', 'Improvement'] as const;

/** Intake's stop condition: the issue is in Triage with exactly one type label and an area label. */
export function issueTriaged(issue: { status: string; labels: readonly string[] }): string[] {
  const missing: string[] = [];
  if (issue.status !== 'Triage') missing.push(`status is ${issue.status}, not Triage`);
  if (issue.labels.filter(label => (typeLabels as readonly string[]).includes(label)).length !== 1) missing.push('exactly one of Bug, Feature, Improvement');
  if (!issue.labels.some(label => label.startsWith('area:') || label.startsWith('area/'))) missing.push('an area:* label');
  return missing;
}

/** A rollback Bug's area label, from its receipt component; components without their own area (the tooling ones) are ops. */
export const rollbackArea = (component: string) => ({ meter: 'area:meter', 'factory-api': 'area:api', kiosk: 'area:kiosk' } as Record<string, string>)[component] ?? 'area:ops';

/** A rollback Bug's identity, a line of its description: source issue, component and failed release. Its title may be edited; this line identifies it. */
export const rollbackBugKey = (source: string, receipt: DeployReceipt) => `odd-rollback-bug source=${source} component=${receipt.component} sha=${receipt.sha}`;

const releaseTag = /^v\d+\.\d+\.\d+$/;

/** An invalid tag, or a set's tag other than its round, throws: a receipt never names anything but its own `vX.Y.Z` release. */
export const deployReceiptLine = (receipt: DeployReceipt) => {
  if (receipt.tag !== undefined && (!releaseTag.test(receipt.tag) || (receipt.set && receipt.tag !== receipt.round))) {
    throw new Error(`Deploy receipt tag ${receipt.tag} is not a vX.Y.Z release${receipt.set ? ` equal to its round ${receipt.round}` : ''}`);
  }
  return `odd-deploy host=${receipt.host} component=${receipt.component} sha=${receipt.sha}${receipt.tag ? ` tag=${receipt.tag}` : ''} health=${receipt.health} rollback=${receipt.rollback}${receipt.refusal ? ` refusal=${receipt.refusal}` : ''}` +
    (receipt.set ? ` round=${receipt.round} set=${receipt.set.map(entry => `${entry.component}:${entry.sha}@${entry.tag}`).join(',')}` : '');
};

/**
 * Legacy pass/fail and tagless receipts parse unchanged; a malformed `tag=`, or a set's `tag` other than its `round`, does not parse. `health=refused` needs `rollback=none` and a known `refusal=`, which no other receipt may carry.
 * A receipt set (`round=<tag> set=<component>:<sha40>@<tag>,...`) is pass with `rollback=none` only, names each component once, and its
 * `component=` joins exactly those names: a set that disagrees with itself does not parse.
 */
export function parseDeployReceipt(text: string): DeployReceipt | undefined {
  const match = /^odd-deploy host=(\S+) component=(\S+) sha=([a-f0-9]{7,40})(?: tag=(v\d+\.\d+\.\d+))? health=(pass|fail|refused) rollback=(\S+)(?: refusal=(db-changing-(?:fresh|legacy|v1|unknown|snapshot)))?(?: round=(v\d+\.\d+\.\d+) set=(\S+))?$/m.exec(text);
  if (!match) return undefined;
  const [, host, component, sha, tag, health, rollback, refusal, round, entries] = match;
  const refused = health === 'refused';
  if (refused !== (refusal !== undefined) || (refused && rollback !== 'none') || (rollback === 'unchanged' && health !== 'fail')) return undefined;
  const receipt: DeployReceipt = { host, component, sha, ...(tag ? { tag } : {}), health: health as DeployReceipt['health'], rollback, ...(refused ? { refusal: refusal as Refusal } : {}) };
  if (round === undefined) return receipt;
  if (tag && tag !== round) return undefined;
  const set = entries.split(',').map(entry => /^([a-z][a-z0-9-]*):([a-f0-9]{40})@(v\d+\.\d+\.\d+)$/.exec(entry));
  if (receipt.health !== 'pass' || receipt.rollback !== 'none' || set.some(entry => !entry)) return undefined;
  const names = set.map(entry => entry![1]);
  if (new Set(names).size !== names.length || names.join('+') !== receipt.component) return undefined;
  return { ...receipt, round, set: set.map(entry => ({ component: entry![1], sha: entry![2], tag: entry![3] })) };
}

/** Why a spawn of `role` must wait at `load`, or undefined when it fits its executor's cap; `newBuild` is a builder for an issue without one. */
export function capacityWait(role: Role, load: Load, newBuild: boolean): string | undefined {
  const { executor } = contracts[role];
  if (role === 'builder' && newBuild && load.buildIssues >= capacity.buildIssues) return `build capacity (${load.buildIssues}/${capacity.buildIssues} issues)`;
  const free = executor === 'none' || (executor === 'orb' ? load.orbs < capacity.orbs : load.runnerSlots < capacity.runnerSlots);
  return free ? undefined : `${executor} capacity (${role})`;
}

/**
 * Spawn a fresh round of `role`, or wait: on capacity, or while an idle thread of the role is
 * live and the rounds are spent (a role that ends without reaching its stop condition must not
 * be respawned forever; the Watchdog cancels it once it is stale, see scripts/odd/watchdog.ts).
 * Cancelled rounds count too; once the budget is spent and no thread of the role is live, the
 * issue pages instead of waiting silently. Cancelled rounds restart with each correction epoch
 * (an `odd-resume` after Devon clears `escalated`), never at the escalation comment itself. Only `openRounds` counts live rounds: an
 * owner that delivered its artifact (a reviewer with a verdict for an older head, a verifier of an
 * older receipt) has finished its round and must not block the next one.
 */
function spawn(role: Role, load: Load, reason: string, issue: IssueSnapshot): Action {
  const { executor, rounds } = contracts[role];
  const live = issue.openRounds?.[role] ?? 0;
  const previous = Math.max(live, issue.cancelledRounds?.[role] ?? 0);
  if (previous >= rounds) {
    return live > 0
      ? { kind: 'wait', reason: `${role} round budget spent (${previous}/${rounds})`, stuck: role }
      : { kind: 'page', reason: 'budget-ceiling', detail: `${issue.identifier}: ${role} spent ${previous}/${rounds} rounds (${reason})`, pr: issue.pr?.number, sha: issue.pr?.headSha };
  }
  // An issue that already has a builder thread is inside the build count; only a new issue needs a free build slot.
  const full = capacityWait(role, load, live === 0);
  return full ? { kind: 'wait', reason: full } : { kind: 'spawn', role, executor, reason, round: previous + 1 };
}

/** A steer already delivered (an `odd-steer` comment) is not repeated: the issue waits for the builder's answer from the comment's time. */
function steer(issue: IssueSnapshot, threadID: string, key: string, message: string): Action {
  const at = issue.steers?.[key];
  return at === undefined ? { kind: 'steer', role: 'builder', threadID, key, message } : waiting(`steer ${key} unanswered`, 'steer', `steer-${key}`, at);
}

/** What the steer or spawn after the second rejected head adds (§7): the next handoff opens with a design reassessment. */
export const reassessment = 'Two or more heads were rejected: open your next handoff with a short design reassessment (the invariant, competing root-cause hypotheses, the probes that tell them apart, and the smallest shared fix) before patching findings.';

/** One line for a page: what the issue was doing or waiting on. */
const blocker = (action: Action): string => {
  switch (action.kind) {
    case 'wait': return action.reason;
    case 'page': return `${action.reason}: ${action.detail}`;
    case 'steer': return `steer ${action.key}`;
    case 'spawn': return `spawn ${action.role} (${action.reason})`;
    case 'merge': return `merge PR #${action.pr} at ${action.sha}`;
    case 'set-status': return `set ${action.status} (${action.reason})`;
    case 'admit': return `admit epoch ${action.budget.epoch}`;
    case 'resume': return `resume epoch ${action.epoch}`;
    case 'record-verify': return `record odd-verify ${action.verify.result} at ${action.verify.sha.slice(0, 12)}`;
  }
};

/**
 * Derive the single next action for one issue. Idempotent: the same snapshot and clock always
 * yield the same action. An escalation latch and the correction budget are judged first, so a
 * running worker never delays a page and nothing merges past the deadline.
 */
export function nextAction(issue: IssueSnapshot, load: Load, now = Date.now()): Action {
  const terminal = issue.status === 'Done' || issue.status === 'Canceled' || issue.status === 'Duplicate';
  return (terminal ? undefined : held(issue, load, now)) ?? proceed(issue, load, now);
}

/**
 * The escalation latch (§8): finish its missing steps; once Devon removes `escalated` from a
 * labelled latch, resume (the only path to a new epoch). Then the budget: untrusted state, a
 * changed contract or the deadline itself page `budget-ceiling` for an unmerged PR, whatever
 * else the issue is doing. The page holds subsequent actions; it cancels nothing.
 */
function held(issue: IssueSnapshot, load: Load, now: number): Action | undefined {
  const labelled = issue.labels.includes(escalatedLabel);
  const latch = issue.escalation;
  if (latch) {
    if (!latch.id) return { kind: 'wait', reason: 'escalated to Devon; the escalation comment has no id' };
    if (latch.done.includes('label') && !labelled) return { kind: 'resume', escalation: latch.id, epoch: (issue.correction?.epoch ?? 1) + 1 };
    const pending = escalationSteps.some(step => (step !== 'draft' || latch.pr !== undefined) && !latch.done.includes(step));
    if (!pending) return { kind: 'wait', reason: 'escalated to Devon' };
    const diagnose = latch.reason === 'failed-rollback' ? issue.deployReceipt : undefined;
    return { kind: 'page', reason: latch.reason, detail: latch.detail, pr: latch.pr, sha: latch.sha, ...(diagnose ? { diagnose } : {}), latch: { id: latch.id, done: latch.done } };
  }
  if (labelled) return { kind: 'wait', reason: 'escalated to Devon' };
  const { pr, correction } = issue;
  if ((issue.status !== 'In Progress' && issue.status !== 'In Review') || !pr || pr.merged) return undefined;
  const ceiling = (why: string): Action => ({ kind: 'page', reason: 'budget-ceiling', pr: pr.number, sha: pr.headSha,
    detail: `${issue.identifier}: ${why}. Head ${pr.headSha}; last blocker: ${blocker(proceed(issue, load, now))}.` });
  if (correction?.invalid) return ceiling(`correction budget state cannot be trusted (${correction.invalid}); no time is granted`);
  const budget = correction?.budget;
  if (!budget) return undefined;
  if (budget.contract !== contractOf(issue.description, issue.risk)) return ceiling(`the accepted contract changed after epoch ${budget.epoch}'s budget was granted and needs a human reassessment`);
  if (now >= Date.parse(budget.deadline)) return ceiling(`epoch ${budget.epoch} correction budget ended at ${budget.deadline} (granted ${budget.start}, ${correctionWindowMs / 60_000} min)`);
  return undefined;
}

function proceed(issue: IssueSnapshot, load: Load, now: number): Action {
  const { status, owner, pr } = issue;
  // A status the lifecycle does not know is never read as another one: it pages once (the latch holds it after).
  if (status === 'Unknown') return { kind: 'page', reason: 'unknown-status', detail: `${issue.identifier}: Linear status ${JSON.stringify((issue.unknownStatus ?? '').slice(0, 60))} is not one ODD knows; the issue is held, not parked as Backlog.` };
  if (owner?.state === 'awaiting-approval') return waiting(`${owner.role} awaiting approval`, 'approval', `approval-${owner.threadID}`, owner.idleSince);
  // P3.10: a running owner is aged by its last activity; the Watchdog cancels it once inactive past the budget.
  if (owner?.state === 'running') return { ...waiting(`${owner.role} running`, 'activity', `activity-${owner.threadID}`, owner.idleSince), stuck: owner.role };
  if (status === 'Done' || status === 'Canceled' || status === 'Duplicate') return { kind: 'wait', reason: status };

  // Backlog is triaged on demand: Devon moves an idea to Triage when it should enter the factory.
  if (status === 'Backlog') return { kind: 'wait', reason: 'backlog: triage on demand' };
  if (status === 'Triage') {
    const untriaged = issueTriaged(issue);
    if (untriaged.length) return spawn('intake', load, untriaged.join('; '), issue);
    if (specComplete(issue.description)) return { kind: 'set-status', status: 'Todo', reason: 'spec complete' };
    if (issue.risk && issue.risk !== 'ordinary') return waiting(`risk ${issue.risk} needs a human decision`, 'risk', `risk-${issue.risk}`);
    return spawn('spec', load, 'spec incomplete', issue);
  }
  if (status === 'Todo') {
    // A builder was spawned but the status change did not land: converge instead of spawning a second builder.
    if (owner?.role === 'builder') return { kind: 'set-status', status: 'In Progress', reason: `builder ${owner.threadID} owns it` };
    if (issue.openBlockers.length) return { kind: 'wait', reason: `blocked by ${issue.openBlockers.join(', ')}` };
    if (!specComplete(issue.description)) return { kind: 'set-status', status: 'Triage', reason: 'spec regressed' };
    return spawn('builder', load, 'ready to build', issue);
  }
  if (status === 'In Progress' || status === 'In Review') {
    // In Review means a reviewer thread is bound to a spawn record for the current green head and has not asked for changes.
    // A pending record (create unconfirmed) stays In Progress, where the spawn path pages it.
    const verdict = pr?.verdict?.sha === pr?.headSha ? pr?.verdict : undefined;
    const review = pr !== undefined && !pr.merged && !pr.conflicting && pr.ci === 'success' && verdict?.state !== 'changes'
      && (issue.spawns ?? []).some(record => record.role === 'reviewer' && record.thread !== undefined && record.key === spawnKey(issue, 'reviewer'));
    if (status === 'In Review' && !review && !pr?.merged) return { kind: 'set-status', status: 'In Progress', reason: verdict?.state === 'changes' ? `changes requested at ${verdict.sha.slice(0, 12)}` : `head ${pr?.headSha.slice(0, 12) ?? '(no PR)'} is not under review` };
    if (status === 'In Progress' && review) return { kind: 'set-status', status: 'In Review', reason: `reviewer recorded at ${pr!.headSha.slice(0, 12)}` };
    if (!pr) {
      if (owner?.role === 'builder' && owner.state === 'error') {
        return owner.round >= contracts.builder.rounds
          ? { kind: 'page', reason: 'third-failed-qa-round', detail: `${issue.identifier}: builder failed ${owner.round} rounds without a PR` }
          : spawn('builder', load, `builder round ${owner.round + 1}`, issue);
      }
      return owner?.role === 'builder' ? { kind: 'wait', reason: 'builder has not opened a PR', stuck: 'builder' } : spawn('builder', load, 'no builder thread', issue);
    }
    if (pr.merged) return { kind: 'set-status', status: 'Deploying', reason: `merged ${pr.mergeSha ?? ''}`.trim() };
    const head = pr.headSha.slice(0, 12);
    if (pr.conflicting) {
      return owner?.role === 'builder'
        ? steer(issue, owner.threadID, `conflict-${head}`, `PR #${pr.number} conflicts with main at ${pr.headSha}. Rebase onto origin/main, resolve the conflicts and push to the same branch; do not open a new PR.`)
        : spawn('builder', load, `PR #${pr.number} conflicts with main`, issue);
    }
    if (pr.ci === 'pending') return waiting(`ci pending at ${head}`, 'ci', `ci-${head}`, pr.headAt);
    if (pr.ci === 'failure') {
      return owner?.role === 'builder'
        ? steer(issue, owner.threadID, `ci-failed-${head}`, `CI failed at ${pr.headSha}. Fix the failing jobs and push; do not open a new PR.`)
        : spawn('builder', load, 'ci failed and no builder thread', issue);
    }
    if (!verdict) return spawn('reviewer', load, `no verdict at ${pr.headSha.slice(0, 12)}`, issue);
    if (verdict.state === 'ready') return { kind: 'merge', pr: pr.number, sha: pr.headSha };
    const round = pr.changesRounds ?? 1;
    const correction = issue.correction ?? { epoch: 1, corrected: false };
    if (!correction.budget) {
      // The epoch's first correction records its budget first. A legacy history (corrected without
      // a budget, or several rejected heads already) has an unknown age, so it keeps the round cap.
      if (!correction.corrected && round <= 1) {
        return { kind: 'admit', budget: { epoch: correction.epoch, start: new Date(now).toISOString(), deadline: new Date(now + correctionWindowMs).toISOString(), contract: contractOf(issue.description, issue.risk) } };
      }
      if (round >= contracts.builder.rounds) return { kind: 'page', reason: 'third-failed-qa-round', detail: `${issue.identifier}: PR #${pr.number} rejected ${round} times`, pr: pr.number, sha: pr.headSha };
    }
    const reassess = round >= 2 ? ` ${reassessment}` : '';
    return owner?.role === 'builder'
      ? steer(issue, owner.threadID, `changes-${head}`, `QA requested changes at ${pr.headSha}; see the odd-verdict comment on PR #${pr.number}. Address every finding, rerun the Evidence commands, push to the same branch.${reassess}`)
      : spawn('builder', load, `qa changes, round ${round + 1}${round >= 2 ? '; design reassessment required' : ''}`, issue);
  }
  // Deploying: the host Deployer (scripts/odd/deploy.ts) posts the receipt; the control plane never deploys.
  if (status === 'Deploying') {
    const receipt = issue.deployReceipt;
    if (!receipt) return waiting('release not published', 'receipt', `receipt-${(pr?.mergeSha ?? pr?.headSha ?? 'unknown').slice(0, 12)}`, pr?.mergedAt);
    const line = deployReceiptLine(receipt);
    // Nothing was installed, migrated or rolled back: neither a failed rollback nor a retry Bug. Devon decides.
    if (receipt.health === 'refused') {
      return { kind: 'page', reason: 'irreversible-action', sha: receipt.sha,
        detail: `${receipt.component} on ${receipt.host} not installed at ${receipt.sha} (${receipt.refusal}): automatic deploys never change the meter DB generation; migration stays Devon's explicit manual operation. ${line}` };
    }
    if (receipt.health === 'fail' && receipt.rollback === 'none') return { kind: 'page', reason: 'failed-rollback', detail: `${receipt.component} on ${receipt.host} unhealthy at ${receipt.sha}: ${line}`, diagnose: receipt };
    if (receipt.health === 'fail') {
      // `unchanged`: the installer refused before its snapshot and three probes found the exact prior healthy release; no rollback ran.
      const unchanged = receipt.rollback === 'unchanged';
      return { kind: 'set-status', status: 'Todo', diagnose: receipt,
        reason: unchanged ? `refused before change; ${receipt.component} still healthy on its previous release` : `rolled back to ${receipt.rollback}`,
        followUp: {
          title: `Deploy failed: ${receipt.component} at ${receipt.sha.slice(0, 12)}`,
          body: `${unchanged
            ? `The ${receipt.component} installer for ${issue.identifier} refused before changing anything on ${receipt.host}; no rollback ran, and three probes found the previous healthy release still serving.`
            : `${issue.identifier} was rolled back on ${receipt.host}.`}\n\n\`\`\`\n${line}\n\`\`\`\n\nRead \`journalctl -u factory-deploy\` on ${receipt.host} for the installer and probe output.`,
        } };
    }
    // Green receipt: the Verifier judges the Done-means items against the deployed system and
    // reports through `odd_verify`; the control plane writes `odd-verify` for the receipt's SHA (verifyLine). A failed verification waits on the
    // Bug it filed; the Deployer re-receipts the issue at the next pass release that contains the
    // failed SHA, even one that does not ship it (deploy.ts reconcile), and that SHA is verified again.
    const verify = issue.verify?.sha === receipt.sha ? issue.verify : undefined;
    if (!verify && issue.verified?.sha === receipt.sha) return { kind: 'record-verify', verify: issue.verified };
    if (!verify) return spawn('verifier', load, `verify ${receipt.component} at ${receipt.sha.slice(0, 12)}`, issue);
    if (verify.result === 'pass') return { kind: 'set-status', status: 'Done', reason: `verified ${receipt.component} at ${receipt.sha.slice(0, 12)}` };
    return waiting(`verification failed at ${receipt.sha.slice(0, 12)}; bug ${verify.bug ?? 'not filed'}`, 'verification', `verification-${receipt.sha.slice(0, 12)}`);
  }
  return { kind: 'wait', reason: `unknown status ${status}` };
}

/** Ralph guard: continue a role thread only while its external stop condition is unmet and budget remains. */
export function ralphGuard(input: { role: Role; chained: number; stopMet: boolean; missing: string[] }):
  { action: 'stop'; why: 'stop-met' | 'budget' } | { action: 'continue'; userMessage: string; maxContinuations: number } {
  const contract = contracts[input.role];
  if (input.stopMet) return { action: 'stop', why: 'stop-met' };
  if (input.chained >= contract.continuations) return { action: 'stop', why: 'budget' };
  const missing = input.missing.length ? input.missing.map(item => `- ${item}`).join('\n') : '- (no detail available)';
  return {
    action: 'continue',
    maxContinuations: contract.continuations,
    userMessage: `[odd:${input.role}] The outcome is not reached. External checks still missing:\n${missing}\nContinue the same outcome. Do not stop to report until the stop condition (${contract.stop}) is met.`,
  };
}

/** Amp thread labels (alphanumeric and hyphens only) that make execution state derivable without a ledger. */
export const threadLabels = (issue: string, role: Role, round: number) =>
  [`odd-issue-${issue.toLowerCase()}`, `odd-role-${role}`, `odd-round-${round}`];

export function parseThreadLabels(labels: readonly string[]): { issue?: string; role?: Role; round: number } {
  const get = (prefix: string) => labels.find(label => label.startsWith(prefix))?.slice(prefix.length);
  const role = get('odd-role-');
  return { issue: get('odd-issue-')?.toUpperCase(), role: roles.includes(role as Role) ? role as Role : undefined, round: Number(get('odd-round-') ?? 1) || 1 };
}
