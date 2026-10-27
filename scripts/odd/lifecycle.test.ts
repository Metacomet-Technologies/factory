import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { budgetLine, contractOf, correctionWindowMs, parseBudget, parseEscalation, escalationLine, reassessment, nextAction, specComplete, ralphGuard, parseDeployReceipt, deployReceiptLine, parseVerify, parseCancelled, pageText, verifyLine, cancelledLine, threadLabels, parseThreadLabels, capacity, issueTriaged, controlPlaneSilent, heartbeatLine, parseHeartbeat, silenceMs, waitAge, waitBudgets, parseSteer, steerLine, type Action, type Budget, type IssueSnapshot, type PageReason, type Wait } from './lifecycle.ts';

const spec = `## Goal
Ship it.

## Isolation
docs/odd/

## Build
- write the doc

## Done means
- doc merged
- test green

## Evidence
- gh pr view --json mergedAt
- node --test scripts/odd exits 0`;

const idle = { orbs: 0, runnerSlots: 0, buildIssues: 0 };
const sha = 'c'.repeat(40);
const issue = (over: Partial<IssueSnapshot>): IssueSnapshot =>
  ({ identifier: 'MET-1', status: 'Todo', labels: [], description: spec, openBlockers: [], ...over });

test('spec is complete only when every Done-means item has an Evidence line', () => {
  assert.equal(specComplete(spec), true);
  assert.equal(specComplete(spec.replace('- node --test scripts/odd exits 0', '')), false);
  assert.equal(specComplete(spec.replace('## Evidence', '## Proof')), false);
  assert.equal(specComplete(spec.replace(/## Done means\n[\s\S]*?\n\n/, '## Done means\n\n')), false);
});

test('status drives the role; capacity gates orb spawns but not deterministic stages', () => {
  // Backlog is on demand: nothing runs until Devon moves the idea to Triage.
  assert.deepEqual(nextAction(issue({ status: 'Backlog' }), idle), { kind: 'wait', reason: 'backlog: triage on demand' });
  const triaged = ['Bug', 'area:kiosk'];
  assert.deepEqual(nextAction(issue({ status: 'Triage', description: 'one line' }), idle), { kind: 'spawn', role: 'intake', executor: 'orb', reason: 'exactly one of Bug, Feature, Improvement; an area:* label', round: 1 });
  assert.deepEqual(nextAction(issue({ status: 'Triage', description: 'one line', labels: triaged }), idle), { kind: 'spawn', role: 'spec', executor: 'orb', reason: 'spec incomplete', round: 1 });
  assert.deepEqual(nextAction(issue({ status: 'Triage', labels: triaged }), idle), { kind: 'set-status', status: 'Todo', reason: 'spec complete' });
  assert.equal(nextAction(issue({ status: 'Triage', description: 'x', labels: triaged, risk: 'security' }), idle).kind, 'wait');
  assert.deepEqual(nextAction(issue({}), idle), { kind: 'spawn', role: 'builder', executor: 'orb', reason: 'ready to build', round: 1 });
  assert.equal(nextAction(issue({}), { orbs: capacity.orbs, runnerSlots: 0, buildIssues: 0 }).kind, 'wait');
  assert.deepEqual(nextAction(issue({}), { ...idle, buildIssues: capacity.buildIssues }), { kind: 'wait', reason: 'build capacity (2/2 issues)' });
  const claimed = { role: 'builder' as const, threadID: 'T-1', round: 1, state: 'idle' as const };
  assert.deepEqual(nextAction(issue({ owner: claimed }), { ...idle, buildIssues: capacity.buildIssues }), { kind: 'set-status', status: 'In Progress', reason: 'builder T-1 owns it' });
  assert.equal(nextAction(issue({ openBlockers: ['MET-0'] }), idle).kind, 'wait');
  const ready = issue({ status: 'In Progress', pr: { number: 9, headSha: sha, ci: 'success', merged: false, verdict: { state: 'ready', sha } } });
  assert.deepEqual(nextAction(ready, { orbs: capacity.orbs, runnerSlots: capacity.runnerSlots, buildIssues: capacity.buildIssues }), { kind: 'merge', pr: 9, sha });
});

test('a role that ended without reaching its stop condition is not respawned past its rounds', () => {
  const intake = { role: 'intake' as const, threadID: 'T-1', round: 1, state: 'idle' as const };
  assert.deepEqual(nextAction(issue({ status: 'Triage', owner: intake, openRounds: { intake: 1 } }), idle), { kind: 'wait', reason: 'intake round budget spent (1/1)', stuck: 'intake' });
  assert.equal(nextAction(issue({ status: 'Triage', description: 'x', labels: ['Bug', 'area:kiosk'], owner: intake, openRounds: { intake: 1 } }), idle).kind, 'spawn');
  const spec = { ...intake, role: 'spec' as const };
  assert.equal(nextAction(issue({ status: 'Triage', description: 'x', labels: ['Bug', 'area:kiosk'], owner: spec, openRounds: { spec: 1 } }), idle).kind, 'wait');
  const builder = { ...intake, role: 'builder' as const, state: 'error' as const };
  assert.deepEqual(nextAction(issue({ status: 'In Progress', owner: builder, openRounds: { builder: 1 } }), idle), { kind: 'spawn', role: 'builder', executor: 'orb', reason: 'builder round 2', round: 2 });
});

test('intake stop condition names what is missing', () => {
  assert.deepEqual(issueTriaged({ status: 'Triage', labels: ['Bug', 'area:kiosk'] }), []);
  assert.deepEqual(issueTriaged({ status: 'Backlog', labels: ['Bug', 'Feature', 'engine/amp'] }),
    ['status is Backlog, not Triage', 'exactly one of Bug, Feature, Improvement', 'an area:* label']);
});

test('a verdict counts only for the exact head SHA', () => {
  const stale = issue({ status: 'In Progress', pr: { number: 9, headSha: sha, ci: 'success', merged: false, verdict: { state: 'ready', sha: 'd'.repeat(40) } } });
  assert.equal(nextAction(stale, idle).kind, 'spawn');
  assert.equal((nextAction(stale, idle) as { role: string }).role, 'reviewer');
});

test('changes steer the live builder; the third rejected head pages instead of looping; escalated waits', () => {
  const pr = { number: 9, headSha: sha, ci: 'success' as const, merged: false, verdict: { state: 'changes' as const, sha }, changesRounds: 2 };
  const owner = { role: 'builder' as const, threadID: 'T-1', round: 1, state: 'idle' as const };
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr, owner }), idle),
    { kind: 'steer', role: 'builder', threadID: 'T-1', key: `changes-${sha.slice(0, 12)}`, message: `QA requested changes at ${sha}; see the odd-verdict comment on PR #9. Address every finding, rerun the Evidence commands, push to the same branch. ${reassessment}` });
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: { ...pr, changesRounds: 3 }, owner }), idle),
    { kind: 'page', reason: 'third-failed-qa-round', detail: 'MET-1: PR #9 rejected 3 times', pr: 9, sha });
  assert.equal(nextAction(issue({ status: 'In Progress', pr, owner: { ...owner, state: 'running' } }), idle).kind, 'wait');
  assert.deepEqual(nextAction(issue({ status: 'In Progress', labels: ['escalated'], pr, owner }), idle), { kind: 'wait', reason: 'escalated to Devon' });
  // No live builder thread: the next round spawns one; the builder rounds are counted on the PR, not the thread.
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr }), idle), { kind: 'spawn', role: 'builder', executor: 'orb', reason: 'qa changes, round 3; design reassessment required', round: 1 });
});

