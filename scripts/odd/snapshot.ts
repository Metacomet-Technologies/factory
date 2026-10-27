// Outcome driven development: derive an IssueSnapshot from what Linear, GitHub and Amp
// report (docs/odd/README.md §9). Pure functions; the control-plane plugin does the IO.

import { builderEngine, labOf } from './engines.ts';
import { budgetSkewMs, capacity, contracts, deployReceiptLine, parseBudget, parseCancelled, parseDeployReceipt, parseEscalation, parseResume, parseSpawn, parseSteer, parseThreadLabels, parseVerify, roles, type Correction, type DeployReceipt, type Escalation, type IssueSnapshot, type Load, type RiskClass, type Role, type SpawnRecord, type Status, type Verdict, type Verify } from './lifecycle.ts';

export type WebhookSource = 'linear' | 'github' | 'slack';

const identifierPattern = /^MET-[1-9]\d*$/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const record = (value: unknown) => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined);

/**
 * P3.13: Linear's documented Comment payload carries `data.issueId` (a UUID) and the comment's
 * `url` (`https://linear.app/<workspace>/issue/MET-<n>/<slug>#comment-<id>`), not always the
 * issue identifier. Only that exact host and path shape resolves; anything else is undefined.
 */
function identifierFromCommentUrl(event: Record<string, unknown>, data: Record<string, unknown>): string | undefined {
  if (event.type !== 'Comment' || typeof data.issueId !== 'string' || !uuidPattern.test(data.issueId) || typeof event.url !== 'string') return undefined;
  let url: URL;
  try { url = new URL(event.url); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.username || url.password || url.port) return undefined;
  const segment = /^\/[^/]+\/issue\/([^/]+)(?:\/[^/]*)?$/.exec(url.pathname)?.[1];
  return segment && identifierPattern.test(segment) ? segment.toUpperCase() : undefined;
}

/** The issue a webhook delivery is about, or undefined when the event is not issue-scoped. */
export function issueFromEvent(source: WebhookSource, body: string): string | undefined {
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return undefined; }
  const event = record(payload);
  if (!event) return undefined;
  if (source === 'linear') {
    const data = record(event.data);
    if (!data) return undefined;
    // An explicit identifier wins; a present but malformed one never falls back to the URL.
    const identifier = (record(data.issue) ?? data).identifier ?? data.identifier;
    if (identifier !== undefined) return typeof identifier === 'string' && identifierPattern.test(identifier) ? identifier.toUpperCase() : undefined;
    return identifierFromCommentUrl(event, data);
  }
  if (source === 'github') {
    const pr = event.pull_request as Record<string, unknown> | undefined;
    const head = pr?.head as Record<string, unknown> | undefined;
    // check_suite and workflow_run carry the branch at the top level, not under pull_request.
    const run = (event.check_suite ?? event.workflow_run) as Record<string, unknown> | undefined;
    const ref = typeof head?.ref === 'string' ? head.ref : typeof run?.head_branch === 'string' ? run.head_branch : '';
    const branch = /^met-(\d+)/i.exec(ref);
    if (branch) return `MET-${branch[1]}`;
    const text = typeof pr?.body === 'string' ? pr.body : '';
    const link = /\b(?:closes|contributes)\s+(MET-\d+)/i.exec(text);
    return link ? link[1].toUpperCase() : undefined;
  }
  return undefined;
}

/**
 * P3.13: the sanitized diagnostic for a Linear delivery that is about an issue (an Issue or
 * Comment, or any payload carrying `data.issueId`) but names no issue `issueFromEvent` accepts;
 * undefined when the delivery resolves or is not issue-scoped. Only the event type is kept, and
 * only when it is a plain word: never the payload, URL or anything signed.
 */
export function linearUnresolved(body: string): string | undefined {
  if (issueFromEvent('linear', body)) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return undefined; }
  const event = record(payload);
  const type = event?.type;
  if (type !== 'Issue' && type !== 'Comment' && record(event?.data)?.issueId === undefined) return undefined;
  return `linear-unresolved type=${typeof type === 'string' && /^[A-Za-z]{1,32}$/.test(type) ? type : 'unknown'}`;
}

/**
 * MET-339: the immutable Linear user IDs that author lifecycle markers, and the instant enforcement
 * began. `plane` writes every marker but receipts; `deployer` writes only `odd-deploy` receipts.
 */
export type Identity = { plane: string; deployer: string; since: string };

