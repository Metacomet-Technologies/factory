import test from 'node:test';
import assert from 'node:assert/strict';
import { changesRounds, ciState, finishedThreads, issueFromEvent, loadFrom, prOwnsIssue, riskFrom, toSnapshot, verdictFor, type GitHubPullRequest, type LiveThread } from './snapshot.ts';
import { nextAction } from './lifecycle.ts';

const sha = 'abcdef0123456789'.repeat(2) + 'abcdef01';
const check = (conclusion: string | null, state?: string) => ({ name: 'ci', conclusion, state: state ?? null });

test('webhook deliveries resolve to one issue or none', () => {
  assert.equal(issueFromEvent('linear', JSON.stringify({ type: 'Issue', data: { identifier: 'met-277' } })), 'MET-277');
  assert.equal(issueFromEvent('linear', JSON.stringify({ type: 'Comment', data: { body: 'x', issue: { identifier: 'MET-9' } } })), 'MET-9');
  assert.equal(issueFromEvent('linear', JSON.stringify({ type: 'Project', data: { name: 'p' } })), undefined);
  assert.equal(issueFromEvent('github', JSON.stringify({ pull_request: { head: { ref: 'met-277-odd-control' }, body: '' } })), 'MET-277');
  assert.equal(issueFromEvent('github', JSON.stringify({ pull_request: { head: { ref: 'feature' }, body: 'Closes MET-12.' } })), 'MET-12');
  assert.equal(issueFromEvent('github', JSON.stringify({ check_suite: { head_branch: 'met-277-odd-arm', conclusion: 'success' } })), 'MET-277');
  assert.equal(issueFromEvent('github', JSON.stringify({ workflow_run: { head_branch: 'MET-9-x' } })), 'MET-9');
  assert.equal(issueFromEvent('github', JSON.stringify({ check_suite: { head_branch: 'main' } })), undefined);
  assert.equal(issueFromEvent('github', JSON.stringify({ release: { tag_name: 'v1' } })), undefined);
  assert.equal(issueFromEvent('slack', JSON.stringify({ event: { text: 'MET-1 is broken' } })), undefined);
  assert.equal(issueFromEvent('linear', '{not json'), undefined);
});

test('a PR owns an issue by branch prefix or closes/contributes line, not by a mention in prose', () => {
  assert.equal(prOwnsIssue({ headRefName: 'met-301-first-autonomous-run', body: '' }, 'MET-301'), true);
  assert.equal(prOwnsIssue({ headRefName: 'fix-search', body: 'Explains it.\n\ncontributes MET-301\n' }, 'MET-301'), true);
  assert.equal(prOwnsIssue({ headRefName: 'feature', body: 'Closes met-301' }, 'MET-301'), true);
  assert.equal(prOwnsIssue({ headRefName: 'met-3010-other', body: 'closes MET-3010' }, 'MET-301'), false);
  assert.equal(prOwnsIssue({ headRefName: 'met-279-recheck', body: 'contributes MET-279\n\nThe first live run (MET-301, PR #178) stalled.' }, 'MET-301'), false);
  assert.equal(prOwnsIssue({}, 'MET-301'), false);
});

test('CI rollup: any failure beats pending, pending beats success, no checks is pending', () => {
  assert.equal(ciState([check('SUCCESS'), check(null, 'PENDING')]), 'pending');
  assert.equal(ciState([check('SUCCESS'), check('FAILURE'), check(null, 'PENDING')]), 'failure');
  assert.equal(ciState([check('SUCCESS'), check('SKIPPED')]), 'success');
  assert.equal(ciState([]), 'pending');
});

test('verdict labels bind to the PR head by 12-char prefix; a stale verdict is ignored', () => {
  const reviewer: LiveThread = { id: 'T-r', labels: ['odd-role-reviewer', `odd-verdict-ready-${sha.slice(0, 12)}`], state: 'idle' };
  assert.deepEqual(verdictFor([reviewer], sha), { state: 'ready', sha });
  assert.equal(verdictFor([reviewer], 'f'.repeat(40)), undefined);
  assert.equal(riskFrom('## Context\nrisk: Security\n'), 'security');
  assert.equal(riskFrom('risky business'), undefined);
});

