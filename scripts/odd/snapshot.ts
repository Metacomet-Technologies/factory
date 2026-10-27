// Outcome driven development: derive an IssueSnapshot from what Linear, GitHub and Amp
// report (docs/odd/README.md §9). Pure functions; the control-plane plugin does the IO.

import { builderEngine, labOf } from './engines.ts';
import { budgetSkewMs, capacity, contracts, parseBudget, parseCancelled, parseDeployReceipt, parseEscalation, parseResume, parseSpawn, parseSteer, parseThreadLabels, parseVerify, roles, type Correction, type DeployReceipt, type Escalation, type IssueSnapshot, type Load, type RiskClass, type Role, type SpawnRecord, type Status, type Verdict, type Verify } from './lifecycle.ts';

export type WebhookSource = 'linear' | 'github' | 'slack';

const identifierPattern = /\bMET-\d+\b/i;

/** The issue a webhook delivery is about, or undefined when the event is not issue-scoped. */
export function issueFromEvent(source: WebhookSource, body: string): string | undefined {
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return undefined; }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const event = payload as Record<string, unknown>;
  if (source === 'linear') {
    const data = event.data as Record<string, unknown> | undefined;
    const issue = (data?.issue as Record<string, unknown> | undefined) ?? data;
    const identifier = issue?.identifier;
    return typeof identifier === 'string' && identifierPattern.test(identifier) ? identifier.toUpperCase() : undefined;
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

/** `updatedAt` is the thread's last activity as reported by thread search; absent for a thread the index has not returned yet. */
export type LiveThread = { id: string; labels: readonly string[]; state: string; updatedAt?: string };

const statuses: readonly Status[] = ['Backlog', 'Triage', 'Todo', 'In Progress', 'Deploying', 'Done', 'Canceled', 'Duplicate'];

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

/** Review rounds spent on the issue: distinct heads that received a `changes` verdict. */
export function changesRounds(threads: readonly LiveThread[]): number {
  const heads = new Set<string>();
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

const ownerState = (state: string): NonNullable<IssueSnapshot['owner']>['state'] => {
  if (state === 'idle' || state === 'error' || state === 'awaiting-approval') return state;
  return 'running';
};

/**
 * Combine the three sources. `threads` are the live Amp threads labelled for this issue. The
 * owner is a running role thread if any (the issue waits for it), else the builder thread
 * (steer targets it even while a reviewer thread is idle beside it), else the first role thread.
 * Open blockers come from Linear relations; the caller resolves which are still open.
 */
export function toSnapshot(input: { issue: LinearIssue; pr?: GitHubPullRequest; threads?: readonly LiveThread[]; openBlockers?: readonly string[] }): IssueSnapshot {
  const { issue, pr, threads = [], openBlockers = [] } = input;
  const description = issue.description ?? '';
  const status = statuses.find(name => name === issue.status) ?? 'Backlog';
  const roleThreads = threads.filter(thread => parseThreadLabels(thread.labels).role);
  const owned = roleThreads.find(thread => ownerState(thread.state) === 'running')
    ?? roleThreads.find(thread => parseThreadLabels(thread.labels).role === 'builder')
    ?? roleThreads[0];
  const owner = owned ? (() => {
    const { role, round } = parseThreadLabels(owned.labels);
    return role ? { role, threadID: owned.id, round, state: ownerState(owned.state), ...(owned.updatedAt ? { idleSince: owned.updatedAt } : {}) } : undefined;
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
    receipt = next ?? receipt;
    verify = parseVerify(comment.body) ?? verify;
    const cancelled = parseCancelled(comment.body);
    if (cancelled) cancelledRounds[cancelled.role] = Math.max(cancelledRounds[cancelled.role] ?? 0, cancelled.round);
    const steered = parseSteer(comment.body);
    if (steered) steers[steered.key] ??= comment.createdAt ?? '';
    if (steered?.key.startsWith('changes-')) correction.corrected = true;
  }
  const headAt = pr?.commits?.find(commit => commit.oid === pr.headRefOid)?.committedDate;
  return {
    identifier: issue.id.toUpperCase(),
    status,
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
      changesRounds: changesRounds(threads),
      ...(headAt ? { headAt } : {}),
      ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
      ...(pr.mergeable === 'CONFLICTING' ? { conflicting: true } : {}),
    } : undefined,
    deployReceipt: receipt,
    verify,
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

/**
 * A role thread that has finished its round: a reviewer carrying a verdict label, or a verifier
 * spawned for another receipt than the current one (`receiptSha`). Delivered threads hold no
 * round of the budget and are never stale.
 */
export function delivered(thread: LiveThread, receiptSha?: string): boolean {
  const { role } = parseThreadLabels(thread.labels);
  if (role === 'reviewer') return thread.labels.some(label => verdictPattern.test(label));
  if (role === 'verifier') return receiptSha === undefined || !thread.labels.includes(receiptLabel(receiptSha));
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
 * still holds its build slot.
 */
export function loadFrom(threads: readonly LiveThread[]): Load {
  const load: Load = { orbs: 0, runnerSlots: 0, buildIssues: 0 };
  const building = new Set<string>();
  for (const thread of threads) {
    const { role, issue } = parseThreadLabels(thread.labels);
    if (!role) continue;
    if (role === 'builder' && issue) building.add(issue);
    if (ownerState(thread.state) !== 'running') continue;
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
  builder: ['Todo', 'In Progress'],
  reviewer: ['In Progress'],
  verifier: ['Deploying'],
};

/** Idle role threads whose stage the issue has left: finished work to archive (§7 handoff). */
export function finishedThreads(status: Status, threads: readonly LiveThread[]): LiveThread[] {
  return threads.filter(thread => {
    const { role } = parseThreadLabels(thread.labels);
    const stages = role ? roleStages[role] : undefined;
    return stages !== undefined && !stages.includes(status) && ownerState(thread.state) === 'idle';
  });
}

/** Thread-search queries that enumerate every live role thread (labels are exact-match). */
export const roleLabelQueries = roles.map(role => `label:odd-role-${role} archived:false`);

export const overCapacity = (load: Load) => load.orbs >= capacity.orbs && load.runnerSlots >= capacity.runnerSlots;
