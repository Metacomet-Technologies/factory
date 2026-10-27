import test from 'node:test';
import assert from 'node:assert/strict';
import { admittedLoad, bindingCandidate, buildEpoch, changesRounds, ciState, currentBinding, delivered, diagnosedLabel, draftedLine, failedReceiptAt, finishedThreads, issueFromEvent, linearUnresolved, loadFrom, openRounds, parseIdentity, parsePrBinding, prBindingLine, prEligible, prOwnsIssue, readerLabel, receiptLabel, reconciles, releasedDraft, riskFrom, spawnRecords, threadState, toSnapshot, trustedComments, verdictFor, undraftedLine, verifiedFor, verifiedLabels, type GitHubPullRequest, type LiveThread } from './snapshot.ts';
import { contractOf, nextAction, parseSpawn, spawnKey, spawnLine } from './lifecycle.ts';

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

test('P3.13: a documented Linear Comment payload resolves its issue from the comment URL; explicit identifiers keep priority; malformed or foreign URLs never resolve', () => {
  const issueId = '731161c3-191b-46df-8500-c493d2eba9e1';
  const comment = (url: unknown, data: Record<string, unknown> = {}, type = 'Comment') =>
    JSON.stringify({ action: 'create', type, data: { id: 'c1', body: 'please retry', issueId, ...data }, url, webhookTimestamp: 1 });
  const documented = 'https://linear.app/metacomet/issue/MET-358/odd-optionally-resolve#comment-b9a7f299';
  const rows: [string, string, string | undefined, string | undefined][] = [
    // [name, body, issue, diagnostic]
    ['documented Comment URL', comment(documented), 'MET-358', undefined],
    ['URL without slug', comment('https://linear.app/metacomet/issue/MET-358'), 'MET-358', undefined],
    ['URL with trailing slash and query', comment('https://linear.app/metacomet/issue/met-358/?x=1'), 'MET-358', undefined],
    ['data.issue.identifier beats the URL', comment(documented, { issue: { id: issueId, identifier: 'MET-9' } }), 'MET-9', undefined],
    ['data.identifier beats the URL', comment(documented, { identifier: 'MET-10' }), 'MET-10', undefined],
    ['a malformed explicit identifier does not fall back to the URL', comment(documented, { issue: { identifier: 'ENG-9' } }), undefined, 'linear-unresolved type=Comment'],
    ['an explicit identifier with trailing text is malformed', comment(documented, { identifier: 'MET-10 MET-11' }), undefined, 'linear-unresolved type=Comment'],
    ['data.issue without identifier still uses the URL', comment(documented, { issue: { id: issueId, title: 't' } }), 'MET-358', undefined],
    ['Issue payload keeps its identifier', JSON.stringify({ type: 'Issue', data: { id: issueId, identifier: 'MET-5' }, url: documented }), 'MET-5', undefined],
    ['Issue payload never uses the URL', JSON.stringify({ type: 'Issue', data: { id: issueId }, url: documented }), undefined, 'linear-unresolved type=Issue'],
    ['foreign team prefix', comment('https://linear.app/metacomet/issue/ENG-358/x'), undefined, 'linear-unresolved type=Comment'],
    ['foreign host', comment('https://linear.app.evil.example/metacomet/issue/MET-1/x'), undefined, 'linear-unresolved type=Comment'],
    ['plain http', comment('http://linear.app/metacomet/issue/MET-358/x'), undefined, 'linear-unresolved type=Comment'],
    ['credentials in the URL', comment('https://a:b@linear.app/metacomet/issue/MET-358/x'), undefined, 'linear-unresolved type=Comment'],
    ['identifier only in the fragment', comment('https://linear.app/metacomet/project/p#MET-358'), undefined, 'linear-unresolved type=Comment'],
    ['identifier only in the query', comment('https://linear.app/metacomet/issue/x?MET-358'), undefined, 'linear-unresolved type=Comment'],
    ['identifier glued to more text', comment('https://linear.app/metacomet/issue/MET-358x/y'), undefined, 'linear-unresolved type=Comment'],
    ['two identifiers in the path', comment('https://linear.app/metacomet/issue/MET-1/issue/MET-2'), undefined, 'linear-unresolved type=Comment'],
    ['zero or leading-zero number', comment('https://linear.app/metacomet/issue/MET-0358/x'), undefined, 'linear-unresolved type=Comment'],
    ['truncated URL', comment('https://linear.app/metacomet/iss'), undefined, 'linear-unresolved type=Comment'],
    ['not a URL', comment('MET-358'), undefined, 'linear-unresolved type=Comment'],
    ['URL not a string', comment(['https://linear.app/metacomet/issue/MET-358/x']), undefined, 'linear-unresolved type=Comment'],
    ['no URL', comment(undefined), undefined, 'linear-unresolved type=Comment'],
    ['issueId not a UUID', comment(documented, { issueId: 'MET-358' }), undefined, 'linear-unresolved type=Comment'],
    ['issueId missing', comment(documented, { issueId: undefined }), undefined, 'linear-unresolved type=Comment'],
    ['another type with an issueId', comment(documented, {}, 'Reaction'), undefined, 'linear-unresolved type=Reaction'],
    ['an unsafe type is not echoed', comment(documented, {}, 'Reaction url=https://x'), undefined, 'linear-unresolved type=unknown'],
    ['not issue-scoped', JSON.stringify({ type: 'Project', data: { name: 'p' }, url: documented }), undefined, undefined],
    ['unparseable', '{"type":"Comment"', undefined, undefined],
  ];
  for (const [name, body, issue, diagnostic] of rows) {
    assert.equal(issueFromEvent('linear', body), issue, name);
    assert.equal(linearUnresolved(body), diagnostic, `${name}: diagnostic`);
  }
  // A Comment URL in a GitHub or Slack delivery is never read.
  assert.equal(issueFromEvent('github', comment(documented)), undefined);
  assert.equal(issueFromEvent('slack', comment(documented)), undefined);
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
  // P3.11: a status the lifecycle does not know is Unknown with its name, never parked as Backlog.
  const unknown = toSnapshot({ issue: { id: 'MET-1', status: 'Nonsense', labels: [] } });
  assert.equal(unknown.status, 'Unknown');
  assert.equal(unknown.unknownStatus, 'Nonsense');
  assert.equal(toSnapshot({ issue: { id: 'MET-1', status: 'Backlog', labels: [] } }).unknownStatus, undefined);
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
  // P3.11: review keeps the builder (and its build slot) and the reviewer; an unknown status archives nothing.
  assert.deepEqual(finishedThreads('In Review', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'verifier-idle']);
  assert.deepEqual(finishedThreads('Unknown', threads), []);
  assert.deepEqual(finishedThreads('Deploying', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'builder-idle', 'reviewer-idle']);
  assert.deepEqual(finishedThreads('Duplicate', threads).map(t => t.id), ['intake-idle', 'spec-idle', 'builder-idle', 'reviewer-idle', 'verifier-idle']);
});

