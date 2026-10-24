import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { digest, digestDue, localClock, overCaps, restoreStatus, staleThreads, sweepMs, staleMs, type DigestInput } from './watchdog.ts';
import { capacity, type Action } from './lifecycle.ts';
import { receiptLabel, type LiveThread } from './snapshot.ts';
import plugin from '../../.amp/plugins/factory-odd.ts';

const now = new Date('2026-10-24T15:16:00Z');
const idleFor = (minutes: number, over: Partial<LiveThread> = {}): LiveThread =>
  ({ id: `T-${minutes}`, labels: ['odd-issue-met-1', 'odd-role-builder', 'odd-round-1'], state: 'idle', updatedAt: new Date(now.getTime() - minutes * 60_000).toISOString(), ...over });
const stuckBuilder: Action = { kind: 'wait', reason: 'builder has not opened a PR', stuck: 'builder' };

test('a stuck owner is stale after 15 idle minutes, not at 10; running, undated, other-role and delivered threads never are', () => {
  assert.equal(sweepMs, 10 * 60_000);
  assert.equal(staleMs, 15 * 60_000);
  assert.deepEqual(staleThreads(stuckBuilder, [idleFor(16)], now).map(thread => thread.id), ['T-16']);
  assert.deepEqual(staleThreads(stuckBuilder, [idleFor(10)], now), []);
  assert.deepEqual(staleThreads(stuckBuilder, [idleFor(15)], now), []);
  assert.deepEqual(staleThreads(stuckBuilder, [idleFor(16, { state: 'streaming' })], now), []);
  assert.deepEqual(staleThreads(stuckBuilder, [idleFor(16, { updatedAt: undefined })], now), []);
  assert.deepEqual(staleThreads(stuckBuilder, [idleFor(16, { labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-1'] })], now), []);
  const stuckReviewer: Action = { kind: 'wait', reason: 'reviewer round budget spent (2/2)', stuck: 'reviewer' };
  const reviewer = (extra: string[]) => idleFor(16, { labels: ['odd-issue-met-1', 'odd-role-reviewer', 'odd-round-2', ...extra] });
  assert.deepEqual(staleThreads(stuckReviewer, [reviewer([])], now).length, 1);
  assert.deepEqual(staleThreads(stuckReviewer, [reviewer(['odd-verdict-changes-abcdefabcdef'])], now), []);
  // Only the verifier of the current receipt can be stuck; one of an older release has delivered.
  const stuckVerifier: Action = { kind: 'wait', reason: 'verifier round budget spent (2/2)', stuck: 'verifier' };
  const verifier = (sha: string) => idleFor(16, { id: `T-v-${sha[0]}`, labels: ['odd-issue-met-1', 'odd-role-verifier', 'odd-round-2', receiptLabel(sha)] });
  assert.deepEqual(staleThreads(stuckVerifier, [verifier('a'.repeat(40)), verifier('b'.repeat(40))], now, 'b'.repeat(40)).map(thread => thread.id), ['T-v-b']);
  assert.deepEqual(staleThreads({ kind: 'wait', reason: 'builder running' }, [idleFor(60)], now), []);
  assert.deepEqual(staleThreads({ kind: 'spawn', role: 'builder', executor: 'orb', reason: 'x', round: 1 }, [idleFor(60)], now), []);
});

test('a cancelled builder without a PR returns the issue to Todo; everything else keeps its status', () => {
  assert.equal(restoreStatus('builder', 'In Progress', false), 'Todo');
  assert.equal(restoreStatus('builder', 'In Progress', true), undefined);
  assert.equal(restoreStatus('reviewer', 'In Progress', true), undefined);
  assert.equal(restoreStatus('intake', 'Backlog', false), undefined);
});

test('caps are over only past the soft limits', () => {
  assert.equal(overCaps({ orbs: capacity.orbs, runnerSlots: capacity.runnerSlots, buildIssues: capacity.buildIssues }), false);
  assert.equal(overCaps({ orbs: capacity.orbs + 1, runnerSlots: 0, buildIssues: 0 }), true);
  assert.equal(overCaps({ orbs: 0, runnerSlots: 0, buildIssues: capacity.buildIssues + 1 }), true);
});

test('the digest is due once per New York day after 08:00', () => {
  // 2026-10-24 is EDT (UTC-4): 11:59Z is 07:59 local, 12:00Z is 08:00 local.
  assert.deepEqual(localClock(new Date('2026-10-24T12:00:00Z')), { day: '2026-10-24', hour: 8 });
  assert.equal(digestDue(undefined, new Date('2026-10-24T11:59:00Z')), undefined);
  assert.equal(digestDue(undefined, new Date('2026-10-24T12:00:00Z')), '2026-10-24');
  assert.equal(digestDue('2026-10-24', new Date('2026-10-24T20:00:00Z')), undefined);
  assert.equal(digestDue('2026-10-24', new Date('2026-10-25T03:59:00Z')), undefined, 'still 23:59 on the 24th in New York');
  assert.equal(digestDue('2026-10-24', new Date('2026-10-25T12:00:00Z')), '2026-10-25');
});

test('the digest lists counts, identifiers and SHAs, and never a diff', () => {
  const input: DigestInput = {
    day: '2026-10-24',
    merged: [{ number: 182, title: 'ODD phase 5', headSha: '00769a51786e254c8d71f8087553d560e5966d94', mergeSha: 'ea4a339a0ce150a64551d0489c3ca211400616ea' }],
    done: [{ identifier: 'MET-280', title: 'ODD phase 5: deployer' }],
    bugs: [],
    escalated: [{ identifier: 'MET-304', title: 'clearing escalated' }],
    load: { orbs: 2, runnerSlots: 0, buildIssues: 1 },
    cancelled: ['MET-1 odd-watchdog cancelled role=builder thread=T-1 round=1'],
  };
  const text = digest(input);
  assert.match(text, /^ODD digest 2026-10-24$/m);
  assert.match(text, /^Merged PRs \(1\):\n- #182 ODD phase 5 head 00769a51786e merge ea4a339a0ce1$/m);
  assert.match(text, /^Issues Done \(1\):\n- MET-280 /m);
  assert.match(text, /^Bugs filed \(0\):\n- none$/m);
  assert.match(text, /^Waiting on Devon \(1\):\n- MET-304 /m);
  assert.match(text, /^Load: orbs 2\/4, runner slots 0\/2, build issues 1\/2$/m);
  assert.match(text, /^Watchdog cancellations \(1\):\n- MET-1 odd-watchdog cancelled role=builder thread=T-1 round=1$/m);
  assert.doesNotMatch(text, /diff --git|ghp_|xox[abp]-|lin_api_/);
});

/** Linear, thread search and #factory-alerts shared by every plugin instance; each `start()` is a fresh plugin load arming the control thread. */
function controlOrb() {
  const evaluated: string[] = [];
  const alerts: string[] = [];
  let alertReads = 0;
  const backlog = Array.from({ length: 101 }, (_, i) => ({ id: `MET-${i + 1}` }));
  const tools = { call: async (name: string, input: Record<string, unknown>) => {
    switch (name) {
      case 'linear.list_issues':
        if (input.state !== 'Backlog') return { issues: [], hasNextPage: false, cursor: '' };
        return input.cursor === 'page-2' ? { issues: backlog.slice(100), hasNextPage: false, cursor: 'end' } : { issues: backlog.slice(0, 100), hasNextPage: true, cursor: 'page-2' };
      case 'linear.get_issue': evaluated.push(String(input.id)); return { id: input.id, status: 'Done', labels: [], description: '', relations: { blockedBy: [] } };
      case 'linear.list_comments': return { comments: [] };
      case 'find_thread':
        if (input.query !== 'label:odd-role-builder archived:false') return { threads: [] };
        return input.cursor === 'threads-2' ? { threads: [{ id: 'T-200' }] } : { threads: [{ id: 'T-199' }], nextCursor: 'threads-2' };
      case 'get_thread_status': return { metadata: { labels: [`odd-issue-met-${String(input.thread).slice(2)}`, 'odd-role-builder', 'odd-round-1'] }, agentState: { state: 'idle' } };
      case 'slack_read': {
        if (input.channelName !== 'factory-alerts') return { messages: [] };
        alertReads += 1;
        const terms = (input.filter as { containsAll: string[] }).containsAll;
        return { messages: alerts.filter(text => terms.every(term => text.includes(term))).map(text => ({ text })) };
      }
      case 'slack_write': alerts.push(String(input.text)); return {};
      default: return {};
    }
  } };
  const start = async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const amp = {
      $: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }),
      createAgent: () => ({ definition: {} }), registerAgentMode: () => {}, registerTool: () => {},
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, handler); },
      createWebhook: async () => ({ url: 'https://hooks.example/x' }),
      system: { executor: { kind: 'remote', keepAlive: async () => {} } },
    };
    await (plugin as unknown as (api: unknown) => Promise<void>)(amp);
    const thread = { id: 'T-control', labels: async () => ['odd-control-plane', 'odd-perform'] };
    await handlers.get('session.start')!({}, { thread, ui: { confirm: async () => true, notify: async () => {} }, logger: { log: () => {} }, tools });
  };
  return { start, evaluated, alerts, reads: () => alertReads };
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 20_000 && !done(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(done(), 'condition not reached');
};

test('the sweep reads every page of issues and threads, and a plugin reload does not post the day\'s digest twice', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const orb = controlOrb();
  await orb.start();
  await until(() => orb.alerts.length > 0);
  assert.ok(orb.evaluated.includes('MET-101'), 'issue on the second Backlog page');
  assert.ok(orb.evaluated.includes('MET-200'), 'thread on the second search page');
  assert.equal(orb.alerts.filter(text => text.startsWith('ODD digest 2026-10-24')).length, 1);
  // Reload: a fresh plugin instance arms the same control thread and sweeps at once.
  await orb.start();
  await until(() => orb.reads() === 2);
  for (let i = 0; i < 200; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(orb.alerts.length, 1);
});