test('deploy receipts: no receipt waits, healthy is Done, rolled back returns to Todo with a Bug, unhealthy without rollback pages; red ones ask for a log reader', () => {
  assert.deepEqual(nextAction(issue({ status: 'Deploying' }), idle), { kind: 'wait', reason: 'release not published', wait: { kind: 'receipt', key: 'receipt-unknown' } });
  const receipt = parseDeployReceipt('note\nodd-deploy host=factory-gpu component=meter+kiosk sha=abcdef1234 health=pass rollback=none\n');
  assert.deepEqual(receipt, { host: 'factory-gpu', component: 'meter+kiosk', sha: 'abcdef1234', health: 'pass', rollback: 'none' });
  assert.deepEqual(nextAction(issue({ status: 'Deploying', deployReceipt: receipt }), idle), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify meter+kiosk at abcdef1234', round: 1 });
  const none = parseDeployReceipt('odd-deploy host=factory-gpu component=none sha=abcdef1234 health=pass rollback=none');
  assert.equal(nextAction(issue({ status: 'Deploying', deployReceipt: none }), idle).kind, 'spawn');
  const red = { ...receipt!, component: 'kiosk', health: 'fail' as const, rollback: '/var/backups/factory-kiosk/20261024T120000.abc' };
  const rolledBack = nextAction(issue({ status: 'Deploying', deployReceipt: red }), idle);
  assert.equal(rolledBack.kind, 'set-status');
  assert.deepEqual((rolledBack as { diagnose?: object }).diagnose, red);
  assert.equal((rolledBack as { status: string }).status, 'Todo');
  const followUp = (rolledBack as { followUp?: { title: string; body: string } }).followUp;
  assert.equal(followUp?.title, 'Deploy failed: kiosk at abcdef1234');
  assert.match(followUp?.body ?? '', /^odd-deploy host=factory-gpu component=kiosk sha=abcdef1234 health=fail rollback=\/var\/backups\/factory-kiosk\/20261024T120000\.abc$/m);
  const unrecovered = { ...receipt!, component: 'kiosk', health: 'fail' as const };
  assert.deepEqual(nextAction(issue({ status: 'Deploying', deployReceipt: unrecovered }), idle), {
    kind: 'page', reason: 'failed-rollback', diagnose: unrecovered,
    detail: 'kiosk on factory-gpu unhealthy at abcdef1234: odd-deploy host=factory-gpu component=kiosk sha=abcdef1234 health=fail rollback=none',
  });
  assert.equal(parseDeployReceipt('odd-deploy host=x component=y sha=zz health=pass rollback=none'), undefined);
});

test('a refused deploy receipt is its own type: it pages irreversible-action, never reads as pass, unchanged or a failed rollback, and malformed refusals do not parse', () => {
  const refused = 'odd-deploy host=factory-gpu component=meter sha=abcdef1234 health=refused rollback=none refusal=db-changing-v1';
  const receipt = parseDeployReceipt(`note\n${refused}\n`);
  assert.deepEqual(receipt, { host: 'factory-gpu', component: 'meter', sha: 'abcdef1234', health: 'refused', rollback: 'none', refusal: 'db-changing-v1' });
  assert.equal(deployReceiptLine(receipt!), refused);
  const action = nextAction(issue({ status: 'Deploying', deployReceipt: receipt }), idle);
  assert.deepEqual(action, { kind: 'page', reason: 'irreversible-action', sha: 'abcdef1234',
    detail: `meter on factory-gpu not installed at abcdef1234 (db-changing-v1): automatic deploys never change the meter DB generation; migration stays Devon's explicit manual operation. ${refused}` });
  assert.match(pageText('MET-1', action as Extract<Action, { kind: 'page' }>), /^ODD page: irreversible-action \| issue MET-1 \| - \| abcdef1234 \| default if silent: not executed\./);
  const snapshot = refused.replace('db-changing-v1', 'db-changing-snapshot');
  assert.equal(parseDeployReceipt(snapshot)?.refusal, 'db-changing-snapshot');
  assert.equal((nextAction(issue({ status: 'Deploying', deployReceipt: parseDeployReceipt(snapshot) }), idle) as { reason?: string }).reason, 'irreversible-action');
  // Legacy receipts parse exactly as before and carry no refusal.
  const legacy = 'odd-deploy host=factory-gpu component=meter sha=abcdef1234 health=fail rollback=none';
  assert.deepEqual(parseDeployReceipt(legacy), { host: 'factory-gpu', component: 'meter', sha: 'abcdef1234', health: 'fail', rollback: 'none' });
  assert.equal(deployReceiptLine(parseDeployReceipt(legacy)!), legacy);
  for (const malformed of [
    refused.replace(' refusal=db-changing-v1', ''),
    refused.replace('db-changing-v1', 'db-changing-v2'),
    refused.replace('rollback=none', 'rollback=/var/backups/meter/snap'),
    refused.replace('health=refused', 'health=pass'),
    refused.replace('health=refused', 'health=fail'),
    `${refused} extra=1`,
  ]) assert.equal(parseDeployReceipt(malformed), undefined, malformed);
});

test('ralph guard stops on the external condition or the budget, never on the agent claim', () => {
  assert.deepEqual(ralphGuard({ role: 'builder', chained: 0, stopMet: true, missing: [] }), { action: 'stop', why: 'stop-met' });
  assert.deepEqual(ralphGuard({ role: 'reviewer', chained: 2, stopMet: false, missing: [] }), { action: 'stop', why: 'budget' });
  const go = ralphGuard({ role: 'builder', chained: 1, stopMet: false, missing: ['CI job kiosk failed'] });
  assert.equal(go.action, 'continue');
  assert.match((go as { userMessage: string }).userMessage, /CI job kiosk failed/);
  assert.equal((go as { maxContinuations: number }).maxContinuations, 8);
});

test('thread labels round-trip and obey Amp label syntax', () => {
  const labels = threadLabels('MET-276', 'builder', 2);
  assert.deepEqual(labels, ['odd-issue-met-276', 'odd-role-builder', 'odd-round-2']);
  for (const label of labels) assert.match(label, /^[a-z0-9][a-z0-9-]{0,31}$/);
  assert.deepEqual(parseThreadLabels([...labels, 'other']), { issue: 'MET-276', role: 'builder', round: 2 });
  assert.deepEqual(parseThreadLabels(['odd-role-nope']), { issue: undefined, role: undefined, round: 1 });
});

test('a green receipt spawns the Verifier; its pass comment sets Done, its fail comment waits on the Bug; the next release is verified again', () => {
  const receipt = parseDeployReceipt('odd-deploy host=factory-gpu component=kiosk sha=abcdef1234 health=pass rollback=none');
  const deploying = (verify?: IssueSnapshot['verify']) => nextAction(issue({ status: 'Deploying', deployReceipt: receipt, verify }), idle);
  assert.deepEqual(deploying(), { kind: 'spawn', role: 'verifier', executor: 'orb', reason: 'verify kiosk at abcdef1234', round: 1 });
  assert.deepEqual(deploying(parseVerify('odd-verify sha=abcdef1234 result=pass bug=none')), { kind: 'set-status', status: 'Done', reason: 'verified kiosk at abcdef1234' });
  assert.deepEqual(deploying(parseVerify('odd-verify sha=abcdef1234 result=fail bug=met-9\n- pass kiosk shows the scene\n- fail chip pulses')),
    { kind: 'wait', reason: 'verification failed at abcdef1234; bug MET-9', wait: { kind: 'verification', key: 'verification-abcdef1234' } });
  // A verdict for an older release does not count for this receipt.
  assert.equal(deploying({ sha: '0123456789', result: 'pass' }).kind, 'spawn');
  assert.equal(parseVerify('odd-verify sha=abcdef1234 result=maybe bug=none'), undefined);
  assert.equal(verifyLine({ sha: 'abcdef1234', result: 'fail', bug: 'MET-9' }), 'odd-verify sha=abcdef1234 result=fail bug=MET-9');
  assert.deepEqual(parseCancelled(cancelledLine('builder', 'T-1', 2)), { role: 'builder', threadID: 'T-1', round: 2 });
});

test('a spent round budget waits on the live thread (the Watchdog cancels it), and pages budget-ceiling once no thread is live', () => {
  const spent = { role: 'builder' as const, threadID: 'T-1', round: 3, state: 'idle' as const };
  assert.deepEqual(nextAction(issue({ status: 'In Progress', owner: spent, openRounds: { builder: 3 } }), idle), { kind: 'wait', reason: 'builder has not opened a PR', stuck: 'builder' });
  assert.deepEqual(nextAction(issue({ status: 'Todo', cancelledRounds: { builder: 2 } }), idle), { kind: 'spawn', role: 'builder', executor: 'orb', reason: 'ready to build', round: 3 });
  assert.deepEqual(nextAction(issue({ status: 'Todo', cancelledRounds: { builder: 3 } }), idle),
    { kind: 'page', reason: 'budget-ceiling', detail: 'MET-1: builder spent 3/3 rounds (ready to build)', pr: undefined, sha: undefined });
  const reviewer = { role: 'reviewer' as const, threadID: 'T-r', round: 2, state: 'idle' as const };
  const pr = { number: 9, headSha: sha, ci: 'success' as const, merged: false };
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr, owner: reviewer, openRounds: { reviewer: 2 } }), idle), { kind: 'wait', reason: 'reviewer round budget spent (2/2)', stuck: 'reviewer' });
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr, cancelledRounds: { reviewer: 2 } }), idle),
    { kind: 'page', reason: 'budget-ceiling', detail: `MET-1: reviewer spent 2/2 rounds (no verdict at ${sha.slice(0, 12)})`, pr: 9, sha });
});

