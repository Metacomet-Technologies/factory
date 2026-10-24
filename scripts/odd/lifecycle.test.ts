import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAction, specComplete, ralphGuard, parseDeployReceipt, threadLabels, parseThreadLabels, capacity, issueTriaged, type IssueSnapshot } from './lifecycle.ts';

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
  assert.deepEqual(nextAction(issue({ status: 'Backlog' }), idle), { kind: 'spawn', role: 'intake', executor: 'orb', reason: 'no triage yet', round: 1 });
  assert.equal(nextAction(issue({ status: 'Triage', description: 'one line' }), idle).kind, 'spawn');
  assert.deepEqual(nextAction(issue({ status: 'Triage' }), idle), { kind: 'set-status', status: 'Todo', reason: 'spec complete' });
  assert.equal(nextAction(issue({ status: 'Triage', description: 'x', risk: 'security' }), idle).kind, 'wait');
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
  assert.deepEqual(nextAction(issue({ status: 'Backlog', owner: intake }), idle), { kind: 'wait', reason: 'intake round budget spent (1/1)' });
  assert.equal(nextAction(issue({ status: 'Triage', description: 'x', owner: intake }), idle).kind, 'spawn');
  const spec = { ...intake, role: 'spec' as const };
  assert.equal(nextAction(issue({ status: 'Triage', description: 'x', owner: spec }), idle).kind, 'wait');
  const builder = { ...intake, role: 'builder' as const, state: 'error' as const };
  assert.deepEqual(nextAction(issue({ status: 'In Progress', owner: builder }), idle), { kind: 'spawn', role: 'builder', executor: 'orb', reason: 'builder round 2', round: 2 });
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
    { kind: 'steer', role: 'builder', threadID: 'T-1', message: `QA requested changes at ${sha}; see the odd-verdict comment on PR #9. Address every finding, rerun the Evidence commands, push to the same branch.` });
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr: { ...pr, changesRounds: 3 }, owner }), idle),
    { kind: 'page', reason: 'third-failed-qa-round', detail: 'MET-1: PR #9 rejected 3 times', pr: 9 });
  assert.equal(nextAction(issue({ status: 'In Progress', pr, owner: { ...owner, state: 'running' } }), idle).kind, 'wait');
  assert.deepEqual(nextAction(issue({ status: 'In Progress', labels: ['escalated'], pr, owner }), idle), { kind: 'wait', reason: 'escalated to Devon' });
  // No live builder thread: the next round spawns one; the builder rounds are counted on the PR, not the thread.
  assert.deepEqual(nextAction(issue({ status: 'In Progress', pr }), idle), { kind: 'spawn', role: 'builder', executor: 'orb', reason: 'qa changes, round 3', round: 1 });
});

test('deploy receipts: no receipt waits, healthy is Done, rolled back returns to Todo with a Bug, unhealthy without rollback pages', () => {
  assert.deepEqual(nextAction(issue({ status: 'Deploying' }), idle), { kind: 'wait', reason: 'release not published' });
  const receipt = parseDeployReceipt('note\nodd-deploy host=factory-gpu component=meter+kiosk sha=abcdef1234 health=pass rollback=none\n');
  assert.deepEqual(receipt, { host: 'factory-gpu', component: 'meter+kiosk', sha: 'abcdef1234', health: 'pass', rollback: 'none' });
  assert.deepEqual(nextAction(issue({ status: 'Deploying', deployReceipt: receipt }), idle), { kind: 'set-status', status: 'Done', reason: 'deployed meter+kiosk at abcdef1234' });
  const none = parseDeployReceipt('odd-deploy host=factory-gpu component=none sha=abcdef1234 health=pass rollback=none');
  assert.equal(nextAction(issue({ status: 'Deploying', deployReceipt: none }), idle).kind, 'set-status');
  const rolledBack = nextAction(issue({ status: 'Deploying', deployReceipt: { ...receipt!, component: 'kiosk', health: 'fail', rollback: '/var/backups/factory-kiosk/20261024T120000.abc' } }), idle);
  assert.equal(rolledBack.kind, 'set-status');
  assert.equal((rolledBack as { status: string }).status, 'Todo');
  const followUp = (rolledBack as { followUp?: { title: string; body: string } }).followUp;
  assert.equal(followUp?.title, 'Deploy failed: kiosk at abcdef1234');
  assert.match(followUp?.body ?? '', /^odd-deploy host=factory-gpu component=kiosk sha=abcdef1234 health=fail rollback=\/var\/backups\/factory-kiosk\/20261024T120000\.abc$/m);
  assert.deepEqual(nextAction(issue({ status: 'Deploying', deployReceipt: { ...receipt!, component: 'kiosk', health: 'fail' } }), idle),
    { kind: 'page', reason: 'failed-rollback', detail: 'kiosk on factory-gpu unhealthy at abcdef1234' });
  assert.equal(parseDeployReceipt('odd-deploy host=x component=y sha=zz health=pass rollback=none'), undefined);
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