// MET-404: finished verifier and reviewer threads are archived inside their stage, from durable inputs only.
const [oldReceipt, receipt, otherSha] = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
const role = (id: string, name: string, state: string, extra: string[] = []): LiveThread => ({ id, labels: ['odd-issue-met-9', `odd-role-${name}`, 'odd-round-1', ...extra], state });
const verifier = (id: string, receiptSha: string, state = 'idle', extra: string[] = []) => role(id, 'verifier', state, [receiptLabel(receiptSha), ...extra]);
const ids = (threads: readonly LiveThread[]) => threads.map(t => t.id);

test('MET-404 Done-means 1: an idle verifier with an odd-verify label is archived while the issue is still Deploying, once the plane recorded its result', () => {
  const failed = verifier('fail-recorded', receipt, 'idle', verifiedLabels({ sha: receipt, result: 'fail', bug: 'MET-51' }));
  const passed = verifier('pass-recorded', receipt, 'idle', verifiedLabels({ sha: receipt, result: 'pass' }));
  assert.deepEqual(ids(finishedThreads('Deploying', [failed], { receiptSha: receipt, verifiedSha: receipt })), ['fail-recorded']);
  assert.deepEqual(ids(finishedThreads('Deploying', [passed], { receiptSha: receipt, verifiedSha: receipt })), ['pass-recorded']);
  // Unrecorded, the label is the only copy of the output the plane writes as `odd-verify` (verifiedFor): kept until recorded.
  assert.deepEqual(finishedThreads('Deploying', [failed], { receiptSha: receipt }), []);
  assert.deepEqual(verifiedFor([failed], receipt), { sha: receipt, result: 'fail', bug: 'MET-51' });
  // A recorded line for another receipt (a replacing receipt at another SHA) does not record this one's output.
  assert.deepEqual(finishedThreads('Deploying', [failed], { receiptSha: receipt, verifiedSha: otherSha }), []);
  // Through the snapshot: the recorded `odd-verify` comment for the current receipt is what lets the thread go.
  const comments = [
    { body: `odd-deploy host=h component=api sha=${receipt} health=pass rollback=none`, createdAt: '2026-10-27T20:00:00Z' },
    { body: `odd-verify sha=${receipt} result=fail bug=MET-51\n- fail x`, createdAt: '2026-10-27T20:10:00Z' },
  ];
  const snap = toSnapshot({ issue: { id: 'MET-9', status: 'Deploying', labels: ['odd'], comments }, threads: [failed] });
  assert.deepEqual(ids(finishedThreads(snap.status, [failed], { receiptSha: snap.deployReceipt?.sha, verifiedSha: snap.verify?.sha })), ['fail-recorded']);
  // Unchanged without the current inputs: the stage rule alone keeps every verifier in Deploying.
  assert.deepEqual(finishedThreads('Deploying', [failed, passed]), []);
});

test('MET-404 Done-means 2: an idle verifier of a superseded receipt is archived while Deploying; the current-receipt verifier with no result is kept', () => {
  const threads = [
    verifier('superseded', oldReceipt),
    verifier('superseded-failed', oldReceipt, 'idle', verifiedLabels({ sha: oldReceipt, result: 'fail', bug: 'MET-50' })),
    verifier('current', receipt),
  ];
  assert.deepEqual(ids(finishedThreads('Deploying', threads, { receiptSha: receipt })), ['superseded', 'superseded-failed']);
  // The control on the other side of the boundary: with the old receipt current, only the newer-labelled thread is foreign.
  assert.deepEqual(ids(finishedThreads('Deploying', threads, { receiptSha: oldReceipt })), ['current']);
  // No receipt known (none parsed, or reset by a new merge): only the stage rule decides.
  assert.deepEqual(finishedThreads('Deploying', threads, {}), []);
  assert.deepEqual(ids(finishedThreads('Done', threads, {})), ['superseded', 'superseded-failed', 'current']);
});

test('MET-404 Done-means 3: an idle reviewer whose verdict is for a stale head is archived; the current-head reviewer with no verdict yet is kept', () => {
  const [stale, head] = ['a'.repeat(40), 'b'.repeat(40)];
  const threads = [
    role('stale-changes', 'reviewer', 'idle', [`odd-verdict-changes-${stale.slice(0, 12)}`]),
    role('stale-ready', 'reviewer', 'idle', [`odd-verdict-ready-${stale.slice(0, 12)}`]),
    role('current-no-verdict', 'reviewer', 'idle'),
    // A verdict for the current head is what the plane merges or steers on (verdictFor): kept.
    role('current-changes', 'reviewer', 'idle', [`odd-verdict-changes-${head.slice(0, 12)}`]),
  ];
  for (const status of ['In Progress', 'In Review'] as const) {
    assert.deepEqual(ids(finishedThreads(status, threads, { headSha: head })), ['stale-changes', 'stale-ready'], status);
  }
  // The other side: with the old head still the PR's, its verdict is current and nothing in the stage is finished.
  assert.deepEqual(ids(finishedThreads('In Review', threads, { headSha: stale })), ['current-changes']);
  assert.equal(verdictFor(finishedThreads('In Review', threads, { headSha: head }), head), undefined, 'archiving stale reviewers never removes the current verdict');
  assert.deepEqual(finishedThreads('In Review', threads), [], 'no PR head known: the stage rule alone keeps them');
});

test('MET-404 Done-means 4: a builder idle in In Review is kept, and a running or approval-blocked verifier or reviewer is never archived', () => {
  const head = 'b'.repeat(40);
  const stale = `odd-verdict-changes-${'a'.repeat(12)}`;
  const current = { receiptSha: receipt, verifiedSha: receipt, headSha: head };
  const threads = [
    role('builder-idle', 'builder', 'idle', [stale]),
    verifier('verifier-running', oldReceipt, 'running'),
    verifier('verifier-working', receipt, 'working', verifiedLabels({ sha: receipt, result: 'pass' })),
    verifier('verifier-approval', oldReceipt, 'awaiting-approval'),
    verifier('verifier-error', oldReceipt, 'error'),
    role('reviewer-running', 'reviewer', 'tool_use', [stale]),
    role('reviewer-approval', 'reviewer', 'awaiting_approval', [stale]),
  ];
  for (const status of ['In Progress', 'In Review', 'Deploying'] as const) {
    assert.deepEqual(ids(finishedThreads(status, threads, current)), status === 'Deploying' ? ['builder-idle'] : [], status);
  }
  assert.deepEqual(finishedThreads('Unknown', [...threads, verifier('superseded', oldReceipt)], current), [], 'an Unknown status still archives nothing');
});