test('every page uses the one format with the condition, issue, place, SHA and the default if Devon stays silent', () => {
  const receipt = parseDeployReceipt('odd-deploy host=factory-gpu component=kiosk sha=abcdef1234 health=fail rollback=none')!;
  const pages: Extract<Action, { kind: 'page' }>[] = [
    { kind: 'page', reason: 'third-failed-qa-round', detail: 'MET-1: PR #9 rejected 3 times', pr: 9, sha },
    { kind: 'page', reason: 'failed-rollback', detail: 'kiosk unhealthy', diagnose: receipt },
    { kind: 'page', reason: 'irreversible-action', detail: 'wipe the meter db' },
    { kind: 'page', reason: 'security-finding', detail: 'token in the diff' },
    { kind: 'page', reason: 'budget-ceiling', detail: 'MET-1: builder spent 2/2 rounds' },
    { kind: 'page', reason: 'control-plane-blind', detail: 'every sweep failed' },
    { kind: 'page', reason: 'control-plane-silent', detail: 'heartbeat missing; the poller runs the lifecycle' },
  ];
  const reasons = new Set<PageReason>(pages.map(page => page.reason));
  assert.equal(reasons.size, 7);
  for (const page of pages) assert.match(pageText(page.reason === 'control-plane-silent' ? '-' : 'MET-1', page), /^ODD page: [a-z-]+ \| issue (?:MET-\d+|-) \| .+ \| .+ \| default if silent: .+$/);
  assert.equal(pageText('MET-1', pages[0]), `ODD page: third-failed-qa-round | issue MET-1 | PR #9 | ${sha} | default if silent: issue stays In Progress and the PR stays a draft until the \`escalated\` label is removed. MET-1: PR #9 rejected 3 times`);
  assert.match(pageText('MET-1', pages[1]), /\| host factory-gpu \| abcdef1234 \|/);
  assert.match(pageText('MET-1', pages[2]), /\| - \| - \| default if silent: not executed\./);
});

