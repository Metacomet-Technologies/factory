import test from 'node:test';
import assert from 'node:assert/strict';
import { changesRounds, ciState, delivered, finishedThreads, issueFromEvent, loadFrom, openRounds, prOwnsIssue, receiptLabel, riskFrom, toSnapshot, verdictFor, type GitHubPullRequest, type LiveThread } from './snapshot.ts';
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

test('a ready verdict from the builder\'s lab never merges, whether the builder thread names its lab, lacks the label, or is gone', () => {
  const issue = { id: 'MET-1', status: 'In Progress', labels: ['odd'] };
  const pr: GitHubPullRequest = { number: 9, headRefOid: sha, state: 'OPEN', statusCheckRollup: [check('SUCCESS')] };
  const ready = (lab: string): LiveThread => ({ id: `T-${lab}`, labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-1', `odd-engine-${lab}`, `odd-verdict-ready-${sha.slice(0, 12)}`], state: 'idle' });
  const builder = (labels: string[]): LiveThread => ({ id: 'T-b', labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-1', ...labels], state: 'idle' });
  const idle = { orbs: 0, runnerSlots: 0, buildIssues: 1 };
  const next = (threads: LiveThread[]) => nextAction(toSnapshot({ issue, pr, threads }), idle);
  for (const builders of [[builder(['odd-engine-anthropic'])], [builder([])], []]) {
    assert.equal(next([...builders, ready('anthropic')]).kind, 'spawn', JSON.stringify(builders));
    // Positive control: the same verdict from another lab merges.
    assert.deepEqual(next([...builders, ready('openai')]), { kind: 'merge', pr: 9, sha });
  }
  // A builder labelled with another lab makes that lab's verdict the refused one.
  assert.equal(next([builder(['odd-engine-openai']), ready('openai')]).kind, 'spawn');
  assert.deepEqual(next([builder(['odd-engine-openai']), ready('anthropic')]), { kind: 'merge', pr: 9, sha });
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
  // linear.list_comments returns newest first. A receipt from before the latest merge belongs to
  // the previous deploy of a re-opened issue; the receipt after it counts.
  const merge = (n: number, at: string) => ({ body: `odd-merge pr=${n} head=a merge=b release=none`, createdAt: at });
  const receipt = (health: string, at: string) => ({ body: `odd-deploy host=gpu component=api sha=abc1234 health=${health} rollback=none`, createdAt: at });
  const deploying = (comments: { body: string; createdAt: string }[]) => toSnapshot({ issue: { id: 'met-277', status: 'Deploying', labels: [], comments } }).deployReceipt;
  assert.equal(deploying([merge(2, '2026-10-24T13:30:00Z'), receipt('fail', '2026-10-24T13:20:00Z'), merge(1, '2026-10-24T13:10:00Z')]), undefined);
  assert.equal(deploying([receipt('pass', '2026-10-24T13:40:00Z'), merge(1, '2026-10-24T13:30:00Z')])?.health, 'pass');
  assert.equal(deploying([receipt('pass', '2026-10-24T13:40:00Z'), merge(2, '2026-10-24T13:30:00Z'), receipt('fail', '2026-10-24T13:20:00Z'), merge(1, '2026-10-24T13:10:00Z')])?.health, 'pass');
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
  // Intake and Spec both work in Triage (Backlog is never worked), so an idle intake thread there is mid-handoff, not finished.
  assert.deepEqual(finishedThreads('Backlog', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'builder-idle', 'reviewer-idle', 'verifier-idle']);
  assert.deepEqual(finishedThreads('Triage', threads).map(t => t.id), ['builder-idle', 'reviewer-idle', 'verifier-idle']);
  assert.deepEqual(finishedThreads('Todo', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'reviewer-idle', 'verifier-idle']);
  assert.deepEqual(finishedThreads('In Progress', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'verifier-idle']);
  assert.deepEqual(finishedThreads('Deploying', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'builder-idle', 'reviewer-idle']);
  assert.deepEqual(finishedThreads('Duplicate', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'builder-idle', 'reviewer-idle', 'verifier-idle']);
});

test('the owner is the running thread, else the builder, so a steer targets the builder beside an idle reviewer', () => {
  const builder: LiveThread = { id: 'T-b', labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-1'], state: 'idle' };
  const reviewer: LiveThread = { id: 'T-r', labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-1', `odd-verdict-changes-${sha.slice(0, 12)}`], state: 'idle' };
  const issue = { id: 'MET-1', status: 'In Progress', labels: [] };
  assert.equal(toSnapshot({ issue, threads: [reviewer, builder] }).owner?.threadID, 'T-b');
  assert.equal(toSnapshot({ issue, threads: [builder, { ...reviewer, state: 'running' }] }).owner?.threadID, 'T-r');
  assert.equal(changesRounds([reviewer, { ...reviewer, id: 'T-r2' }, { ...builder, labels: [...builder.labels, 'odd-verdict-changes-' + 'e'.repeat(12)] }]), 2);
});

test('open rounds skip reviewer threads that delivered a verdict; the owner carries its idle time', () => {
  const threads: LiveThread[] = [
    { id: 'T-b', labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-2'], state: 'idle', updatedAt: '2026-10-24T15:00:00Z' },
    { id: 'T-r1', labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-1', `odd-verdict-changes-${sha.slice(0, 12)}`], state: 'idle' },
    { id: 'T-r2', labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-2'], state: 'idle' },
  ];
  assert.deepEqual(openRounds(threads), { builder: 2, reviewer: 2 });
  const snapshot = toSnapshot({ issue: { id: 'MET-1', status: 'In Progress', labels: [] }, threads });
  assert.deepEqual(snapshot.owner, { role: 'builder', threadID: 'T-b', round: 2, state: 'idle', idleSince: '2026-10-24T15:00:00Z' });
});

test('cancelled rounds and verify comments come from the issue; an escalation comment resets the cancelled count', () => {
  const at = (minute: number) => `2026-10-24T15:${String(minute).padStart(2, '0')}:00Z`;
  const comments = [
    { body: 'odd-watchdog cancelled role=builder thread=T-1 round=1', createdAt: at(1) },
    { body: 'odd-watchdog cancelled role=builder thread=T-2 round=2', createdAt: at(2) },
    { body: 'odd-escalated reason=budget-ceiling\n\nMET-1: builder spent 2/2 rounds', createdAt: at(3) },
    { body: 'odd-verify sha=abcdef1234 result=fail bug=MET-9', createdAt: at(4) },
    { body: 'odd-watchdog cancelled role=reviewer thread=T-3 round=1', createdAt: at(5) },
  ];
  const snapshot = toSnapshot({ issue: { id: 'MET-1', status: 'Todo', labels: [], comments: [...comments].reverse() } });
  assert.deepEqual(snapshot.cancelledRounds, { reviewer: 1 });
  assert.deepEqual(snapshot.verify, { sha: 'abcdef1234', result: 'fail', bug: 'MET-9' });
  assert.deepEqual(toSnapshot({ issue: { id: 'MET-1', status: 'Todo', labels: [], comments: comments.slice(0, 2) } }).cancelledRounds, { builder: 2 });
});

test('after a third changes verdict and a cleared escalation, the spent reviewers are archived and the builder gets a fresh round', () => {
  const changes = (n: number, head: string): LiveThread => ({ id: `T-r${n}`, labels: ['odd-issue-met-1', 'odd-role-reviewer', `odd-round-${n}`, `odd-verdict-changes-${head}`], state: 'idle' });
  const builder: LiveThread = { id: 'T-b', labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-1'], state: 'idle' };
  const pr: GitHubPullRequest = { number: 9, headRefOid: sha, state: 'OPEN', statusCheckRollup: [check('SUCCESS')] };
  const issue = { id: 'MET-1', status: 'In Progress', labels: [], comments: [{ body: 'odd-escalated reason=third-failed-qa-round\n\nMET-1: PR #9 rejected 3 times', createdAt: '2026-10-24T15:00:00Z' }] };
  const all = [builder, changes(1, 'a'.repeat(12)), changes(2, 'b'.repeat(12)), changes(3, sha.slice(0, 12))];
  assert.equal(nextAction(toSnapshot({ issue, pr, threads: all }), { orbs: 0, runnerSlots: 0, buildIssues: 1 }).kind, 'page');
  // page() archives the reviewer threads whose changes verdict is for another head.
  const resumed = toSnapshot({ issue, pr, threads: [builder, changes(3, sha.slice(0, 12))] });
  assert.equal(resumed.pr?.changesRounds, 1);
  assert.equal(nextAction(resumed, { orbs: 0, runnerSlots: 0, buildIssues: 1 }).kind, 'steer');
  assert.deepEqual(nextAction(toSnapshot({ issue, pr, threads: [changes(3, sha.slice(0, 12))] }), { orbs: 0, runnerSlots: 0, buildIssues: 0 }),
    { kind: 'spawn', role: 'builder', executor: 'orb', reason: 'qa changes, round 2', round: 1 });
});

test('a reviewer that delivered changes for an older head does not hold a round: the new head is reviewed', () => {
  const issue = { id: 'MET-1', status: 'In Progress', labels: ['odd'] };
  const pr: GitHubPullRequest = { number: 9, headRefOid: sha, state: 'OPEN', statusCheckRollup: [check('SUCCESS')] };
  const reviewer: LiveThread = { id: 'T-r2', labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-2', `odd-verdict-changes-${'b'.repeat(12)}`], state: 'idle', updatedAt: '2026-10-24T11:00:00Z' };
  const snapshot = toSnapshot({ issue, pr, threads: [reviewer] });
  assert.equal(snapshot.owner?.threadID, 'T-r2');
  assert.deepEqual(nextAction(snapshot, { orbs: 0, runnerSlots: 0, buildIssues: 0 }),
    { kind: 'spawn', role: 'reviewer', executor: 'orb', reason: `no verdict at ${sha.slice(0, 12)}`, round: 1 });
});

test('a new release starts a fresh verifier budget despite the old receipt\'s verifier thread and cancellations', () => {
  const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
  const at = (minute: number) => `2026-10-24T15:${String(minute).padStart(2, '0')}:00Z`;
  const comments = [
    { body: 'odd-merge pr=9 head=c merge=d release=v1', createdAt: at(0) },
    { body: `odd-deploy host=factory-gpu component=kiosk sha=${a} health=pass rollback=none`, createdAt: at(1) },
    { body: 'odd-watchdog cancelled role=verifier thread=T-v1 round=1', createdAt: at(2) },
    { body: `odd-verify sha=${a} result=fail bug=MET-2\n- fail chip pulses`, createdAt: at(3) },
  ];
  const old: LiveThread = { id: 'T-v2', labels: ['odd-issue-met-1', 'odd-role-verifier', 'odd-round-2', receiptLabel(a)], state: 'idle', updatedAt: at(3) };
  const issue = (extra: typeof comments) => ({ id: 'MET-1', status: 'Deploying', labels: ['odd'], comments: [...comments, ...extra] });
  const load = { orbs: 0, runnerSlots: 0, buildIssues: 0 };
  // Same release: the failed verification waits on its Bug.
  assert.equal(nextAction(toSnapshot({ issue: issue([]), threads: [old] }), load).kind, 'wait');
  const next = toSnapshot({ issue: issue([{ body: `odd-deploy host=factory-gpu component=kiosk sha=${b} health=pass rollback=none`, createdAt: at(4) }]), threads: [old] });
  assert.deepEqual(next.openRounds, {});
  assert.deepEqual(next.cancelledRounds, {});
  assert.deepEqual(nextAction(next, load), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify kiosk at bbbbbbbbbbbb', round: 1 });
  // A verifier of the current receipt holds its round; an older verifier is delivered.
  const current: LiveThread = { ...old, id: 'T-v3', labels: ['odd-issue-met-1', 'odd-role-verifier', 'odd-round-2', receiptLabel(b)] };
  assert.deepEqual(openRounds([old, current], b), { verifier: 2 });
  assert.equal(delivered(old, b), true);
  assert.equal(delivered(current, b), false);
});

test('P3.1: wait ages come from the head commit, the merge and the steer comment, never from the sweep; a missing source stays unknown', () => {
  const builder: LiveThread = { id: 'T-b', labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-1'], state: 'idle' };
  const older = 'f'.repeat(40);
  const open: GitHubPullRequest = { number: 9, headRefOid: sha, state: 'OPEN', statusCheckRollup: [check(null, 'PENDING')], mergeable: 'MERGEABLE',
    commits: [{ oid: older, committedDate: '2026-10-26T08:00:00Z' }, { oid: sha, committedDate: '2026-10-26T09:00:00Z' }] };
  const issue = { id: 'MET-1', status: 'In Progress', labels: ['odd'] };
  const pending = toSnapshot({ issue, pr: open, threads: [builder] });
  assert.equal(pending.pr?.headAt, '2026-10-26T09:00:00Z', 'the head commit, not an older one');
  assert.deepEqual((nextAction(pending, { orbs: 0, runnerSlots: 0, buildIssues: 1 }) as { wait?: object }).wait, { kind: 'ci', key: `ci-${sha.slice(0, 12)}`, since: '2026-10-26T09:00:00Z' });
  // GitHub did not report the head commit: the age is unknown, not "since this sweep".
  const undated = toSnapshot({ issue, pr: { ...open, commits: [{ oid: older, committedDate: '2026-10-26T08:00:00Z' }] }, threads: [builder] });
  assert.equal(undated.pr?.headAt, undefined);
  // CONFLICTING: CI never runs, so the builder is steered to rebase instead of waiting on pending CI.
  const conflicting = toSnapshot({ issue, pr: { ...open, mergeable: 'CONFLICTING' }, threads: [builder] });
  assert.equal((nextAction(conflicting, { orbs: 0, runnerSlots: 0, buildIssues: 1 }) as { key?: string }).key, `conflict-${sha.slice(0, 12)}`);
  const merged = toSnapshot({ issue: { ...issue, status: 'Deploying' }, pr: { ...open, state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) }, mergedAt: '2026-10-26T10:00:00Z' } });
  assert.deepEqual((nextAction(merged, { orbs: 0, runnerSlots: 0, buildIssues: 0 }) as { wait?: object }).wait, { kind: 'receipt', key: `receipt-${'e'.repeat(12)}`, since: '2026-10-26T10:00:00Z' });
  // The steer record dates the unanswered steer; the first record of a key wins over a later duplicate.
  const key = `ci-failed-${sha.slice(0, 12)}`;
  const steered = toSnapshot({ issue: { ...issue, comments: [
    { body: `odd-steer key=${key} thread=T-b`, createdAt: '2026-10-26T11:05:00Z' },
    { body: `odd-steer key=${key} thread=T-b`, createdAt: '2026-10-26T11:00:00Z' },
  ] }, pr: { ...open, statusCheckRollup: [check('FAILURE')] }, threads: [builder] });
  assert.deepEqual(steered.steers, { [key]: '2026-10-26T11:00:00Z' });
  assert.deepEqual((nextAction(steered, { orbs: 0, runnerSlots: 0, buildIssues: 1 }) as { wait?: object }).wait, { kind: 'steer', key: `steer-${key}`, since: '2026-10-26T11:00:00Z' });
});