test('MET-404: review rounds survive archiving stale-head reviewers, counted from the delivered changes steers', () => {
  const [h1, h2, h3] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  const pr: GitHubPullRequest = { number: 9, headRefName: 'met-9-x', headRefOid: h3, state: 'OPEN', statusCheckRollup: [check('SUCCESS')] };
  const steer = (head: string, minute: number) => ({ body: `odd-steer key=changes-${head.slice(0, 12)} thread=T-b`, createdAt: `2026-10-27T20:0${minute}:00Z` });
  const current = role('r3', 'reviewer', 'idle', [`odd-verdict-changes-${h3.slice(0, 12)}`]);
  const issue = { id: 'MET-9', status: 'In Review', labels: ['odd'], comments: [steer(h1, 1), steer(h2, 2), { body: 'odd-steer key=ci-failed-cccccccccccc thread=T-b', createdAt: '2026-10-27T20:03:00Z' }] };
  // h1 and h2 reviewers are archived; their steers still count, a ci steer does not, and the live h3 verdict adds one.
  assert.equal(toSnapshot({ issue, pr, threads: [current] }).pr?.changesRounds, 3);
  // A head both steered and still labelled counts once.
  assert.equal(changesRounds([role('r1', 'reviewer', 'idle', [`odd-verdict-changes-${h1.slice(0, 12)}`])], [`changes-${h1.slice(0, 12)}`]), 1);
  assert.equal(changesRounds([], ['changes-not-a-sha', `conflict-${h1.slice(0, 12)}`]), 0);
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

test('MET-338: the Verifier\'s odd_verify output counts only on a verifier thread labelled with the current receipt, with one result and a Bug exactly on fail', () => {
  const sha = 'c'.repeat(40);
  const verifier = (id: string, labels: string[], role = 'verifier', receipt = sha): LiveThread => ({ id, labels: ['odd-issue-met-1', `odd-role-${role}`, 'odd-round-1', receiptLabel(receipt), ...labels], state: 'idle' });
  const pass = verifiedLabels({ sha, result: 'pass' });
  const fail = verifiedLabels({ sha, result: 'fail', bug: 'MET-9' });
  assert.deepEqual(fail, [`odd-verify-fail-${sha.slice(0, 12)}`, 'odd-verify-bug-met-9']);
  for (const label of [...pass, ...fail]) assert.match(label, /^[a-z0-9][a-z0-9-]{0,31}$/);
  assert.deepEqual(verifiedFor([verifier('T-v', pass)], sha), { sha, result: 'pass' });
  assert.deepEqual(verifiedFor([verifier('T-v', fail)], sha), { sha, result: 'fail', bug: 'MET-9' });
  for (const [why, thread] of [
    ['a reviewer thread', verifier('T-r', pass, 'reviewer')],
    ['a verifier of another receipt', verifier('T-o', verifiedLabels({ sha: 'd'.repeat(40), result: 'pass' }), 'verifier', 'd'.repeat(40))],
    ['a result for another receipt', verifier('T-x', verifiedLabels({ sha: 'd'.repeat(40), result: 'pass' }))],
    ['pass with a Bug', verifier('T-pb', [...pass, 'odd-verify-bug-met-9'])],
    ['fail without a Bug', verifier('T-f', [fail[0]])],
    ['two results', verifier('T-2', [...pass, fail[0], fail[1]])],
    ['two Bugs', verifier('T-2b', [...fail, 'odd-verify-bug-met-10'])],
  ] as const) assert.equal(verifiedFor([thread], sha), undefined, why);
  const receipt = { body: `odd-deploy host=factory-gpu component=kiosk sha=${sha} health=pass rollback=none`, createdAt: '2026-10-24T15:00:00Z' };
  assert.deepEqual(toSnapshot({ issue: { id: 'MET-1', status: 'Deploying', labels: [], comments: [receipt] }, threads: [verifier('T-v', fail)] }).verified, { sha, result: 'fail', bug: 'MET-9' });
  assert.equal(toSnapshot({ issue: { id: 'MET-1', status: 'Deploying', labels: [], comments: [] }, threads: [verifier('T-v', fail)] }).verified, undefined, 'no receipt, nothing to record');
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
  // MET-348: the legacy escalation started epoch 2, whose first correction records its budget before the steer.
  assert.equal(resumed.correction?.epoch, 2);
  assert.equal(nextAction(resumed, { orbs: 0, runnerSlots: 0, buildIssues: 1 }).kind, 'admit');
  assert.equal(nextAction(toSnapshot({ issue, pr, threads: [changes(3, sha.slice(0, 12))] }), { orbs: 0, runnerSlots: 0, buildIssues: 0 }).kind, 'admit');
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

test('MET-386: a receipt set that replaces another receipt needs its own verification: a partial or stale one never closes it, even at the same round SHA', () => {
  const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
  const at = (minute: number) => `2026-10-27T15:${String(minute).padStart(2, '0')}:00Z`;
  const uniform = `odd-deploy host=factory-gpu component=kiosk sha=${b} health=pass rollback=none`;
  const set = `odd-deploy host=factory-gpu component=meter+kiosk sha=${b} health=pass rollback=none round=v0.3.0 set=meter:${a}@v0.2.50,kiosk:${b}@v0.3.0`;
  const derive = (bodies: string[]) => {
    const snapshot = toSnapshot({ issue: { id: 'MET-1', status: 'Deploying', labels: ['odd'], comments: bodies.map((body, i) => ({ body, createdAt: at(i) })).reverse() } });
    return { verify: snapshot.verify, action: nextAction(snapshot, { orbs: 0, runnerSlots: 0, buildIssues: 0 }) };
  };
  const spawn = { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify meter+kiosk at bbbbbbbbbbbb', round: 1 };
  // A pass for a kiosk-only receipt at the round SHA, then the complete set at that SHA: the set needs its own verification.
  assert.deepEqual(derive([uniform, `odd-verify sha=${b} result=pass bug=none`, set]), { verify: undefined, action: spawn });
  // A stale pass for meter's own older SHA does not match the set's round.
  assert.deepEqual(derive([`odd-deploy host=factory-gpu component=meter sha=${a} health=pass rollback=none`, `odd-verify sha=${a} result=pass bug=none`, set]).action, spawn);
  // Controls: the set's own verification is Done, and a repost of the same set line keeps it.
  const done = { kind: 'set-status', status: 'Done', reason: 'verified meter+kiosk at bbbbbbbbbbbb' };
  assert.deepEqual(derive([set, `odd-verify sha=${b} result=pass bug=none`]).action, done);
  assert.deepEqual(derive([set, `odd-verify sha=${b} result=pass bug=none`, set]).action, done);
});

test('MET-367: historical tagless and new tagged receipts both drive the snapshot; a malformed tag is no receipt', () => {
  const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
  const at = (minute: number) => `2026-10-24T15:${String(minute).padStart(2, '0')}:00.000Z`;
  const historical = { body: `odd-deploy host=factory-gpu component=kiosk sha=${a} health=fail rollback=/var/backups/kiosk/snap`, createdAt: at(1) };
  const tagged = { body: `odd-deploy host=factory-gpu component=meter+kiosk sha=${b} tag=v0.3.1 health=pass rollback=none`, createdAt: at(3) };
  const malformed = { body: `odd-deploy host=factory-gpu component=kiosk sha=${a} tag=latest health=fail rollback=none`, createdAt: at(4) };
  const snapshot = (comments: { body: string; createdAt: string }[]) => toSnapshot({ issue: { id: 'MET-1', status: 'Deploying', labels: ['odd'], comments } });
  assert.deepEqual(snapshot([historical]).deployReceipt, { host: 'factory-gpu', component: 'kiosk', sha: a, health: 'fail', rollback: '/var/backups/kiosk/snap' });
  assert.deepEqual(snapshot([historical, tagged, malformed]).deployReceipt, { host: 'factory-gpu', component: 'meter+kiosk', sha: b, tag: 'v0.3.1', health: 'pass', rollback: 'none' });
  assert.deepEqual(nextAction(snapshot([historical, tagged, malformed]), { orbs: 0, runnerSlots: 0, buildIssues: 0 }), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify meter+kiosk at bbbbbbbbbbbb', round: 1 });
  // Red receipts bound merged PRs whether tagged or not; the malformed one never counts.
  assert.equal(failedReceiptAt([historical, malformed]), at(1));
  assert.equal(failedReceiptAt([historical, { ...tagged, body: tagged.body.replace('health=pass rollback=none', 'health=fail rollback=unchanged') }]), at(3));
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

test('P4.1: spawn records round-trip, a bound line wins over its pending line in any order, and keys name the head or receipt', () => {
  const pending = { role: 'reviewer' as const, round: 2, key: `reviewer-${sha.slice(0, 12)}` };
  assert.equal(spawnLine(pending), `odd-spawn role=reviewer round=2 key=reviewer-${sha.slice(0, 12)} thread=pending`);
  assert.deepEqual(parseSpawn(spawnLine(pending)), pending);
  assert.deepEqual(parseSpawn(spawnLine({ ...pending, thread: 'T-1' })), { ...pending, thread: 'T-1' });
  assert.equal(parseSpawn('odd-spawn role=shipper-x round=1 key=x thread=pending'), undefined, 'unknown role');
  assert.equal(parseSpawn('odd-spawn role=builder round=1 key=builder thread=none'), undefined, 'neither pending nor a thread');
  const builder = { role: 'builder' as const, round: 1, key: 'builder' };
  const lines = (...records: object[]) => records.map(record => ({ body: spawnLine(record as typeof builder) }));
  // Newest-first and oldest-first comment orders give the same records.
  assert.deepEqual(spawnRecords(lines({ ...builder, thread: 'T-b' }, builder)), [{ ...builder, thread: 'T-b' }]);
  assert.deepEqual(spawnRecords(lines(builder, { ...builder, thread: 'T-b' }, builder)), [{ ...builder, thread: 'T-b' }]);
  assert.deepEqual(spawnRecords(lines(builder, pending)), [builder, pending], 'one record per role, round and key');
  const snapshot = toSnapshot({ issue: { id: 'MET-1', status: 'Todo', labels: [], comments: lines(builder) } });
  assert.deepEqual(snapshot.spawns, [builder]);
  const issue = { pr: { number: 1, headSha: sha, ci: 'success' as const, merged: false }, deployReceipt: { host: 'h', component: 'c', sha: 'e'.repeat(40), health: 'pass' as const, rollback: 'none' } };
  assert.deepEqual(['builder', 'reviewer', 'verifier', 'spec'].map(role => spawnKey(issue, role as 'builder')), ['builder', `reviewer-${sha.slice(0, 12)}`, `verifier-${'e'.repeat(12)}`, 'spec']);
});

test('P4.1: a pending record reconciles only to an unowned live thread of its role and round still owed its artifact', () => {
  const thread = (id: string, labels: string[]): LiveThread => ({ id, labels: ['odd-issue-met-1', ...labels], state: 'running' });
  const reviewer = { role: 'reviewer' as const, round: 1, key: `reviewer-${sha.slice(0, 12)}` };
  assert.equal(reconciles(reviewer, thread('T-r', ['odd-role-reviewer', 'odd-round-1']), new Set()), true);
  assert.equal(reconciles(reviewer, thread('T-r', ['odd-role-reviewer', 'odd-round-1']), new Set(['T-r'])), false, 'owned by another record');
  assert.equal(reconciles(reviewer, thread('T-r', ['odd-role-reviewer', 'odd-round-2']), new Set()), false, 'another round');
  assert.equal(reconciles(reviewer, thread('T-r', ['odd-role-builder', 'odd-round-1']), new Set()), false, 'another role');
  assert.equal(reconciles(reviewer, thread('T-r', ['odd-role-reviewer', 'odd-round-1', `odd-verdict-changes-${'0'.repeat(12)}`]), new Set()), false, 'an older head\'s delivered reviewer');
  const verifier = { role: 'verifier' as const, round: 1, key: `verifier-${'e'.repeat(12)}` };
  assert.equal(reconciles(verifier, thread('T-v', ['odd-role-verifier', 'odd-round-1', receiptLabel('e'.repeat(40))]), new Set()), true);
  assert.equal(reconciles(verifier, thread('T-v', ['odd-role-verifier', 'odd-round-1', receiptLabel('d'.repeat(40))]), new Set()), false, 'another release');
});

test('P4.1: admitted load counts every reservation thread search has not returned, once, by executor and build issue', () => {
  const live = (id: string, role: string, issue: string, state = 'running'): LiveThread => ({ id, labels: [`odd-issue-${issue}`, `odd-role-${role}`, 'odd-round-1'], state });
  const threads = [live('T-b1', 'builder', 'met-1', 'idle'), live('T-r1', 'reviewer', 'met-1')];
  assert.deepEqual(admittedLoad(threads, []).load, { orbs: 1, runnerSlots: 0, buildIssues: 1 });
  const { load, building } = admittedLoad(threads, [
    { role: 'reviewer', issue: 'MET-1', thread: 'T-r1' }, // indexed: already counted
    { role: 'builder', issue: 'MET-2' }, // pending create
    { role: 'builder', issue: 'MET-1', thread: 'T-b2' }, // a second builder thread of a building issue
    { role: 'intake', thread: 'T-slack' },
    { role: 'deployer' },
  ]);
  assert.deepEqual(load, { orbs: 4, runnerSlots: 1, buildIssues: 2 });
  assert.deepEqual([...building].sort(), ['MET-1', 'MET-2']);
});

// --- MET-348: escalation latch and correction epochs from issue comments -----------------------

test('MET-348: epochs, budgets and the latch derive from comments; duplicates never extend, conflicts and forgeries grant nothing', () => {
  const contract = 'abcdefabcdef';
  const budget = (epoch: number, start: string) => `odd-budget epoch=${epoch} start=${start} deadline=${new Date(Date.parse(start) + 120 * 60_000).toISOString()} contract=${contract}`;
  const snap = (comments: { id?: string; body: string; createdAt?: string }[], labels: string[] = []) =>
    toSnapshot({ issue: { id: 'MET-1', status: 'In Progress', labels, comments: [...comments].reverse() } });
  const c = (id: string, body: string, createdAt: string) => ({ id, body, createdAt });
  const b1 = c('b1', budget(1, '2026-10-27T03:00:00.000Z'), '2026-10-27T03:00:01.000Z');
  // One budget, then a lost-response retry an hour later: the earliest start holds.
  const retried = snap([b1, c('b1b', budget(1, '2026-10-27T04:00:00.000Z'), '2026-10-27T04:00:00.500Z')]);
  assert.equal(retried.correction?.budget?.deadline, '2026-10-27T05:00:00.000Z');
  assert.equal(retried.correction?.invalid, undefined);
  // A start Linear did not witness (backdated or forward-dated by more than 5 min) grants nothing.
  assert.match(String(snap([c('bx', budget(1, '2026-10-27T03:00:00.000Z'), '2026-10-27T03:30:00.000Z')]).correction?.invalid), /is not its comment time/);
  // Two contracts in one epoch, a budget for another epoch, and a malformed line are all untrusted.
  assert.match(String(snap([b1, c('b2', budget(1, '2026-10-27T03:10:00.000Z').replace(contract, '123456123456'), '2026-10-27T03:10:00.000Z')]).correction?.invalid), /conflicting/);
  assert.match(String(snap([c('b3', budget(2, '2026-10-27T03:00:00.000Z'), '2026-10-27T03:00:00.000Z')]).correction?.invalid), /epoch 2 recorded in epoch 1/);
  assert.match(String(snap([c('b4', 'odd-budget epoch=1 forever', '2026-10-27T03:00:00.000Z')]).correction?.invalid), /malformed/);

  const latch = c('e1', `odd-escalated reason=budget-ceiling pr=9 sha=${'c'.repeat(40)} done=label,draft,page,archive\n\ndetail`, '2026-10-27T05:00:01.000Z');
  const held = snap([b1, latch], ['escalated']);
  assert.equal(held.escalation?.id, 'e1');
  assert.equal(held.correction?.epoch, 1, 'an escalation comment does not reset the budget');
  assert.equal(held.correction?.budget?.start, '2026-10-27T03:00:00.000Z');
  // An observed resume for the open latch starts epoch 2 once, with fresh cancellations and no budget.
  const cancel = c('x1', 'odd-watchdog cancelled role=builder thread=T-1 round=2', '2026-10-27T04:00:00.000Z');
  const resume = c('r1', 'odd-resume escalation=e1 epoch=2', '2026-10-27T06:00:00.000Z');
  const after = snap([b1, cancel, latch, resume]);
  assert.deepEqual(after.correction, { epoch: 2, corrected: false });
  assert.equal(after.escalation, undefined);
  assert.deepEqual(after.cancelledRounds, {});
  // A retried resume (duplicate record) does not grant a third epoch.
  assert.deepEqual(snap([b1, latch, resume, c('r2', 'odd-resume escalation=e1 epoch=2', '2026-10-27T06:00:05.000Z')]).correction, { epoch: 2, corrected: false });
  // A resume naming another latch, a latch whose label was never set, or a wrong epoch is untrusted and releases nothing.
  for (const forged of ['odd-resume escalation=e9 epoch=2', 'odd-resume escalation=e1 epoch=7']) {
    const bad = snap([b1, latch, c('rf', forged, '2026-10-27T06:00:00.000Z')]);
    assert.equal(bad.correction?.epoch, 1);
    assert.equal(bad.escalation?.id, 'e1');
    assert.match(String(bad.correction?.invalid), /does not release/);
  }
  const unlabelled = c('e2', `odd-escalated reason=budget-ceiling pr=9 sha=- done=-\n\nd`, '2026-10-27T05:00:01.000Z');
  assert.equal(snap([b1, unlabelled, c('r3', 'odd-resume escalation=e2 epoch=2', '2026-10-27T06:00:00.000Z')]).correction?.epoch, 1);

  // Legacy: an old escalation comment starts a new epoch (prior semantics) only before any new-style record.
  const legacy = c('l1', 'odd-escalated reason=third-failed-qa-round\n\nMET-1: PR #9 rejected 3 times', '2026-10-26T01:00:00.000Z');
  assert.equal(snap([legacy]).correction?.epoch, 2);
  const late = snap([b1, c('l2', 'odd-escalated reason=third-failed-qa-round', '2026-10-27T04:00:00.000Z')]);
  assert.equal(late.correction?.epoch, 1);
  assert.match(String(late.correction?.invalid), /legacy odd-escalated/);
  // A legacy history that was steered without a budget is `corrected`: it keeps the round cap.
  assert.equal(snap([c('s1', `odd-steer key=changes-${'a'.repeat(12)} thread=T-1`, '2026-10-26T02:00:00.000Z')]).correction?.corrected, true);
  assert.equal(snap([c('s2', `odd-steer key=ci-failed-${'a'.repeat(12)} thread=T-1`, '2026-10-26T02:00:00.000Z')]).correction?.corrected, false);
});

test('MET-348: a legacy steered history at its third rejected head still pages; a budgeted one is steered', () => {
  const changes = (n: number, head: string): LiveThread => ({ id: `T-r${n}`, labels: ['odd-issue-met-1', 'odd-role-reviewer', `odd-round-${n}`, `odd-verdict-changes-${head}`], state: 'idle' });
  const builder: LiveThread = { id: 'T-b', labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-1'], state: 'idle' };
  const pr: GitHubPullRequest = { number: 9, headRefOid: sha, state: 'OPEN', statusCheckRollup: [check('SUCCESS')] };
  const threads = [builder, changes(1, 'a'.repeat(12)), changes(2, 'b'.repeat(12)), changes(3, sha.slice(0, 12))];
  const steered = { body: `odd-steer key=changes-${'a'.repeat(12)} thread=T-b`, createdAt: '2026-10-27T03:00:00.000Z' };
  const legacy = toSnapshot({ issue: { id: 'MET-1', status: 'In Progress', labels: ['odd'], comments: [steered] }, pr, threads });
  assert.equal((nextAction(legacy, { orbs: 0, runnerSlots: 0, buildIssues: 1 }, Date.parse('2026-10-27T03:30:00Z')) as { reason?: string }).reason, 'third-failed-qa-round');
  const description = '## Goal\nx';
  const grant = `odd-budget epoch=1 start=2026-10-27T02:59:00.000Z deadline=2026-10-27T04:59:00.000Z contract=${contractOf(description, undefined)}`;
  const budgeted = toSnapshot({ issue: { id: 'MET-1', status: 'In Progress', labels: ['odd'], description, comments: [steered, { body: grant, createdAt: '2026-10-27T02:59:00.500Z' }] }, pr, threads });
  assert.equal(nextAction(budgeted, { orbs: 0, runnerSlots: 0, buildIssues: 1 }, Date.parse('2026-10-27T03:30:00Z')).kind, 'steer');
  assert.equal((nextAction(budgeted, { orbs: 0, runnerSlots: 0, buildIssues: 1 }, Date.parse('2026-10-27T04:59:00Z')) as { reason?: string }).reason, 'budget-ceiling');
});

test('P4.6-deployer-archive: a log reader is finished by its diagnosed label for its own release, in every status, never by the issue leaving Deploying', () => {
  const red = 'e'.repeat(40);
  const reader = (id: string, state: string, extra: string[]): LiveThread => ({ id, labels: ['odd-issue-met-9', 'odd-role-deployer', 'odd-round-1', readerLabel(red), ...extra], state });
  const threads: LiveThread[] = [
    reader('diagnosed-idle', 'idle', [diagnosedLabel(red)]),
    reader('diagnosed-running', 'tool-running', [diagnosedLabel(red)]),
    reader('diagnosed-error', 'error', [diagnosedLabel(red)]),
    reader('undiagnosed-idle', 'idle', []),
    // A diagnosed label for another release is not this reader's handoff.
    reader('other-release-idle', 'idle', [diagnosedLabel('f'.repeat(40))]),
  ];
  // A failed rollback leaves the issue in Deploying; a rolled-back one has moved to Todo while the reader may still run.
  for (const status of ['Deploying', 'Todo', 'In Progress', 'Done'] as const) {
    assert.deepEqual(finishedThreads(status, threads).map(t => t.id), ['diagnosed-idle'], status);
  }
  assert.equal(delivered(threads[0]), true);
  assert.equal(delivered(threads[3]), false);
  assert.equal(delivered(threads[4]), false);
  assert.deepEqual(openRounds(threads), { deployer: 1 }, 'an undiagnosed reader still holds its round');
  assert.deepEqual(openRounds([threads[0]]), {});
});

test('P4.3: the latest red receipt by creation time bounds which merges deliver the issue; ownership still decides', () => {
  const red = (sha: string, rollback = 'dddddddddddd') => `odd-deploy host=h component=c sha=${sha} health=fail rollback=${rollback}`;
  // Newest first, as list_comments returns them: the latest failure by createdAt wins, rolled back or not; pass and refused receipts never count.
  const comments = [
    { body: `odd-deploy host=h component=c sha=${'b'.repeat(40)} health=pass rollback=none`, createdAt: '2026-10-26T14:00:00.000Z' },
    { body: `odd-deploy host=h component=c sha=${'b'.repeat(40)} health=refused rollback=none refusal=db-changing-legacy`, createdAt: '2026-10-26T13:30:00.000Z' },
    { body: red('a'.repeat(40), 'none'), createdAt: '2026-10-26T12:00:00.000Z' },
    { body: red('9'.repeat(40)), createdAt: '2026-10-26T13:00:00.000Z' },
  ];
  assert.equal(failedReceiptAt(comments), '2026-10-26T13:00:00.000Z');
  assert.equal(failedReceiptAt(comments.slice(0, 2)), undefined, 'no failure, no bound');
  assert.throws(() => failedReceiptAt([{ body: red('9'.repeat(40)) }]), /cannot order merged PRs/);

  const at = '2026-10-26T13:00:00.000Z';
  const owned = { headRefName: 'met-41-x', body: '' };
  // GitHub reports the failure instant without milliseconds: equal, not later.
  assert.equal(prEligible({ ...owned, mergedAt: '2026-10-26T13:00:00Z' }, 'MET-41', at), false);
  assert.equal(prEligible({ ...owned, mergedAt: '2026-10-26T12:59:59Z' }, 'MET-41', at), false);
  assert.equal(prEligible({ ...owned, mergedAt: '2026-10-26T13:00:01Z' }, 'MET-41', at), true);
  assert.equal(prEligible({ ...owned, mergedAt: null }, 'MET-41', at), true, 'an open PR is never superseded');
  assert.equal(prEligible({ ...owned, mergedAt: '2026-10-26T11:00:00Z' }, 'MET-41', undefined), true, 'no failure: history counts as before');
  assert.equal(prEligible({ headRefName: 'met-279-x', body: 'contributes MET-279\n\nMET-41 was rolled back.', mergedAt: '2026-10-26T14:00:00Z' }, 'MET-41', at), false, 'a later mention does not own');

  // The snapshot applies the same bound to the PR it is given.
  const issue = { id: 'MET-41', status: 'In Progress', labels: ['odd'], comments };
  const pr = (mergedAt: string): GitHubPullRequest => ({ number: 41, headRefName: 'met-41-x', headRefOid: sha, state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) }, mergedAt, statusCheckRollup: [] });
  assert.equal(toSnapshot({ issue, pr: pr('2026-10-26T13:00:00Z') }).pr, undefined);
  assert.equal(toSnapshot({ issue, pr: pr('2026-10-26T13:00:01Z') }).pr?.merged, true);
  assert.equal(toSnapshot({ issue: { ...issue, comments: comments.slice(0, 2) }, pr: pr('2026-10-26T11:00:00Z') }).pr?.merged, true);
});

test('P3.10: every reported Amp state maps to idle, running, approval or error; any other state fails the snapshot instead of reading as running or idle', () => {
  for (const [state, known] of [['idle', 'idle'], ['external-agent', 'idle'], ['error', 'error'], ['awaiting-approval', 'awaiting-approval'], ['awaiting_approval', 'awaiting-approval'], ['running', 'running'], ['working', 'running'], ['streaming', 'running'], ['tool-running', 'running'], ['tool_use', 'running'], ['running_tools', 'running'], ['compacting', 'running']] as const) assert.equal(threadState(state), known, state);
  for (const state of ['', 'paused', 'Idle', 'Working', 'work', 'tool-use', 'constructor', 'toString', 'unknown']) assert.equal(threadState(state), undefined, state);
  const issue = { id: 'MET-1', status: 'In Progress', labels: [] };
  const builder: LiveThread = { id: 'T-b', labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-1'], state: 'streaming' };
  const odd: LiveThread = { id: 'T-r', labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-1'], state: 'paused' };
  // Even after a running owner is found, a later unknown state is judged.
  assert.throws(() => toSnapshot({ issue, threads: [builder, odd] }), /unknown thread state "paused"/);
  // MET-394: a `working` owner is running, dated by its agent activity, and holds its slot like any running thread.
  const working: LiveThread = { ...builder, state: 'working', updatedAt: '2026-10-26T12:00:00.000Z', activeAt: '2026-10-26T11:40:00.000Z' };
  assert.deepEqual(toSnapshot({ issue, threads: [working] }).owner, { role: 'builder', threadID: 'T-b', round: 1, state: 'running', idleSince: '2026-10-26T11:40:00.000Z' });
  assert.deepEqual(finishedThreads('Done', [working]), [], 'a working thread is never finished work to archive');
  const running = loadFrom([{ ...builder, state: 'running' }]);
  assert.deepEqual(loadFrom([working]), running);
  // An unknown thread fails only its own issue's snapshot: the shared load stays readable and keeps its slot, never freed as idle.
  assert.deepEqual(loadFrom([{ ...builder, state: 'paused' }]), running);
  assert.notDeepEqual(loadFrom([{ ...builder, state: 'idle' }]), running);
  assert.throws(() => finishedThreads('Done', [odd]), /unknown thread state/);
  // A thread without a role label is not ours to judge.
  assert.equal(toSnapshot({ issue, threads: [builder, { ...odd, labels: ['odd-issue-met-1'] }] }).owner?.threadID, 'T-b');
});

test('P3.10: an approval-blocked thread owns the issue beside an idle builder; a running owner is dated by its agent activity, not by thread search', () => {
  const issue = { id: 'MET-1', status: 'In Progress', labels: [] };
  const builder: LiveThread = { id: 'T-b', labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-1'], state: 'idle', updatedAt: '2026-10-26T09:00:00.000Z' };
  const reviewer: LiveThread = { id: 'T-r', labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-1'], state: 'awaiting-approval', updatedAt: '2026-10-26T10:00:00.000Z' };
  const pr: GitHubPullRequest = { number: 9, headRefOid: sha, state: 'OPEN', statusCheckRollup: [check('SUCCESS')] };
  const approval = toSnapshot({ issue, pr, threads: [builder, reviewer] });
  assert.deepEqual(approval.owner, { role: 'reviewer', threadID: 'T-r', round: 1, state: 'awaiting-approval', idleSince: '2026-10-26T10:00:00.000Z' });
  assert.deepEqual(nextAction(approval, { orbs: 0, runnerSlots: 0, buildIssues: 1 }), { kind: 'wait', reason: 'reviewer awaiting approval', wait: { kind: 'approval', key: 'approval-T-r', since: '2026-10-26T10:00:00.000Z' } });
  const running = { ...builder, state: 'tool-running', updatedAt: '2026-10-26T12:00:00.000Z', activeAt: '2026-10-26T11:40:00.000Z' };
  assert.equal(toSnapshot({ issue, threads: [running] }).owner?.idleSince, '2026-10-26T11:40:00.000Z');
  assert.equal(toSnapshot({ issue, threads: [{ ...running, activeAt: undefined }] }).owner?.idleSince, undefined, 'a search date is not agent activity');
  assert.equal(toSnapshot({ issue, threads: [builder] }).owner?.idleSince, '2026-10-26T09:00:00.000Z');
});

test('P4.4: the binding holds for its build round and rollback epoch only, latest by creation time in any comment order', () => {
  const at = (s: number) => new Date(Date.parse('2026-10-26T12:00:00Z') + s * 1000).toISOString();
  const red = `odd-deploy host=h component=c sha=${'9'.repeat(40)} health=fail rollback=dddddddddddd`;
  const binding = { pr: 7, branch: 'met-7-x', round: 1, rollback: 0 };
  assert.equal(prBindingLine(binding), 'odd-pr pr=7 branch=met-7-x round=1 rollback=0');
  assert.deepEqual(parsePrBinding(`${prBindingLine(binding)}\n\nwhy`), binding);
  assert.equal(parsePrBinding('odd-pr pr=7 branch=met-7-x round=1'), undefined, 'a partial line binds nothing');
  const comments = [
    { body: spawnLine({ role: 'builder', round: 1, key: 'builder', thread: 'T-b1' }), createdAt: at(1) },
    { body: prBindingLine(binding), createdAt: at(2) },
    { body: spawnLine({ role: 'reviewer', round: 3, key: `reviewer-${'a'.repeat(12)}` }), createdAt: at(3) },
  ];
  assert.deepEqual(buildEpoch(comments), { round: 1, rollback: 0 }, 'only builder spawns set the round');
  assert.deepEqual(currentBinding(comments), binding);
  assert.deepEqual(currentBinding([...comments].reverse()), binding, 'newest-first reads bind the same PR');
  // A closed bound PR is rebound later in the same epoch: the latest binding wins, in either order.
  const rebound = [...comments, { body: prBindingLine({ ...binding, pr: 70, branch: 'met-7-y' }), createdAt: at(4) }];
  assert.equal(currentBinding(rebound)?.pr, 70);
  assert.equal(currentBinding([...rebound].reverse())?.pr, 70);
  // A new builder round or a red receipt starts an epoch the old binding does not hold for.
  assert.equal(currentBinding([...comments, { body: spawnLine({ role: 'builder', round: 2, key: 'builder' }), createdAt: at(5) }]), undefined);
  const rolledBack = [...comments, { body: red, createdAt: at(5) }];
  assert.deepEqual(buildEpoch(rolledBack), { round: 1, rollback: 1 });
  assert.equal(currentBinding(rolledBack), undefined);
  assert.equal(currentBinding([...rolledBack, { body: prBindingLine({ ...binding, pr: 48, rollback: 1 }), createdAt: at(6) }])?.pr, 48);
});

test('P4.4: an unbound epoch binds its one eligible candidate; several throw in any order; a pre-rollback open PR and a closed bound PR never bind', () => {
  const row = (number: number, over: Partial<GitHubPullRequest> = {}) => ({ number, headRefName: `met-7-${number}`, body: '', mergedAt: null, createdAt: '2026-10-26T13:00:00Z', ...over });
  assert.equal(bindingCandidate([row(7)], 'MET-7', undefined)?.number, 7);
  assert.equal(bindingCandidate([], 'MET-7', undefined), undefined);
  for (const rows of [[row(7), row(70)], [row(70), row(7)]]) assert.throws(() => bindingCandidate(rows, 'MET-7', undefined), /MET-7 has 2 candidate PRs \(#7, #70\)/);
  assert.equal(bindingCandidate([row(7), row(70), { ...row(9), headRefName: 'met-9-x', body: 'see MET-7' }], 'MET-7', undefined, 7)?.number, 70, 'the closed bound PR and a mention are not candidates');
  const failed = '2026-10-26T12:00:02.000Z';
  assert.equal(bindingCandidate([row(47, { createdAt: '2026-10-26T12:00:02Z' })], 'MET-7', failed), undefined, 'opened at the red receipt: stale');
  assert.equal(bindingCandidate([row(47, { createdAt: '2026-10-26T11:30:00Z' }), row(48, { createdAt: '2026-10-26T12:00:03Z' })], 'MET-7', failed)?.number, 48);
  assert.equal(bindingCandidate([row(47, { createdAt: undefined })], 'MET-7', failed), undefined, 'no creation time never binds after a rollback');
  // A merge counts by its merge time (P4.3), whenever the PR was opened.
  assert.equal(bindingCandidate([row(45, { createdAt: '2026-10-26T10:00:00Z', mergedAt: '2026-10-26T12:00:03Z' })], 'MET-7', failed)?.number, 45);
  assert.equal(bindingCandidate([row(41, { createdAt: '2026-10-26T10:00:00Z', mergedAt: '2026-10-26T12:00:02Z' })], 'MET-7', failed), undefined);
});

test('P4.4: only a plane draft whose own escalation was resumed is released, once; a human draft never is', () => {
  const resume = (escalation: string) => ({ body: `odd-resume escalation=${escalation} epoch=2` });
  const cases: [string, { body: string }[], string | undefined][] = [
    ['no plane record (a human draft)', [resume('c-1')], undefined],
    ['plane draft not resumed', [{ body: draftedLine(7, 'c-1') }], undefined],
    ['resume of another escalation', [{ body: draftedLine(7, 'c-1') }, resume('c-9')], undefined],
    ['plane draft of another PR', [{ body: draftedLine(70, 'c-1') }, resume('c-1')], undefined],
    ['already released', [{ body: draftedLine(7, 'c-1') }, resume('c-1'), { body: undraftedLine(7, 'c-1') }], undefined],
    ['malformed resume', [{ body: draftedLine(7, 'c-1') }, { body: 'odd-resume escalation=c-1' }], undefined],
    ['plane draft resumed', [{ body: draftedLine(7, 'c-1') }, resume('c-1')], 'c-1'],
    ['a second escalation after the first was released', [{ body: draftedLine(7, 'c-1') }, resume('c-1'), { body: undraftedLine(7, 'c-1') }, { body: draftedLine(7, 'c-5') }, resume('c-5')], 'c-5'],
  ];
  for (const [name, comments, expected] of cases) {
    assert.equal(releasedDraft(comments, 7), expected, name);
    assert.equal(releasedDraft([...comments].reverse(), 7), expected, `${name}, reordered`);
  }
});

test('MET-339: an activated identity is exact: two immutable user IDs and an instant; anything else fails closed, absent is not activated', () => {
  const plane = '3017c6e0-5bc4-4cf6-9a39-1a8d5ca74fc0';
  const deployer = '9b96bc7d-30b6-433f-8dab-5c62b82ee92a';
  const since = '2026-11-01T00:00:00.000Z';
  assert.equal(parseIdentity(undefined), undefined);
  assert.equal(parseIdentity('  \n'), undefined);
  assert.deepEqual(parseIdentity(` plane=${plane} deployer=${deployer} since=${since}\n`), { plane, deployer, since });
  for (const text of [
    `plane=${plane} deployer=${deployer}`, // no activation instant
    `plane=${plane} since=${since}`, // unconfigured deployer
    `deployer=${deployer} plane=${plane} since=${since}`, // reordered
    `plane=Devon Garbalosa deployer=${deployer} since=${since}`, // a display name is never identity
    `plane=${plane.toUpperCase()} deployer=${deployer} since=${since}`,
    `plane=${plane} deployer=${deployer} since=2026-11-01`,
    `plane=${plane} deployer=${deployer} since=2026-13-45T00:00:00.000Z`,
    `plane=${plane} deployer=${deployer} since=${since} slack=bot`,
    `plane=${plane} deployer=${plane} since=${since}`, // one principal for both cannot separate them
  ]) assert.throws(() => parseIdentity(text), /ODD identity configuration/, text);
});

test('MET-339: with the identity active, the snapshot ignores forged, human-authored and unauthored markers, whatever their display names, and accepts the configured principals', () => {
  const identity = { plane: '00000000-0000-4000-8000-0000000000aa', deployer: '00000000-0000-4000-8000-0000000000bb', since: '2026-10-26T12:00:00.000Z' };
  const role = '00000000-0000-4000-8000-0000000000cc'; // the Amp app a role comments as
  const human = '00000000-0000-4000-8000-0000000000dd';
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const receipt = (at: string, health = 'pass') => `odd-deploy host=factory-gpu component=kiosk sha=${at} health=${health} rollback=none`;
  let n = 0;
  const by = (id: string | undefined, name: string, body: string) => ({ id: `c${++n}`, body, createdAt: new Date(Date.parse('2026-10-26T11:59:00.000Z') + n * 20_000).toISOString(), ...(id ? { author: { id, name } } : {}) });
  const comments = [
    by(identity.plane, 'Devon Garbalosa', receipt(B)), // before `since`: the host deployer used the plane's key
    by(identity.plane, 'ODD Deployer', spawnLine({ role: 'builder', round: 1, key: 'builder', thread: 'T-builder' })), // a misleading name, the right ID
    by(identity.deployer, 'Devon Garbalosa', receipt(A)),
    by(role, 'Devon Garbalosa', `odd-verify sha=${A} result=fail bug=MET-9`),
    by(human, 'Devon Garbalosa', 'odd-watchdog cancelled role=builder thread=T-builder round=1'),
    by(role, 'ODD Control', 'odd-escalated reason=budget-ceiling pr=1 sha=- done=label'),
    by(undefined, 'Devon Garbalosa', spawnLine({ role: 'verifier', round: 1, key: `verifier-${A.slice(0, 12)}`, thread: 'T-forged' })),
    by(identity.deployer, 'ODD Deployer', `${receipt(A)}\nodd-verify sha=${A} result=pass bug=none`), // the deployer may write receipts only
    by(identity.plane, 'Devon Garbalosa', receipt(B, 'fail')), // after `since`: a plane receipt no longer counts
    by(human, 'Devon Garbalosa', `odd-merge pr=1 head=${A} merge=${A} release=none`), // would reset the receipt
  ];
  const snapshot = (activated: typeof identity | undefined) => toSnapshot({ issue: { id: 'MET-1', status: 'Deploying', labels: ['odd'], comments: trustedComments(comments, activated) } });
  const enforced = snapshot(identity);
  assert.deepEqual(enforced.deployReceipt, { host: 'factory-gpu', component: 'kiosk', sha: A, health: 'pass', rollback: 'none' });
  assert.equal(enforced.verify, undefined);
  assert.deepEqual(enforced.cancelledRounds, {});
  assert.equal(enforced.escalation, undefined);
  assert.deepEqual(enforced.spawns, [{ role: 'builder', round: 1, key: 'builder', thread: 'T-builder' }]);
  assert.deepEqual(enforced.correction, { epoch: 1, corrected: false });
  // The legacy plane receipt before activation is accepted on its own; the same line after it is not.
  assert.equal(toSnapshot({ issue: { id: 'MET-1', status: 'Deploying', labels: ['odd'], comments: trustedComments(comments.slice(0, 1), identity) } }).deployReceipt?.sha, B);
  assert.equal(trustedComments(comments.slice(8, 9), identity)[0].body, '');

  // Control: before activation every author counts, as before MET-339, and the forgeries take effect.
  const open = snapshot(undefined);
  assert.equal(open.deployReceipt, undefined, 'the forged odd-merge reset the receipt');
  assert.deepEqual(open.cancelledRounds, { builder: 1 });
  assert.equal(open.escalation?.reason, 'budget-ceiling');
  assert.equal(open.spawns.length, 2);
});

test('MET-339: the author filter splits lines exactly where the marker parsers do, so CR, CRLF, U+2028 and U+2029 hide no marker in either direction', () => {
  const identity = { plane: '00000000-0000-4000-8000-0000000000aa', deployer: '00000000-0000-4000-8000-0000000000bb', since: '2026-10-26T00:00:00.000Z' };
  const sha = 'a'.repeat(40);
  const receipt = `odd-deploy host=factory-gpu component=kiosk sha=${sha} health=pass rollback=none`;
  const verify = `odd-verify sha=${sha} result=pass bug=none`;
  const idle = { orbs: 0, runnerSlots: 0, buildIssues: 0 };
  const derive = (comments: { author: { id: string }; createdAt: string; body: string }[]) =>
    toSnapshot({ issue: { id: 'MET-1', status: 'Deploying', labels: ['odd'], comments: trustedComments(comments, identity) } });
  for (const separator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const name = JSON.stringify(separator);
    // A deployer comment smuggling the plane's verification after its receipt: the receipt counts, the verification does not.
    const smuggled = derive([{ author: { id: identity.deployer }, createdAt: '2026-10-27T00:00:00.000Z', body: `${receipt}${separator}${verify}` }]);
    assert.equal(smuggled.deployReceipt?.sha, sha, name);
    assert.equal(smuggled.verify, undefined, name);
    assert.equal(nextAction(smuggled, idle).kind, 'spawn', `${name}: the receipt still needs its verifier, never Done`);
    // A post-activation plane comment smuggling a receipt after other text: no receipt counts.
    const planeReceipt = derive([{ author: { id: identity.plane }, createdAt: '2026-10-27T00:00:00.000Z', body: `diagnosis${separator}${receipt}` }]);
    assert.equal(planeReceipt.deployReceipt, undefined, name);
  }
});