test('a failed-rollback page promises neither a pause nor a restored release, and says the next release retries', () => {
  const receipt = parseDeployReceipt('odd-deploy host=factory-gpu component=kiosk sha=abcdef1234 health=fail rollback=none')!;
  const safe = 'recovery is not confirmed: the component may stay degraded on the failed release or in an unknown state and needs attention; nothing pauses, and the next release retries it';
  const page = pageText('MET-1', { kind: 'page', reason: 'failed-rollback', detail: 'kiosk unhealthy', diagnose: receipt });
  assert.equal(page, `ODD page: failed-rollback | issue MET-1 | host factory-gpu | abcdef1234 | default if silent: ${safe}. kiosk unhealthy`);
  assert.doesNotMatch(page, /previous release|restored|deploys .*pause/i);
  const readme = readFileSync(new URL('../../docs/odd/README.md', import.meta.url), 'utf8');
  const row = readme.split('\n').find(l => l.startsWith('| Health red after rollback |'));
  assert.equal(row, `| Health red after rollback | Deployer | Slack DM | ${safe[0].toUpperCase()}${safe.slice(1)}. |`);
});

test('a heartbeat is silent at 20 minutes and not one millisecond before', () => {
  const at = '2026-10-24T15:00:00.000Z';
  const now = Date.parse(at);
  assert.equal(parseHeartbeat(heartbeatLine(at)), at);
  assert.equal(parseHeartbeat('odd-heartbeat at=2026-10-24'), undefined);
  assert.equal(parseHeartbeat('notes\nodd-heartbeat at=not-a-time'), undefined);
  assert.equal(controlPlaneSilent([], now), true);
  assert.equal(controlPlaneSilent(['handoff notes'], now), true);
  assert.equal(controlPlaneSilent([heartbeatLine(at)], now + silenceMs - 1), false);
  assert.equal(controlPlaneSilent([heartbeatLine(at)], now + silenceMs), true);
  // The newest line wins, so an older stale row does not silence a fresh one.
  assert.equal(controlPlaneSilent([heartbeatLine(new Date(now - silenceMs).toISOString()), heartbeatLine(at)], now), false);
});