/**
 * The identity configuration `plane=<uuid> deployer=<uuid> since=<ISO-8601>` (ODD_IDENTITY on the
 * control orb, /etc/factory-dispatch/odd-identity on the host). Absent or blank is undefined:
 * enforcement is not activated. Anything else that does not parse exactly, or names one principal
 * for both, throws, so a broken activation fails closed instead of trusting every author.
 */
export function parseIdentity(text: string | undefined): Identity | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const match = new RegExp(`^plane=(${uuid}) deployer=(${uuid}) since=(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z)$`).exec(text.trim());
  if (!match || Number.isNaN(Date.parse(match[3]))) throw new Error('ODD identity configuration is malformed; expected plane=<uuid> deployer=<uuid> since=<ISO-8601>');
  if (match[1] === match[2]) throw new Error('ODD identity configuration names one principal as both plane and deployer');
  return { plane: match[1], deployer: match[2], since: match[3] };
}

/** A comment as read, with its author's immutable Linear user ID when the read reports one. */
export type AuthoredComment = { id?: string; body: string; createdAt?: string; author?: { id?: string } | null };

const receiptLinePattern = /^odd-deploy\b/;

/**
 * MET-339: the comments whose lifecycle markers count. Before activation (`identity` undefined)
 * every comment does. After it, a comment counts only by its author's user ID, never a display name:
 * a `deployer` comment keeps only its `odd-deploy` lines; a `plane` comment keeps every other line,
 * and its `odd-deploy` lines only when created before `since` (the host deployer wrote receipts with
 * the plane principal's key until then). Any other author, or none, contributes nothing.
 */
export function trustedComments<T extends AuthoredComment>(comments: readonly T[], identity: Identity | undefined): T[] {
  if (!identity) return [...comments];
  const since = Date.parse(identity.since);
  return comments.flatMap(comment => {
    const author = comment.author?.id;
    const keep = author === identity.deployer ? (line: string) => receiptLinePattern.test(line)
      : author === identity.plane ? (line: string) => !receiptLinePattern.test(line) || Date.parse(comment.createdAt ?? '') < since
        : undefined;
    return keep ? [{ ...comment, body: comment.body.split('\n').filter(keep).join('\n') }] : [];
  });
}

/** Subset of the Linear MCP `get_issue` result the lifecycle needs. */
export type LinearIssue = {
  id: string;
  status: string;
  labels: readonly string[];
  description?: string | null;
  /** `list_comments` returns newest first; `createdAt` restores creation order. `id` lets the control plane update its own record comments in place. */
  comments?: readonly { id?: string; body: string; createdAt?: string }[];
  /** Present when fetched with `includeRelations: true`. */
  relations?: { blockedBy?: readonly { id: string }[] } | null;
};

/** `gh pr list --json number,headRefName,headRefOid,state,mergeCommit,mergedAt,mergeable,commits,statusCheckRollup,body`. */
export type GitHubPullRequest = {
  number: number;
  headRefName?: string;
  headRefOid: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN` while GitHub computes it. */
  mergeable?: string;
  commits?: readonly { oid?: string; committedDate?: string }[];
  statusCheckRollup?: readonly { name?: string; conclusion?: string | null; state?: string | null; status?: string | null }[];
  body?: string;
  createdAt?: string;
};

/**
 * A PR belongs to an issue by the builder contract: branch `met-<n>-<slug>` or a
 * `closes MET-<n>` / `contributes MET-<n>` line in its body. A PR that merely
 * mentions the issue in prose (another issue's fix explaining it) does not.
 */
export function prOwnsIssue(pr: Pick<GitHubPullRequest, 'headRefName' | 'body'>, identifier: string): boolean {
  const id = identifier.toLowerCase();
  const branch = (pr.headRefName ?? '').toLowerCase();
  if (branch === id || branch.startsWith(`${id}-`)) return true;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(closes|contributes)\\s+${escaped}\\b`, 'im').test(pr.body ?? '');
}

/**
 * P4.3: the time of the latest red deploy receipt (`health=fail`, rolled back or not), or undefined
 * when there is none. Throws when such a receipt has no creation time to order PRs by.
 */
export function failedReceiptAt(comments: readonly { body: string; createdAt?: string }[]): string | undefined {
  let latest: number | undefined;
  for (const comment of comments) {
    if (parseDeployReceipt(comment.body)?.health !== 'fail') continue;
    const at = Date.parse(comment.createdAt ?? '');
    if (Number.isNaN(at)) throw new Error(`failed deploy receipt ${comment.createdAt ?? 'without a creation time'} cannot order merged PRs`);
    latest = Math.max(latest ?? at, at);
  }
  return latest === undefined ? undefined : new Date(latest).toISOString();
}