test('snapshot combines Linear, GitHub and thread state, and feeds nextAction', () => {
  const pr: GitHubPullRequest = { number: 157, headRefOid: sha, state: 'OPEN', statusCheckRollup: [check('SUCCESS')] };
  const builder: LiveThread = { id: 'T-b', labels: ['odd-issue-met-277', 'odd-role-builder', 'odd-round-2'], state: 'idle' };
  const snapshot = toSnapshot({
    issue: { id: 'met-277', status: 'In Progress', labels: ['area:agents'], description: '## Context\nrisk: ordinary\n', comments: [{ body: 'odd-deploy host=gpu component=api sha=abc1234 health=pass rollback=none' }] },
    pr, threads: [builder],
  });
  assert.equal(snapshot.identifier, 'MET-277');
  assert.deepEqual(snapshot.owner, { role: 'builder', threadID: 'T-b', round: 2, state: 'idle' });
  assert.deepEqual(snapshot.pr, { number: 157, headSha: sha, ci: 'success', verdict: undefined, merged: false, mergeSha: undefined, changesRounds: 0 });
  assert.equal(snapshot.deployReceipt?.health, 'pass');
  // A receipt from before the latest merge belongs to the previous deploy of a re-opened issue.
  const reopened = toSnapshot({ issue: { id: 'met-277', status: 'Deploying', labels: [], comments: [
    { body: 'odd-deploy host=gpu component=api sha=abc1234 health=fail rollback=/var/backups/x' },
    { body: 'odd-merge pr=1 head=a merge=b release=none' },
  ] } });
  assert.equal(reopened.deployReceipt, undefined);
  assert.equal(snapshot.risk, 'ordinary');
  assert.deepEqual(nextAction(snapshot, { orbs: 0, runnerSlots: 0, buildIssues: 1 }), { kind: 'spawn', role: 'reviewer', executor: 'orb', reason: `no verdict at ${sha.slice(0, 12)}`, round: 1 });
  const unknown = toSnapshot({ issue: { id: 'MET-1', status: 'Nonsense', labels: [] } });
  assert.equal(unknown.status, 'Backlog');
  assert.equal(unknown.pr, undefined);
});

test('load counts running role threads by executor, and build issues by any live builder thread', () => {
  const threads: LiveThread[] = [
    { id: '1', labels: ['odd-role-builder', 'odd-issue-met-1'], state: 'running' },
    { id: '2', labels: ['odd-role-builder', 'odd-issue-met-2'], state: 'idle' },
    { id: '2b', labels: ['odd-role-builder', 'odd-issue-met-2', 'odd-round-2'], state: 'idle' },
    { id: '3', labels: ['odd-role-deployer'], state: 'tool-running' },
    { id: '4', labels: ['odd-role-shipper'], state: 'running' },
    { id: '5', labels: ['unrelated'], state: 'running' },
  ];
  assert.deepEqual(loadFrom(threads), { orbs: 1, runnerSlots: 1, buildIssues: 2 });
});

test('finished threads: idle role threads whose stage the issue has left; running, later roles and unlabelled threads stay', () => {
  const threads: LiveThread[] = [
    { id: 'intake-idle', labels: ['odd-role-intake', 'odd-issue-met-1'], state: 'idle' },
    { id: 'intake-running', labels: ['odd-role-intake', 'odd-issue-met-1'], state: 'streaming' },
    { id: 'spec-idle', labels: ['odd-role-spec', 'odd-issue-met-1'], state: 'idle' },
    { id: 'builder-idle', labels: ['odd-role-builder', 'odd-issue-met-1'], state: 'idle' },
    { id: 'reviewer-idle', labels: ['odd-role-reviewer', 'odd-issue-met-1'], state: 'idle' },
    { id: 'verifier-idle', labels: ['odd-role-verifier', 'odd-issue-met-1'], state: 'idle' },
    { id: 'plain', labels: ['odd-issue-met-1'], state: 'idle' },
  ];
  // A builder or reviewer thread beside an issue that went back to Backlog or Triage is stale too.
  assert.deepEqual(finishedThreads('Backlog', threads).map(t => t.id), ['builder-idle', 'reviewer-idle']);
  assert.deepEqual(finishedThreads('Triage', threads).map(t => t.id), ['intake-idle', 'builder-idle', 'reviewer-idle']);
  assert.deepEqual(finishedThreads('Todo', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'reviewer-idle']);
  assert.deepEqual(finishedThreads('In Progress', threads).map(t => t.id), ['intake-idle', 'spec-idle']);
  assert.deepEqual(finishedThreads('Deploying', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'builder-idle', 'reviewer-idle']);
  assert.deepEqual(finishedThreads('Duplicate', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'builder-idle', 'reviewer-idle']);
});

test('the owner is the running thread, else the builder, so a steer targets the builder beside an idle reviewer', () => {
  const builder: LiveThread = { id: 'T-b', labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-1'], state: 'idle' };
  const reviewer: LiveThread = { id: 'T-r', labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-1', `odd-verdict-changes-${sha.slice(0, 12)}`], state: 'idle' };
  const issue = { id: 'MET-1', status: 'In Progress', labels: [] };
  assert.equal(toSnapshot({ issue, threads: [reviewer, builder] }).owner?.threadID, 'T-b');
  assert.equal(toSnapshot({ issue, threads: [builder, { ...reviewer, state: 'running' }] }).owner?.threadID, 'T-r');
  assert.equal(changesRounds([reviewer, { ...reviewer, id: 'T-r2' }, { ...builder, labels: [...builder.labels, 'odd-verdict-changes-' + 'e'.repeat(12)] }]), 2);
});