test('P3.1: every machine wait has a budget that is overdue at the boundary, not one millisecond before; human waits and undated waits are never overdue', () => {
  const at = Date.parse('2026-10-26T12:00:00.000Z');
  const since = new Date(at).toISOString();
  const budgets = { ci: 60, receipt: 120, steer: 30, approval: 30 } as const;
  for (const [kind, minutes] of Object.entries(budgets) as [keyof typeof budgets, number][]) {
    const ms = minutes * 60_000;
    assert.deepEqual(waitBudgets[kind], { notify: 'page', ms }, kind);
    const wait: Wait = { kind, key: `${kind}-x`, since };
    assert.deepEqual(waitAge(wait, at + ms - 1), { state: 'within', ageMs: ms - 1 }, `${kind} below`);
    assert.deepEqual(waitAge(wait, at + ms), { state: 'over', ageMs: ms }, `${kind} at`);
    assert.deepEqual(waitAge(wait, at + ms + 1), { state: 'over', ageMs: ms + 1 }, `${kind} above`);
    assert.deepEqual(waitAge({ kind, key: `${kind}-x` }, at + 10 * ms), { state: 'unknown' }, `${kind} without a durable start is unknown, not zero`);
  }
  for (const kind of ['risk', 'verification'] as const) assert.deepEqual(waitAge({ kind, key: kind, since }, at + 365 * 24 * 60 * 60_000), { state: 'human' });
});