/**
 * P4.3: a merged PR whose merge is not strictly after `failedAt` (failedReceiptAt) shipped the release
 * that failed: it no longer delivers the issue, so it neither selects the issue's PR (no return to
 * Deploying) nor meets a builder or reviewer stop. Open PRs and later merges are unaffected.
 */
export const supersededMerge = (pr: Pick<GitHubPullRequest, 'mergedAt'>, failedAt: string | undefined): boolean =>
  failedAt !== undefined && pr.mergedAt != null && !(Date.parse(pr.mergedAt) > Date.parse(failedAt));

/** A PR that can deliver the issue: it owns it (prOwnsIssue) and its merge, if any, is not superseded. */
export const prEligible = (pr: Pick<GitHubPullRequest, 'headRefName' | 'body' | 'mergedAt'>, identifier: string, failedAt: string | undefined): boolean =>
  prOwnsIssue(pr, identifier) && !supersededMerge(pr, failedAt);

/**
 * P4.4: the durable binding of a build round to its PR. `round` is the issue's build round (its
 * highest builder `odd-spawn` round, 0 before any) and `rollback` its rollback epoch (red deploy
 * receipts so far); together they are the epoch (buildEpoch) the binding holds for.
 */
export type PrBinding = { pr: number; branch: string; round: number; rollback: number };

export const prBindingLine = (binding: PrBinding) => `odd-pr pr=${binding.pr} branch=${binding.branch} round=${binding.round} rollback=${binding.rollback}`;

export function parsePrBinding(text: string): PrBinding | undefined {
  const match = /^odd-pr pr=([1-9]\d*) branch=(\S+) round=(\d+) rollback=(\d+)$/m.exec(text);
  return match ? { pr: Number(match[1]), branch: match[2], round: Number(match[3]), rollback: Number(match[4]) } : undefined;
}

export function buildEpoch(comments: readonly { body: string }[]): { round: number; rollback: number } {
  const round = Math.max(0, ...spawnRecords(comments).filter(record => record.role === 'builder').map(record => record.round));
  return { round, rollback: comments.filter(comment => parseDeployReceipt(comment.body)?.health === 'fail').length };
}

/** The latest `odd-pr` binding (by creation time) for the current epoch; one from an older round or rollback epoch binds nothing. */
export function currentBinding(comments: readonly { body: string; createdAt?: string }[]): PrBinding | undefined {
  const { round, rollback } = buildEpoch(comments);
  return [...comments].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    .map(comment => parsePrBinding(comment.body))
    .filter(binding => binding?.round === round && binding.rollback === rollback)
    .at(-1);
}

/**
 * P4.4: the one PR an unbound epoch may bind, from one listed state: eligible (prEligible, so a
 * merge after a red receipt counts by its merge time), not `excluded` (a bound PR that was closed)
 * and, if still unmerged after a red receipt, opened strictly after it, so a stale pre-rollback PR
 * is never bound. More than one candidate throws: the binding is never chosen by list order.
 */
