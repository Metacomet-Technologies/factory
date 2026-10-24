// Outcome driven development: the deterministic lifecycle (docs/odd/README.md §4-§8).
// Pure functions only. The control-plane plugin (.amp/plugins/factory-odd.ts) and
// the runner backstop both derive state from Linear and GitHub and call nextAction.

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

export type Status = 'Backlog' | 'Triage' | 'Todo' | 'In Progress' | 'Deploying' | 'Done' | 'Canceled' | 'Duplicate';
export type RiskClass = 'ordinary' | 'security' | 'authority' | 'irreversible';
export type Verdict = { state: 'ready' | 'changes'; sha: string };

export type IssueSnapshot = {
  identifier: string;
  status: Status;
  labels: readonly string[];
  description: string;
  openBlockers: readonly string[];
  risk?: RiskClass;
  /**
   * Live thread owning the issue, derived from Amp thread labels odd-issue-<id>, odd-role-<role>, odd-round-<n>.
   * `idleSince` is the thread's last activity (thread search `updatedAt`); the Watchdog cancels an idle owner past `staleMs`.
   */
  owner?: { role: Role; threadID: string; round: number; state: 'idle' | 'running' | 'awaiting-approval' | 'error'; idleSince?: string };
  /** `changesRounds` counts the distinct `changes` verdicts on this issue: the builder thread persists across rounds, so rounds live on the reviewer side. */
  pr?: { number: number; headSha: string; ci: 'pending' | 'success' | 'failure'; verdict?: Verdict; merged: boolean; mergeSha?: string; changesRounds?: number };
  /** Latest `odd-deploy` receipt posted after the latest `odd-merge` receipt (scripts/odd/deploy.ts posts one per release per issue). */
  deployReceipt?: DeployReceipt;
  /** Latest `odd-verify` comment (the Verifier's judgement); it counts only when its SHA is the receipt's. */
  verify?: Verify;
  /** Highest `odd-round-<n>` per role among live threads that have not produced their artifact (snapshot.ts `delivered`). */
  openRounds?: Partial<Record<Role, number>>;
  /** Rounds the Watchdog cancelled per role since the latest `odd-escalated` comment (`odd-watchdog cancelled` comments); verifier rounds since the latest receipt. */
  cancelledRounds?: Partial<Record<Role, number>>;
};

/** `component` is the `+`-joined set the release installed (`none` when it touched no enabled component), or the component that failed. */
export type DeployReceipt = { host: string; component: string; sha: string; health: 'pass' | 'fail'; rollback: 'none' | string };

/** The Verifier's receipt: `bug` is the Bug issue it filed for a failing Done-means item. */
export type Verify = { sha: string; result: 'pass' | 'fail'; bug?: string };

export type Load = { orbs: number; runnerSlots: number; buildIssues: number };

export type Action =
  | { kind: 'spawn'; role: Role; executor: Executor; reason: string; round: number }
  | { kind: 'steer'; role: Role; threadID: string; message: string }
  | { kind: 'merge'; pr: number; sha: string }
  | { kind: 'set-status'; status: Status; reason: string; followUp?: { title: string; body: string }; diagnose?: DeployReceipt }
  | { kind: 'page'; reason: PageReason; detail: string; pr?: number; sha?: string; diagnose?: DeployReceipt }
  /** `stuck` names the idle role whose thread the wait depends on; the Watchdog cancels it once stale. */
  | { kind: 'wait'; reason: string; stuck?: Role };

/** `diagnose` on a red deploy: after acting, the control plane starts one log-reading Deployer on the receipt's host (odd-deployer skill). */
export type PageReason = 'third-failed-qa-round' | 'failed-rollback' | 'irreversible-action' | 'security-finding' | 'budget-ceiling' | 'control-plane-blind';

/** What happens when Devon does not answer a page (docs/odd/README.md §8); every page states it. */
export const pageDefaults: Record<PageReason, string> = Object.freeze({
  'third-failed-qa-round': 'issue stays In Progress and the PR stays a draft until the `escalated` label is removed',
  'failed-rollback': 'component stays on the previous release; deploys of that component pause',
  'irreversible-action': 'not executed',
  'security-finding': 'issue stays In Progress; nothing merges',
  'budget-ceiling': 'issue waits with no owner thread until the `escalated` label is removed',
  'control-plane-blind': 'the runner backstop poller runs the lifecycle at 60 s cadence',
});