test('P3.1: waits carry their durable start and an episode key bound to the head, merge or thread behind them', () => {
  const headAt = '2026-10-26T10:00:00.000Z';
  const pending = { number: 9, headSha: sha, ci: 'pending' as const, merged: false, headAt };
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: pending }), idle), { kind: 'wait', reason: `ci pending at ${sha.slice(0, 12)}`, wait: { kind: 'ci', key: `ci-${sha.slice(0, 12)}`, since: headAt } });
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: { ...pending, headAt: undefined } }), idle), { kind: 'wait', reason: `ci pending at ${sha.slice(0, 12)}`, wait: { kind: 'ci', key: `ci-${sha.slice(0, 12)}` } });
  const merged = { ...pending, ci: 'success' as const, merged: true, mergeSha: 'e'.repeat(40), mergedAt: '2026-10-26T11:00:00.000Z' };
  assert.deepEqual(nextAction(issue({ status: 'Deploying', pr: merged }), idle), { kind: 'wait', reason: 'release not published', wait: { kind: 'receipt', key: `receipt-${'e'.repeat(12)}`, since: merged.mergedAt } });
  const approval = { role: 'reviewer' as const, threadID: 'T-r', round: 1, state: 'awaiting-approval' as const, idleSince: '2026-10-26T11:30:00.000Z' };
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: pending, owner: approval }), idle), { kind: 'wait', reason: 'reviewer awaiting approval', wait: { kind: 'approval', key: 'approval-T-r', since: approval.idleSince } });
  const risky = nextAction(issue({ status: 'Triage', description: 'x', labels: ['Bug', 'area:kiosk'], risk: 'security' }), idle);
  assert.deepEqual(risky, { kind: 'wait', reason: 'risk security needs a human decision', wait: { kind: 'risk', key: 'risk-security' } });
});

test('P3.1: a CONFLICTING PR steers the builder to rebase instead of waiting on CI that never runs; without a builder it spawns one', () => {
  const owner = { role: 'builder' as const, threadID: 'T-1', round: 1, state: 'idle' as const };
  const conflicting = { number: 9, headSha: sha, ci: 'pending' as const, merged: false, conflicting: true };
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: conflicting, owner }), idle), {
    kind: 'steer', role: 'builder', threadID: 'T-1', key: `conflict-${sha.slice(0, 12)}`,
    message: `PR #9 conflicts with main at ${sha}. Rebase onto origin/main, resolve the conflicts and push to the same branch; do not open a new PR.`,
  });
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: conflicting }), idle), { kind: 'spawn', role: 'builder', executor: 'orb', reason: 'PR #9 conflicts with main', round: 1 });
});

test('P3.1: a delivered steer is not repeated; the issue waits for the answer from the steer comment, and a new head is steered afresh', () => {
  const owner = { role: 'builder' as const, threadID: 'T-1', round: 1, state: 'idle' as const };
  const failed = { number: 9, headSha: sha, ci: 'failure' as const, merged: false };
  const key = `ci-failed-${sha.slice(0, 12)}`;
  assert.equal(nextAction(issue({ status: 'In Progress', pr: failed, owner }), idle).kind, 'steer');
  const at = '2026-10-26T12:00:00.000Z';
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: failed, owner, steers: { [key]: at } }), idle), { kind: 'wait', reason: `steer ${key} unanswered`, wait: { kind: 'steer', key: `steer-${key}`, since: at } });
  const pushed = { ...failed, headSha: 'd'.repeat(40) };
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: pushed, owner, steers: { [key]: at } }), idle).kind, 'steer');
  assert.deepEqual(parseSteer(`note\n${steerLine(key, 'T-1')}`), { key, threadID: 'T-1' });
  for (const reason of ['wait-overdue', 'action-failed', 'plane-blocked'] as const) assert.match(pageText('MET-1', { kind: 'page', reason, detail: 'x' }), /default if silent: .*nothing .*automatically|default if silent: the issue keeps waiting/);
});

