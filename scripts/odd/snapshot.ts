// Outcome driven development: derive an IssueSnapshot from what Linear, GitHub and Amp
// report (docs/odd/README.md §9). Pure functions; the control-plane plugin does the IO.

import { capacity, contracts, parseDeployReceipt, parseThreadLabels, roles, type DeployReceipt, type IssueSnapshot, type Load, type RiskClass, type Status, type Verdict } from './lifecycle.ts';

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
  comments?: readonly { body: string }[];
  /** Present when fetched with `includeRelations: true`. */
  relations?: { blockedBy?: readonly { id: string }[] } | null;
};

/** `gh pr list --json number,headRefName,headRefOid,state,mergeCommit,statusCheckRollup,body`. */
export type GitHubPullRequest = {
  number: number;
  headRefName?: string;
  headRefOid: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergeCommit?: { oid: string } | null;
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

export type LiveThread = { id: string; labels: readonly string[]; state: string };

const statuses: readonly Status[] = ['Backlog', 'Triage', 'Todo', 'In Progress', 'Deploying', 'Done', 'Canceled', 'Duplicate'];

export function ciState(checks: GitHubPullRequest['statusCheckRollup'] = []): 'pending' | 'success' | 'failure' {
  const words = checks.map(check => (check.conclusion ?? check.state ?? '').toUpperCase());
  if (words.some(word => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(word))) return 'failure';
  if (checks.length === 0 || words.some(word => !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(word))) return 'pending';
  return 'success';
}

const verdictPattern = /^odd-verdict-(ready|changes)-([a-f0-9]{12})$/;

/** The newest reviewer verdict label, matched to the PR head by its 12-character SHA prefix. */
export function verdictFor(threads: readonly LiveThread[], headSha: string): Verdict | undefined {
  for (const thread of threads) {
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
    return role ? { role, threadID: owned.id, round, state: ownerState(owned.state) } : undefined;
  })() : undefined;
  // Only receipts after the latest merge count: an issue re-opened after a rollback and merged again starts clean.
  let receipt: DeployReceipt | undefined;
  for (const comment of issue.comments ?? []) {
    if (/^odd-merge pr=/m.test(comment.body)) receipt = undefined;
    receipt = parseDeployReceipt(comment.body) ?? receipt;
  }
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
    } : undefined,
    deployReceipt: receipt,
  };
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
  intake: ['Backlog'],
  spec: ['Backlog', 'Triage'],
  builder: ['Todo', 'In Progress'],
  reviewer: ['In Progress'],
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