/** The one page format (§8): `ODD page: <condition> | issue MET-<n> | <pr or host> | <sha> | default if silent: <action>`. */
export function pageText(issue: string, action: Extract<Action, { kind: 'page' }>): string {
  const where = action.pr !== undefined ? `PR #${action.pr}` : action.diagnose ? `host ${action.diagnose.host}` : '-';
  const sha = action.sha ?? action.diagnose?.sha ?? '-';
  return `ODD page: ${action.reason} | issue ${issue} | ${where} | ${sha} | default if silent: ${pageDefaults[action.reason]}. ${action.detail}`;
}

export const verifyLine = (verify: Verify) => `odd-verify sha=${verify.sha} result=${verify.result} bug=${verify.bug ?? 'none'}`;

export function parseVerify(text: string): Verify | undefined {
  const match = /^odd-verify sha=([a-f0-9]{7,40}) result=(pass|fail) bug=(\S+)$/m.exec(text);
  if (!match) return undefined;
  return { sha: match[1], result: match[2] as Verify['result'], bug: match[3] === 'none' ? undefined : match[3].toUpperCase() };
}

export const cancelledLine = (role: Role, threadID: string, round: number) => `odd-watchdog cancelled role=${role} thread=${threadID} round=${round}`;

export function parseCancelled(text: string): { role: Role; threadID: string; round: number } | undefined {
  const match = /^odd-watchdog cancelled role=(\S+) thread=(\S+) round=(\d+)$/m.exec(text);
  if (!match || !roles.includes(match[1] as Role)) return undefined;
  return { role: match[1] as Role, threadID: match[2], round: Number(match[3]) };
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

export const deployReceiptLine = (receipt: DeployReceipt) =>
  `odd-deploy host=${receipt.host} component=${receipt.component} sha=${receipt.sha} health=${receipt.health} rollback=${receipt.rollback}`;

export function parseDeployReceipt(text: string): DeployReceipt | undefined {
  const match = /^odd-deploy host=(\S+) component=(\S+) sha=([a-f0-9]{7,40}) health=(pass|fail) rollback=(\S+)$/m.exec(text);
  if (!match) return undefined;
  return { host: match[1], component: match[2], sha: match[3], health: match[4] as 'pass' | 'fail', rollback: match[5] };
}

const free = (executor: Executor, load: Load) =>
  executor === 'none' || (executor === 'orb' ? load.orbs < capacity.orbs : load.runnerSlots < capacity.runnerSlots);

/**
 * Spawn a fresh round of `role`, or wait: on capacity, or while an idle thread of the role is
 * live and the rounds are spent (a role that ends without reaching its stop condition must not
 * be respawned forever; the Watchdog cancels it once it is stale, see scripts/odd/watchdog.ts).
 * Cancelled rounds count too; once the budget is spent and no thread of the role is live, the
 * issue pages instead of waiting silently. Both counts restart at the latest `odd-escalated`
 * comment, so a cleared escalation is a fresh budget. Only `openRounds` counts live rounds: an
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
  if (role === 'builder' && live === 0 && load.buildIssues >= capacity.buildIssues) return { kind: 'wait', reason: `build capacity (${load.buildIssues}/${capacity.buildIssues} issues)` };
  return free(executor, load) ? { kind: 'spawn', role, executor, reason, round: previous + 1 } : { kind: 'wait', reason: `${executor} capacity (${role})` };
}

/** Derive the single next action for one issue. Idempotent: the same snapshot always yields the same action. */
export function nextAction(issue: IssueSnapshot, load: Load): Action {
  const { status, owner, pr } = issue;
  if (owner && owner.state !== 'idle' && owner.state !== 'error') return { kind: 'wait', reason: `${owner.role} running` };
  if (status === 'Done' || status === 'Canceled' || status === 'Duplicate') return { kind: 'wait', reason: status };
  if (issue.labels.includes(escalatedLabel)) return { kind: 'wait', reason: 'escalated to Devon' };

  if (status === 'Backlog') return spawn('intake', load, 'no triage yet', issue);
  if (status === 'Triage') {
    if (specComplete(issue.description)) return { kind: 'set-status', status: 'Todo', reason: 'spec complete' };
    if (issue.risk && issue.risk !== 'ordinary') return { kind: 'wait', reason: `risk ${issue.risk} needs a human decision` };
    return spawn('spec', load, 'spec incomplete', issue);
  }
  if (status === 'Todo') {
    // A builder was spawned but the status change did not land: converge instead of spawning a second builder.
    if (owner?.role === 'builder') return { kind: 'set-status', status: 'In Progress', reason: `builder ${owner.threadID} owns it` };
    if (issue.openBlockers.length) return { kind: 'wait', reason: `blocked by ${issue.openBlockers.join(', ')}` };
    if (!specComplete(issue.description)) return { kind: 'set-status', status: 'Triage', reason: 'spec regressed' };
    return spawn('builder', load, 'ready to build', issue);
  }
  if (status === 'In Progress') {
    if (!pr) {
      if (owner?.role === 'builder' && owner.state === 'error') {
        return owner.round >= contracts.builder.rounds
          ? { kind: 'page', reason: 'third-failed-qa-round', detail: `${issue.identifier}: builder failed ${owner.round} rounds without a PR` }
          : spawn('builder', load, `builder round ${owner.round + 1}`, issue);
      }
      return owner?.role === 'builder' ? { kind: 'wait', reason: 'builder has not opened a PR', stuck: 'builder' } : spawn('builder', load, 'no builder thread', issue);
    }
    if (pr.merged) return { kind: 'set-status', status: 'Deploying', reason: `merged ${pr.mergeSha ?? ''}`.trim() };
    if (pr.ci === 'pending') return { kind: 'wait', reason: `ci pending at ${pr.headSha.slice(0, 12)}` };
    if (pr.ci === 'failure') {
      return owner?.role === 'builder'
        ? { kind: 'steer', role: 'builder', threadID: owner.threadID, message: `CI failed at ${pr.headSha}. Fix the failing jobs and push; do not open a new PR.` }
        : spawn('builder', load, 'ci failed and no builder thread', issue);
    }
    const verdict = pr.verdict?.sha === pr.headSha ? pr.verdict : undefined;
    if (!verdict) return spawn('reviewer', load, `no verdict at ${pr.headSha.slice(0, 12)}`, issue);
    if (verdict.state === 'ready') return { kind: 'merge', pr: pr.number, sha: pr.headSha };
    const round = pr.changesRounds ?? 1;
    if (round >= contracts.builder.rounds) return { kind: 'page', reason: 'third-failed-qa-round', detail: `${issue.identifier}: PR #${pr.number} rejected ${round} times`, pr: pr.number, sha: pr.headSha };
    return owner?.role === 'builder'
      ? { kind: 'steer', role: 'builder', threadID: owner.threadID, message: `QA requested changes at ${pr.headSha}; see the odd-verdict comment on PR #${pr.number}. Address every finding, rerun the Evidence commands, push to the same branch.` }
      : spawn('builder', load, `qa changes, round ${round + 1}`, issue);
  }
  // Deploying: the host Deployer (scripts/odd/deploy.ts) posts the receipt; the control plane never deploys.
  if (status === 'Deploying') {
    const receipt = issue.deployReceipt;
    if (!receipt) return { kind: 'wait', reason: 'release not published' };
    const line = deployReceiptLine(receipt);
    if (receipt.health === 'fail' && receipt.rollback === 'none') return { kind: 'page', reason: 'failed-rollback', detail: `${receipt.component} on ${receipt.host} unhealthy at ${receipt.sha}: ${line}`, diagnose: receipt };
    if (receipt.health === 'fail') {
      return { kind: 'set-status', status: 'Todo', reason: `rolled back to ${receipt.rollback}`, diagnose: receipt, followUp: {
        title: `Deploy failed: ${receipt.component} at ${receipt.sha.slice(0, 12)}`,
        body: `${issue.identifier} was rolled back on ${receipt.host}.\n\n\`\`\`\n${line}\n\`\`\`\n\nRead \`journalctl -u factory-deploy\` on ${receipt.host} for the installer and probe output.`,
      } };
    }
    // Green receipt: the Verifier judges the Done-means items against the deployed system and
    // posts `odd-verify` for the receipt's SHA (verifyLine). A failed verification waits on the
    // Bug it filed; the next release's receipt carries a new SHA and is verified again.
    const verify = issue.verify?.sha === receipt.sha ? issue.verify : undefined;
    if (!verify) return spawn('verifier', load, `verify ${receipt.component} at ${receipt.sha.slice(0, 12)}`, issue);
    if (verify.result === 'pass') return { kind: 'set-status', status: 'Done', reason: `verified ${receipt.component} at ${receipt.sha.slice(0, 12)}` };
    return { kind: 'wait', reason: `verification failed at ${receipt.sha.slice(0, 12)}; bug ${verify.bug ?? 'not filed'}` };
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