// --- MET-348: outcome correction budget --------------------------------------------------------

const t0 = Date.parse('2026-10-27T03:00:00.000Z');
const grant = (over: Partial<Budget> = {}): Budget => ({ epoch: 1, start: new Date(t0).toISOString(), deadline: new Date(t0 + correctionWindowMs).toISOString(), contract: contractOf(spec, undefined), ...over });
const rejected = (round: number, head = sha) => ({ number: 9, headSha: head, ci: 'success' as const, merged: false, verdict: { state: 'changes' as const, sha: head }, changesRounds: round });
const builder = { role: 'builder' as const, threadID: 'T-1', round: 1, state: 'idle' as const };
const budgeted = (round: number, budget: Budget | undefined, over: Partial<IssueSnapshot> = {}) =>
  issue({ status: 'In Progress', pr: rejected(round), owner: builder, correction: { epoch: 1, corrected: round > 1, ...(budget ? { budget } : {}) }, ...over });

test('MET-348: the first correction of an epoch records its budget before any steer or spawn', () => {
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: rejected(1), owner: builder, correction: { epoch: 1, corrected: false } }), idle, t0),
    { kind: 'admit', budget: grant() });
  // Without a live builder the admission still comes first.
  assert.equal(nextAction(issue({ status: 'In Progress', pr: rejected(1), correction: { epoch: 2, corrected: false } }), idle, t0).kind, 'admit');
  assert.equal(budgetLine(grant()), `odd-budget epoch=1 start=2026-10-27T03:00:00.000Z deadline=2026-10-27T05:00:00.000Z contract=${contractOf(spec, undefined)}`);
  assert.deepEqual(parseBudget(budgetLine(grant())), grant());
});

test('MET-348: prior behavior paged the third rejected head; inside the budget it is corrected, and at the deadline exactly it holds', () => {
  // Prior (no budget, legacy history): the third head pages third-failed-qa-round.
  assert.equal((nextAction(budgeted(3, undefined), idle, t0 + 60_000) as { reason?: string }).reason, 'third-failed-qa-round');
  // New: third and fourth heads inside the window are steered, with the design reassessment.
  for (const round of [3, 4]) {
    const head = round === 3 ? sha : 'd'.repeat(40);
    const action = nextAction(issue({ status: 'In Progress', pr: rejected(round, head), owner: builder, correction: { epoch: 1, corrected: true, budget: grant() } }), idle, t0 + correctionWindowMs - 1);
    assert.equal(action.kind, 'steer');
    assert.ok((action as { message: string }).message.endsWith(reassessment));
  }
  // At the deadline exactly: budget-ceiling with the deadline, head and last blocker, whatever the issue is doing.
  for (const over of [{}, { owner: { ...builder, state: 'running' as const } }, { pr: { ...rejected(1), verdict: { state: 'ready' as const, sha } } }]) {
    const at = nextAction(budgeted(3, grant(), over), idle, t0 + correctionWindowMs) as Extract<Action, { kind: 'page' }>;
    assert.equal(at.kind, 'page');
    assert.equal(at.reason, 'budget-ceiling');
    assert.equal(at.sha, sha);
    assert.match(at.detail, /correction budget ended at 2026-10-27T05:00:00\.000Z/);
    assert.match(at.detail, new RegExp(`Head ${sha}; last blocker: `));
  }
  assert.match(pageText('MET-1', nextAction(budgeted(3, grant()), idle, t0 + correctionWindowMs) as Extract<Action, { kind: 'page' }>), /default if silent: nothing more is started, steered or merged for the issue; running work and its results are kept/);
  // A ready verdict at a green current head one millisecond before the deadline merges normally.
  assert.deepEqual(nextAction(budgeted(1, grant(), { pr: { ...rejected(1), verdict: { state: 'ready', sha } } }), idle, t0 + correctionWindowMs - 1), { kind: 'merge', pr: 9, sha });
  // A ready verdict for an older head never merges the current one.
  assert.equal(nextAction(budgeted(1, grant(), { pr: { ...rejected(1), verdict: { state: 'ready', sha: 'd'.repeat(40) } } }), idle, t0).kind, 'spawn');
});