export function bindingCandidate<T extends Pick<GitHubPullRequest, 'number' | 'headRefName' | 'body' | 'mergedAt' | 'createdAt'>>(rows: readonly T[], identifier: string, failedAt: string | undefined, excluded?: number): T | undefined {
  const candidates = rows.filter(pr => pr.number !== excluded && prEligible(pr, identifier, failedAt) && (failedAt === undefined || pr.mergedAt != null || Date.parse(pr.createdAt ?? '') > Date.parse(failedAt)));
  if (candidates.length > 1) throw new Error(`${identifier} has ${candidates.length} candidate PRs (${candidates.map(pr => `#${pr.number}`).sort().join(', ')}) and no odd-pr binding for its current epoch; none is chosen by list order`);
  return candidates[0];
}

/** P4.4: the plane's own record that it drafted `pr` for escalation `escalation`, written only after the draft succeeded. */
export const draftedLine = (pr: number, escalation: string) => `odd-drafted pr=${pr} escalation=${escalation}`;
/** Written before the plane marks that PR ready again, so one draft is released at most once. */
export const undraftedLine = (pr: number, escalation: string) => `odd-undrafted pr=${pr} escalation=${escalation}`;

/**
 * P4.4: the escalation whose plane draft of `pr` an `odd-resume` for that escalation released and
 * no `odd-undrafted` has consumed, or undefined: a draft the plane did not make (a human's) or
 * already released stays a draft.
 */
export function releasedDraft(comments: readonly { body: string }[], pr: number): string | undefined {
  const lines = (pattern: RegExp) => new Set(comments.flatMap(comment => [...comment.body.matchAll(pattern)].flatMap(match => (Number(match[1]) === pr ? [match[2]] : []))));
  const drafted = lines(/^odd-drafted pr=(\d+) escalation=(\S+)$/gm);
  const undrafted = lines(/^odd-undrafted pr=(\d+) escalation=(\S+)$/gm);
  const resumed = new Set(comments.flatMap(comment => { const resume = parseResume(comment.body); return resume && resume !== 'malformed' ? [resume.escalation] : []; }));
  return [...drafted].find(escalation => resumed.has(escalation) && !undrafted.has(escalation));
}

/**
 * `updatedAt` is the thread's last activity as reported by thread search; absent for a thread the index has not returned yet.
 * `activeAt` is the agent state's last update (`get_thread_status` `agentState.updatedAt`): a running thread's activity (P3.10), absent when not reported.
 */
export type LiveThread = { id: string; labels: readonly string[]; state: string; updatedAt?: string; activeAt?: string };

const statuses: readonly Status[] = ['Backlog', 'Triage', 'Todo', 'In Progress', 'In Review', 'Deploying', 'Done', 'Canceled', 'Duplicate'];

export function ciState(checks: GitHubPullRequest['statusCheckRollup'] = []): 'pending' | 'success' | 'failure' {
  const words = checks.map(check => (check.conclusion ?? check.state ?? '').toUpperCase());
  if (words.some(word => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(word))) return 'failure';
  if (checks.length === 0 || words.some(word => !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(word))) return 'pending';
  return 'success';
}

/** A reviewer thread's verdict label: state and the 12-character head prefix it judged. */
export const verdictPattern = /^odd-verdict-(ready|changes)-([a-f0-9]{12})$/;

/**
 * The newest reviewer verdict label, matched to the PR head by its 12-character SHA prefix. A
 * verdict from a thread of the Builder's own lab (`odd-engine-<lab>`) never counts (§6); a builder
 * thread without that label, or no live builder, falls back to the configured builder lab, as
 * `selectReviewer` does.
 */
export function verdictFor(threads: readonly LiveThread[], headSha: string): Verdict | undefined {
  const builderLab = labOf(threads.find(thread => parseThreadLabels(thread.labels).role === 'builder')?.labels ?? []) ?? builderEngine.lab;
  for (const thread of threads) {
    if (labOf(thread.labels) === builderLab) continue;
    for (const label of thread.labels) {
      const match = verdictPattern.exec(label);
      if (match && headSha.startsWith(match[2])) return { state: match[1] as Verdict['state'], sha: headSha };
    }
  }
  return undefined;
}

/**
 * Review rounds spent on the issue: distinct heads that received a `changes` verdict, from live
 * reviewer labels and from the delivered `changes-<head12>` steer keys, so a stale-head reviewer
 * archived as finished (finishedThreads) still counts.
 */
export function changesRounds(threads: readonly LiveThread[], steerKeys: readonly string[] = []): number {
  const heads = new Set(steerKeys.flatMap(key => /^changes-([a-f0-9]{12})$/.exec(key)?.slice(1) ?? []));
  for (const thread of threads) {
    for (const label of thread.labels) {
      const match = verdictPattern.exec(label);
      if (match?.[1] === 'changes') heads.add(match[2]);
    }
  }
  return heads.size;
}

export function riskFrom(description: string): RiskClass | undefined {
  const match = /^\s*risk:\s*(ordinary|security|authority|irreversible)\b/im.exec(description);
  return match ? match[1].toLowerCase() as RiskClass : undefined;
}

type ThreadState = NonNullable<IssueSnapshot['owner']>['state'];

/**
 * P3.10: the Amp agent states `get_thread_status` and `find_thread` report (MET-394: their tool
 * descriptions name `working`, `streaming`, `tool_use`, `running_tools` and `compacting` as working
 * now, and `awaiting_approval`). Every active state is running; `external-agent` is a retired
 * terminal thread, finished like an idle one. Any other state is unknown: undefined here, never
 * running or idle, and it fails the derivation of its own issue only.
 */
const threadStates: Readonly<Record<string, ThreadState>> = Object.freeze({
  idle: 'idle', 'external-agent': 'idle', error: 'error', 'awaiting-approval': 'awaiting-approval', awaiting_approval: 'awaiting-approval',
  running: 'running', working: 'running', streaming: 'running', 'tool-running': 'running', tool_use: 'running', running_tools: 'running', compacting: 'running',
});
export const threadState = (state: string): ThreadState | undefined => Object.hasOwn(threadStates, state) ? threadStates[state] : undefined;

/** threadState for a thread already read; an unknown state throws instead of guessing. */
export function ownerState(state: string): ThreadState {
  const known = threadState(state);
  if (!known) throw new Error(`unknown thread state ${JSON.stringify(state.slice(0, 40))}`);
  return known;
}

/**
 * Combine the three sources. `threads` are the live Amp threads labelled for this issue. The
 * owner is a running or approval-blocked role thread if any (the issue waits for it), else the builder thread
 * (steer targets it even while a reviewer thread is idle beside it), else the first role thread.
 * Open blockers come from Linear relations; the caller resolves which are still open.
 */
export function toSnapshot(input: { issue: LinearIssue; pr?: GitHubPullRequest; threads?: readonly LiveThread[]; openBlockers?: readonly string[] }): IssueSnapshot {
  const { issue, threads = [], openBlockers = [] } = input;
  // P4.3: a PR merged at or before the latest failed receipt is history, not the issue's PR.
  const pr = input.pr?.mergedAt && supersededMerge(input.pr, failedReceiptAt(issue.comments ?? [])) ? undefined : input.pr;
  const description = issue.description ?? '';
  // Any other name is Unknown, never Backlog: Backlog is parked and silent, an unknown status pages (lifecycle.ts).
  const status = statuses.find(name => name === issue.status) ?? 'Unknown';
  const roleThreads = threads.filter(thread => parseThreadLabels(thread.labels).role);
  // Every role thread's state is judged, not only up to the first match: an unknown one fails the snapshot.
  for (const thread of roleThreads) ownerState(thread.state);
  const owned = roleThreads.find(thread => ['running', 'awaiting-approval'].includes(ownerState(thread.state)))
    ?? roleThreads.find(thread => parseThreadLabels(thread.labels).role === 'builder')
    ?? roleThreads[0];
  const owner = owned ? (() => {
    const { role, round } = parseThreadLabels(owned.labels);
    const state = ownerState(owned.state);
    const since = state === 'running' ? owned.activeAt : owned.updatedAt;
    return role ? { role, threadID: owned.id, round, state, ...(since ? { idleSince: since } : {}) } : undefined;
  })() : undefined;
  // Only receipts after the latest merge count: an issue re-opened after a rollback and merged again starts clean.
  let receipt: DeployReceipt | undefined;
  let verify: Verify | undefined;
  let cancelledRounds: Partial<Record<Role, number>> = {};
  const steers: Record<string, string> = {};
  // Correction epochs (MET-348). A new epoch starts at an `odd-resume` for the open latch, written
  // only after Devon removed `escalated` from it, or at a legacy `odd-escalated` comment from before
  // latches (prior semantics; honoured only until the issue's first latch, budget or resume record).
  // It restarts the cancelled rounds (not the verifier's, which belong to a release) and the budget.
  let correction: Correction = { epoch: 1, corrected: false };
  let escalation: Escalation | undefined;
  let recorded = false;
  const resumed = new Set<string>();
  const nextEpoch = () => {
    correction = { epoch: correction.epoch + 1, corrected: false };
    cancelledRounds = cancelledRounds.verifier ? { verifier: cancelledRounds.verifier } : {};
  };
  const oldestFirst = [...issue.comments ?? []].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  for (const comment of oldestFirst) {
    if (/^odd-merge pr=/m.test(comment.body)) receipt = undefined;
    const latch = parseEscalation(comment.body);
    if (latch === 'legacy' && !recorded) nextEpoch();
    else if (latch === 'legacy' || latch === 'malformed') correction.invalid ??= `${latch} odd-escalated comment ${comment.id ?? 'without id'}`;
    else if (latch) {
      recorded = true;
      escalation = { ...latch, ...(comment.id ? { id: comment.id } : {}) };
    }
    const resume = parseResume(comment.body);
    if (resume) recorded = true;
    if (resume === 'malformed') correction.invalid ??= 'malformed odd-resume comment';
    else if (resume && !resumed.has(resume.escalation)) {
      // A resume releases only the open latch whose label was set; anything else grants nothing.
      if (!escalation?.id || resume.escalation !== escalation.id || !escalation.done.includes('label') || resume.epoch !== correction.epoch + 1) correction.invalid ??= `odd-resume for ${resume.escalation} does not release the open escalation`;
      else {
        resumed.add(resume.escalation);
        escalation = undefined;
        nextEpoch();
      }
    }
    const budget = parseBudget(comment.body);
    if (budget) recorded = true;
    if (budget === 'malformed') correction.invalid ??= 'malformed odd-budget comment';
    else if (budget) {
      const skew = Math.abs(Date.parse(comment.createdAt ?? '') - Date.parse(budget.start));
      if (!(skew <= budgetSkewMs)) correction.invalid ??= `odd-budget start ${budget.start} is not its comment time ${comment.createdAt ?? '(none)'}`;
      else if (budget.epoch !== correction.epoch) correction.invalid ??= `odd-budget for epoch ${budget.epoch} recorded in epoch ${correction.epoch}`;
      else if (correction.budget && correction.budget.contract !== budget.contract) correction.invalid ??= `conflicting odd-budget contracts in epoch ${budget.epoch}`;
      // A duplicate (a write whose response was lost, then retried) never extends the window: the earliest start holds.
      else if (!correction.budget || budget.start < correction.budget.start) correction.budget = budget;
    }
    // Verifier rounds belong to one release: a receipt for a new SHA is a fresh verification budget.
    const next = parseDeployReceipt(comment.body);
    if (next && next.sha !== receipt?.sha) delete cancelledRounds.verifier;
    // MET-386: a receipt that replaces a different one, even at the same round SHA (a receipt set after a
    // partial uniform receipt), needs its own verification; a repost of the same line keeps it.
    if (next && receipt && deployReceiptLine(next) !== deployReceiptLine(receipt)) verify = undefined;
    receipt = next ?? receipt;
    verify = parseVerify(comment.body) ?? verify;
    const cancelled = parseCancelled(comment.body);
    if (cancelled) cancelledRounds[cancelled.role] = Math.max(cancelledRounds[cancelled.role] ?? 0, cancelled.round);
    const steered = parseSteer(comment.body);
    if (steered) steers[steered.key] ??= comment.createdAt ?? '';
    if (steered?.key.startsWith('changes-')) correction.corrected = true;
  }
  const headAt = pr?.commits?.find(commit => commit.oid === pr.headRefOid)?.committedDate;
  const verified = receipt ? verifiedFor(threads, receipt.sha) : undefined;
  return {
    identifier: issue.id.toUpperCase(),
    status,
    ...(status === 'Unknown' ? { unknownStatus: issue.status } : {}),
    labels: issue.labels,
    description,
    openBlockers,
    risk: riskFrom(description),
    owner,
    pr: pr ? {
      number: pr.number,
      headSha: pr.headRefOid,
      ci: ciState(pr.statusCheckRollup),
      verdict: verdictFor(threads, pr.headRefOid),
      merged: pr.state === 'MERGED',
      mergeSha: pr.mergeCommit?.oid ?? undefined,
      changesRounds: changesRounds(threads, Object.keys(steers)),
      ...(headAt ? { headAt } : {}),
      ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
      ...(pr.mergeable === 'CONFLICTING' ? { conflicting: true } : {}),
    } : undefined,
    deployReceipt: receipt,
    verify,
    ...(verified ? { verified } : {}),
    openRounds: openRounds(roleThreads, receipt?.sha),
    cancelledRounds,
    steers,
    spawns: spawnRecords(issue.comments ?? []),
    ...(escalation ? { escalation } : {}),
    correction,
  };
}

/** One record per role, round and key: bound when any of its `odd-spawn` lines names a thread, else pending. */
export function spawnRecords(comments: readonly { body: string }[]): SpawnRecord[] {
  const records = new Map<string, SpawnRecord>();
  for (const comment of comments) {
    const record = parseSpawn(comment.body);
    if (!record) continue;
    const id = `${record.role} ${record.round} ${record.key}`;
    if (!records.get(id)?.thread) records.set(id, record);
  }
  return [...records.values()];
}

/**
 * A live thread that a pending record's create may have produced: the record's role and round
 * labels, no other record's thread, and still owed its artifact for the record's key (a reviewer
 * without a verdict, a verifier labelled with the record's receipt).
 */
export function reconciles(record: SpawnRecord, thread: LiveThread, bound: ReadonlySet<string>): boolean {
  const { role, round } = parseThreadLabels(thread.labels);
  if (bound.has(thread.id) || role !== record.role || round !== record.round) return false;
  if (role === 'reviewer') return !thread.labels.some(label => verdictPattern.test(label));
  if (role === 'verifier') return thread.labels.includes(receiptLabel(record.key.replace(/^verifier-/, '')));
  return true;
}

/** A spawn admitted but not yet returned by thread search: `thread` is set once the create returned it. */
export type Reservation = { role: Role; issue?: string; thread?: string };

/**
 * Load for admission (P4.1): live load plus every reservation whose thread search has not
 * returned yet, counted as a running thread of its role's executor and, for a builder, as its
 * issue's build slot. `building` is the issues holding one.
 */
export function admittedLoad(threads: readonly LiveThread[], reservations: readonly Reservation[]): { load: Load; building: Set<string> } {
  const load = loadFrom(threads);
  const indexed = new Set(threads.map(thread => thread.id));
  const building = new Set(threads.flatMap(thread => { const { role, issue } = parseThreadLabels(thread.labels); return role === 'builder' && issue ? [issue] : []; }));
  for (const reservation of reservations) {
    if (reservation.thread && indexed.has(reservation.thread)) continue;
    const executor = contracts[reservation.role].executor;
    if (executor === 'orb') load.orbs += 1;
    else if (executor === 'runner') load.runnerSlots += 1;
    if (reservation.role === 'builder' && reservation.issue) building.add(reservation.issue);
  }
  load.buildIssues = building.size;
  return { load, building };
}

/** The label the control plane gives a verifier thread: the receipt SHA (12-character prefix) it verifies. */
export const receiptLabel = (sha: string) => `odd-receipt-${sha.slice(0, 12)}`;

/** The labels `odd_verify` puts on the Verifier's own thread: the result for the receipt (12-character prefix) and, on fail, the Bug it filed. */
export const verifiedLabels = (verify: Verify) => [`odd-verify-${verify.result}-${verify.sha.slice(0, 12)}`, ...(verify.bug ? [`odd-verify-bug-${verify.bug.toLowerCase()}`] : [])];
const verifiedPattern = /^odd-verify-(pass|fail)-([a-f0-9]{12})$/;
const verifiedBugPattern = /^odd-verify-bug-(met-[1-9]\d*)$/;

/**
 * The Verifier's `odd_verify` output for the receipt `receiptSha`: a verifier thread the control
 * plane labelled with that receipt carrying exactly one result for it, plus exactly one Bug on
 * fail and none on pass. Anything else is no output, so the plane records nothing.
 */
export function verifiedFor(threads: readonly LiveThread[], receiptSha: string): Verify | undefined {
  for (const thread of threads) {
    if (parseThreadLabels(thread.labels).role !== 'verifier' || !thread.labels.includes(receiptLabel(receiptSha))) continue;
    const results = thread.labels.flatMap(label => { const match = verifiedPattern.exec(label); return match && receiptSha.startsWith(match[2]) ? [match[1] as Verify['result']] : []; });
    const bugs = thread.labels.flatMap(label => { const match = verifiedBugPattern.exec(label); return match ? [match[1].toUpperCase()] : []; });
    if (results.length !== 1 || bugs.length !== (results[0] === 'fail' ? 1 : 0)) continue;
    return { sha: receiptSha, result: results[0], ...(bugs.length ? { bug: bugs[0] } : {}) };
  }
  return undefined;
}

/** The label the control plane gives a red release's log reader (Deployer): the release SHA (12-character prefix) it reads. */
export const readerLabel = (sha: string) => `odd-deploy-${sha.slice(0, 12)}`;
/** The label a log reader adds to its own thread once its diagnosis for that release is posted. */
export const diagnosedLabel = (sha: string) => `odd-diagnosed-${sha.slice(0, 12)}`;

/**
 * A role thread that has finished its round: a reviewer carrying a verdict label, a verifier
 * spawned for another receipt than the current one (`receiptSha`), or a log reader carrying the
 * diagnosed label for the release it was spawned for. Delivered threads hold no round of the
 * budget and are never stale.
 */
export function delivered(thread: LiveThread, receiptSha?: string): boolean {
  const { role } = parseThreadLabels(thread.labels);
  if (role === 'reviewer') return thread.labels.some(label => verdictPattern.test(label));
  if (role === 'verifier') return receiptSha === undefined || !thread.labels.includes(receiptLabel(receiptSha));
  if (role === 'deployer') return thread.labels.some(label => label.startsWith('odd-deploy-') && thread.labels.includes(label.replace('odd-deploy-', 'odd-diagnosed-')));
  return false;
}

/** Highest round per role among live threads still owed their artifact (not `delivered`). */
export function openRounds(threads: readonly LiveThread[], receiptSha?: string): Partial<Record<Role, number>> {
  const rounds: Partial<Record<Role, number>> = {};
  for (const thread of threads) {
    const { role, round } = parseThreadLabels(thread.labels);
    if (!role || delivered(thread, receiptSha)) continue;
    rounds[role] = Math.max(rounds[role] ?? 0, round);
  }
  return rounds;
}

/**
 * Live load (§6): orbs and runner slots count running role threads by executor; buildIssues
 * counts issues with a live builder thread in any state, since a builder waiting for review
 * still holds its build slot. A thread in an unknown state keeps its executor slot: caps never
 * under-count on a guess, and its own issue fails derivation (toSnapshot) rather than every issue.
 */
export function loadFrom(threads: readonly LiveThread[]): Load {
  const load: Load = { orbs: 0, runnerSlots: 0, buildIssues: 0 };
  const building = new Set<string>();
  for (const thread of threads) {
    const { role, issue } = parseThreadLabels(thread.labels);
    if (!role) continue;
    if (role === 'builder' && issue) building.add(issue);
    if ((threadState(thread.state) ?? 'running') !== 'running') continue;
    const executor = contracts[role].executor;
    if (executor === 'orb') load.orbs += 1;
    else if (executor === 'runner') load.runnerSlots += 1;
  }
  load.buildIssues = building.size;
  return load;
}

/** The statuses in which each role's thread still matters; past them its idle threads are archived. */
const roleStages: Partial<Record<keyof typeof contracts, readonly Status[]>> = {
  intake: ['Triage'],
  spec: ['Triage'],
  // The builder is kept through review, so a `changes` verdict steers the same thread and its build slot stays held.
  builder: ['Todo', 'In Progress', 'In Review'],
  reviewer: ['In Progress', 'In Review'],
  verifier: ['Deploying'],
};

/** What finished work is judged against: the current receipt SHA, the receipt SHA of the recorded `odd-verify` line, and the PR head. */
export type Current = { receiptSha?: string; verifiedSha?: string; headSha?: string };

/**
 * Idle role threads whose work is finished (§7 handoff): archived on the next evaluation. A thread is
 * finished when the issue has left its role's stage, or, inside the stage (MET-404), when it is a
 * verifier of a superseded receipt or one whose `odd-verify-<result>` output is recorded for the
 * current receipt (an unrecorded one is still the only copy of that output, verifiedFor), or a
 * reviewer whose verdict is for a head that is no longer the PR's. A log reader has no stage (a
 * failed rollback leaves the issue in Deploying, a rolled-back one moves on while the reader still
 * runs): it is finished once it is idle and `delivered`. The builder is kept through review.
 */
export function finishedThreads(status: Status, threads: readonly LiveThread[], current: Current = {}): LiveThread[] {
  // An unknown status says nothing about which stage is over: nothing is archived until it is known.
  if (status === 'Unknown') return [];
  const { receiptSha, verifiedSha, headSha } = current;
  return threads.filter(thread => {
    const { role } = parseThreadLabels(thread.labels);
    if (ownerState(thread.state) !== 'idle') return false;
    if (role === 'deployer') return delivered(thread);
    if (role === 'verifier' && receiptSha) {
      if (!thread.labels.includes(receiptLabel(receiptSha))) return true;
      if (verifiedSha === receiptSha && thread.labels.some(label => verifiedPattern.test(label))) return true;
    }
    if (role === 'reviewer' && headSha && thread.labels.some(label => { const match = verdictPattern.exec(label); return match !== null && !headSha.startsWith(match[2]); })) return true;
    const stages = role ? roleStages[role] : undefined;
    return stages !== undefined && !stages.includes(status);
  });
}

/** Thread-search queries that enumerate every live role thread (labels are exact-match). */
export const roleLabelQueries = roles.map(role => `label:odd-role-${role} archived:false`);

export const overCapacity = (load: Load) => load.orbs >= capacity.orbs && load.runnerSlots >= capacity.runnerSlots;