test('MET-348: a changed contract or untrusted budget state holds instead of granting time; cosmetic edits and new heads do not', () => {
  const changed = spec.replace('- doc merged', '- doc merged and announced');
  assert.match((nextAction(budgeted(2, grant(), { description: changed }), idle, t0) as { detail: string }).detail, /accepted contract changed/);
  assert.equal((nextAction(budgeted(2, grant(), { risk: 'security' }), idle, t0) as { reason: string }).reason, 'budget-ceiling');
  // A trailing note outside the contract sections (in Goal-less text) and a new head keep the grant.
  assert.equal(nextAction(budgeted(2, grant(), { description: `${spec}  ` , pr: rejected(2, 'e'.repeat(40)) }), idle, t0).kind, 'steer');
  const invalid = issue({ status: 'In Progress', pr: rejected(2), owner: builder, correction: { epoch: 1, corrected: true, invalid: 'malformed odd-budget comment' } });
  assert.match((nextAction(invalid, idle, t0) as { detail: string }).detail, /cannot be trusted \(malformed odd-budget comment\); no time is granted/);
  assert.equal(parseBudget('odd-budget epoch=1 start=2026-10-27T03:00:00.000Z deadline=2026-10-27T07:00:00.000Z contract=abcdefabcdef'), 'malformed', 'a window longer than 120 min');
  assert.equal(parseBudget('odd-budget epoch=0 start=x'), 'malformed');
});

test('MET-348: the latch finishes its missing steps, waits while labelled, and resumes once only after the label is removed', () => {
  const line = escalationLine({ reason: 'budget-ceiling', pr: 9, sha, done: ['page', 'label'] });
  assert.equal(line, `odd-escalated reason=budget-ceiling pr=9 sha=${sha} done=label,page`);
  assert.deepEqual(parseEscalation(`${line}\n\ndetail`), { reason: 'budget-ceiling', pr: 9, sha, done: ['label', 'page'], detail: 'detail' });
  assert.equal(parseEscalation('odd-escalated reason=third-failed-qa-round\n\nMET-1: PR #9 rejected 3 times'), 'legacy');
  assert.equal(parseEscalation('odd-escalated reason=budget-ceiling done=everything'), 'malformed');
  const latch = { id: 'c-9', reason: 'budget-ceiling' as const, pr: 9, sha, done: ['label' as const, 'page' as const], detail: 'd' };
  const latched = (over: Partial<IssueSnapshot>) => issue({ status: 'In Progress', pr: rejected(3), owner: builder, escalation: latch, labels: ['escalated'], ...over });
  assert.deepEqual(nextAction(latched({}), idle, t0), { kind: 'page', reason: 'budget-ceiling', detail: 'd', pr: 9, sha, latch: { id: 'c-9', done: ['label', 'page'] } });
  // A running worker does not delay the remaining steps.
  assert.equal(nextAction(latched({ owner: { ...builder, state: 'running' } }), idle, t0).kind, 'page');
  assert.deepEqual(nextAction(latched({ escalation: { ...latch, done: ['label', 'draft', 'page', 'archive'] } }), idle, t0), { kind: 'wait', reason: 'escalated to Devon' });
  assert.deepEqual(nextAction(latched({ labels: [], correction: { epoch: 1, corrected: true } }), idle, t0), { kind: 'resume', escalation: 'c-9', epoch: 2 });
  // The label was never set: removing nothing is not a resume; the label step is retried.
  assert.equal(nextAction(latched({ labels: [], escalation: { ...latch, done: [] } }), idle, t0).kind, 'page');
  // A legacy label with no latch keeps holding.
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: rejected(3), labels: ['escalated'] }), idle, t0), { kind: 'wait', reason: 'escalated to Devon' });
});

test('MET-348: safety escalations stay immediate whatever budget remains', () => {
  const receipt = parseDeployReceipt('odd-deploy host=factory-gpu component=kiosk sha=abcdef1234 health=fail rollback=none')!;
  const deploying = issue({ status: 'Deploying', deployReceipt: receipt, correction: { epoch: 1, corrected: true, budget: grant() } });
  assert.equal((nextAction(deploying, idle, t0) as { reason: string }).reason, 'failed-rollback');
  const refused = parseDeployReceipt('odd-deploy host=factory-gpu component=meter sha=abcdef1234 health=refused rollback=none refusal=db-changing-legacy')!;
  assert.equal((nextAction({ ...deploying, deployReceipt: refused }, idle, t0) as { reason: string }).reason, 'irreversible-action');
  // A risk decision still waits on a human regardless of any budget.
  assert.equal((nextAction(issue({ status: 'Triage', labels: ['Bug', 'area:agents'], description: 'x', risk: 'security', correction: { epoch: 1, corrected: false, budget: grant() } }), idle, t0) as { reason: string }).reason, 'risk security needs a human decision');
});
