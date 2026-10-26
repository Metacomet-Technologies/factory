import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { blindMs, digest, digestDue, episodeLine, failureBudget, failureDue, incidentPageDue, incidentText, incidents, localClock, overCaps, overdueKeys, overdueLine, overduePage, parseEpisode, restoreStatus, sanitizeError, slackMessageMax, slackMessages, staleThreads, sweepMs, staleMs, type DigestInput, type Episode } from './watchdog.ts';
import { heartbeatLine, parseHeartbeat } from './lifecycle.ts';
import { capacity, type Action } from './lifecycle.ts';
import { receiptLabel, type LiveThread } from './snapshot.ts';
import plugin from '../../.amp/plugins/factory-odd.ts';
import { fakeShell } from './fixtures.ts';
import { io } from './launch.ts';

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
    risk: [{ identifier: 'MET-5', reason: 'risk security needs a human decision' }],
    failedVerification: [{ identifier: 'MET-6', reason: 'verification failed at abcdef123456; bug MET-9' }],
    unknownAge: [],
  };
  const text = digest(input);
  assert.match(text, /^ODD digest 2026-10-24$/m);
  assert.match(text, /^Merged PRs \(1\):\n- #182 ODD phase 5 head 00769a51786e merge ea4a339a0ce1$/m);
  assert.match(text, /^Issues Done \(1\):\n- MET-280 /m);
  assert.match(text, /^Bugs filed \(0\):\n- none$/m);
  assert.match(text, /^Waiting on Devon \(1\):\n- MET-304 /m);
  assert.match(text, /^Load: orbs 2\/4, runner slots 0\/2, build issues 1\/2$/m);
  // P3.1: human waits are reported here, not paged.
  assert.match(text, /^Risk decisions waiting \(1\):\n- MET-5 risk security needs a human decision$/m);
  assert.match(text, /^Failed verifications \(1\):\n- MET-6 verification failed at abcdef123456; bug MET-9$/m);
  assert.match(text, /^Waits of unknown age \(0\):\n- none$/m);
  assert.match(text, /^Watchdog cancellations \(1\):\n- MET-1 odd-watchdog cancelled role=builder thread=T-1 round=1$/m);
  assert.doesNotMatch(text, /diff --git|ghp_|xox[abp]-|lin_api_/);
});

test('a digest longer than one Slack message is split on line breaks', () => {
  const merged = Array.from({ length: 46 }, (_, i) => ({ number: 140 + i, title: `ODD phase ${i}: a title about as long as the real ones are`, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) }));
  const text = digest({ day: '2026-10-24', merged, done: [], bugs: [], escalated: [], load: { orbs: 0, runnerSlots: 0, buildIssues: 0 }, cancelled: [], risk: [], failedVerification: [], unknownAge: [] });
  assert.ok(text.length > slackMessageMax, 'the fixture must need more than one message');
  const parts = slackMessages(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= slackMessageMax));
  assert.match(parts[0], /^ODD digest 2026-10-24\n/);
  assert.match(parts[1], new RegExp(`^\\(2/${parts.length}\\)\\n- #`));
  assert.equal(parts.map(part => part.replace(/^\(\d+\/\d+\)\n/, '')).join('\n'), text, 'nothing is lost or cut mid-line');
  assert.deepEqual(slackMessages('short'), ['short']);
});

/** Linear, thread search and #factory-alerts shared by every plugin instance; each `start()` is a fresh plugin load arming the control thread and returns its `odd_control_status` tool. `override` also sees `thread.labels` and `createWebhook`. */
function controlOrb(override: (name: string, input: Record<string, unknown>) => unknown = () => undefined) {
  const evaluated: string[] = [];
  const alerts: string[] = [];
  const dms: string[] = [];
  const calls: string[] = [];
  const updates: { id: string; body: string }[] = [];
  let alertReads = 0;
  const triage = Array.from({ length: 101 }, (_, i) => ({ id: `MET-${i + 1}` }));
  const tools = { call: async (name: string, input: Record<string, unknown>) => {
    calls.push(name);
    const overridden = await override(name, input);
    if (overridden !== undefined) return overridden;
    switch (name) {
      case 'linear.list_issues':
        if (input.state !== 'Triage') return { issues: [], hasNextPage: false, cursor: '' };
        return input.cursor === 'page-2' ? { issues: triage.slice(100), hasNextPage: false, cursor: 'end' } : { issues: triage.slice(0, 100), hasNextPage: true, cursor: 'page-2' };
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
      case 'slack_write': (input.channelName === 'factory-alerts' ? alerts : dms).push(String(input.text)); return {};
      case 'linear.get_status_updates': return { statusUpdates: updates.filter(update => parseHeartbeat(update.body)), hasNextPage: false, cursor: '' };
      case 'linear.save_status_update': {
        const existing = updates.find(update => update.id === input.id);
        if (existing) existing.body = String(input.body);
        else updates.push({ id: `update-${updates.length + 1}`, body: String(input.body) });
        return { id: (existing ?? updates.at(-1)!).id };
      }
      default: return {};
    }
  } };
  const start = async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    let status: { execute: (input: Record<string, unknown>, ctx: unknown) => Promise<string> } | undefined;
    const amp = {
      $: fakeShell().$,
      createAgent: () => ({ definition: {} }), registerAgentMode: () => {}, registerTool: (tool: typeof status) => { status = tool; },
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, handler); },
      createWebhook: async (options: Record<string, unknown>) => (await override('createWebhook', options)) ?? { url: 'https://hooks.example/x' },
      system: { executor: { kind: 'remote', keepAlive: async () => {} } },
    };
    await (plugin as unknown as (api: unknown) => Promise<void>)(amp);
    const thread = { id: 'T-control', labels: async () => (await override('thread.labels', {})) ?? ['odd-control-plane', 'odd-perform'] };
    const ctx = { thread, ui: { confirm: async () => true, notify: async () => {} }, logger: { log: () => {} }, tools };
    await handlers.get('session.start')!({}, ctx);
    return async (input: Record<string, unknown>) => JSON.parse(await status!.execute(input, ctx)) as { armed: boolean; error?: string };
  };
  return { start, evaluated, alerts, dms, calls, updates, reads: () => alertReads };
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
  assert.ok(orb.evaluated.includes('MET-101'), 'issue on the second Triage page');
  assert.ok(orb.evaluated.includes('MET-200'), 'thread on the second search page');
  assert.equal(orb.alerts.filter(text => text.startsWith('ODD digest 2026-10-24')).length, 1);
  // Reload: a fresh plugin instance arms the same control thread and sweeps at once.
  await orb.start();
  await until(() => orb.reads() === 2);
  for (let i = 0; i < 200; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(orb.alerts.length, 1);
});

test('the sweep records a cancellation on the issue before it archives the stale thread', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  t.after(() => mock.timers.reset());
  let commentFailures = 1;
  const orb = controlOrb((name, input) => {
    switch (name) {
      case 'linear.list_issues': return { issues: [], hasNextPage: false, cursor: '' };
      case 'find_thread': return /odd-role-builder|odd-issue-met-1 /.test(String(input.query)) ? { threads: [{ id: 'T-1', updatedAt: new Date(Date.now() - staleMs - 60_000).toISOString() }] } : { threads: [] };
      case 'linear.get_issue': return { id: 'MET-1', status: 'In Progress', labels: ['odd'], description: '', relations: { blockedBy: [] } };
      case 'linear.save_comment':
        if (commentFailures-- > 0) throw new Error('503 Service Unavailable');
        return {};
      default: return undefined;
    }
  });
  await orb.start();
  await until(() => orb.calls.includes('linear.save_comment'));
  for (let i = 0; i < 200; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(!orb.calls.includes('update_thread'), 'a cancellation that failed to record must not archive the thread');
  mock.timers.tick(90_000);
  await until(() => orb.calls.includes('update_thread'));
  assert.ok(orb.calls.lastIndexOf('linear.save_comment') < orb.calls.indexOf('update_thread'));
  await until(() => orb.calls.includes('linear.save_issue'));
});

test('a successful sweep writes one heartbeat and the next sweep updates it; a failing sweep writes nothing', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const orb = controlOrb((name) => {
    if (name === 'linear.list_issues') return { issues: [], hasNextPage: false, cursor: '' };
    if (name === 'find_thread') return { threads: [] };
    return undefined;
  });
  await orb.start();
  await until(() => orb.updates.length === 1);
  assert.equal(parseHeartbeat(orb.updates[0].body), '2026-10-24T15:00:00.000Z');
  const id = orb.updates[0].id;
  mock.timers.tick(sweepMs);
  await until(() => orb.updates[0].body.includes('15:10'));
  assert.equal(orb.updates.length, 1, 'the second sweep updates the same row');
  assert.equal(orb.updates[0].id, id);
  assert.equal(heartbeatLine('2026-10-24T15:10:00.000Z'), orb.updates[0].body);

  let failed = false;
  const blind = controlOrb((name, input) => {
    if (name === 'linear.list_issues') return { issues: [], hasNextPage: false, cursor: '' };
    if (name === 'find_thread') return { threads: [] };
    if (name === 'slack_write' && input.channelName === 'factory-alerts') { failed = true; throw new Error('invalid_blocks'); }
    return undefined;
  });
  await blind.start();
  await until(() => failed);
  for (let i = 0; i < 200; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(blind.updates.length, 0, 'a sweep that failed writes no heartbeat');
});

test('a digest that Slack keeps rejecting leaves the control plane blind until it pages', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  t.after(() => mock.timers.reset());
  let digests = 0;
  const orb = controlOrb((name, input) => {
    if (name === 'linear.list_issues') return { issues: [], hasNextPage: false, cursor: '' };
    if (name === 'find_thread') return { threads: [] };
    if (name === 'slack_write' && input.channelName === 'factory-alerts') { digests += 1; throw new Error('Failed to post message: invalid_blocks'); }
    return undefined;
  });
  await orb.start();
  await until(() => digests === 1);
  // Sweeps until one runs at least `blindMs` after the first failure.
  for (let sweeps = 2; (sweeps - 2) * sweepMs < blindMs; sweeps++) {
    mock.timers.tick(sweepMs);
    await until(() => digests === sweeps);
  }
  await until(() => orb.dms.length === 1);
  assert.match(orb.dms[0], /control-plane-blind/);
  assert.match(orb.dms[0], /invalid_blocks/);
});

const emptyWork = (name: string) => {
  if (name === 'linear.list_issues') return { issues: [], hasNextPage: false, cursor: '' };
  if (name === 'find_thread') return { threads: [] };
  return undefined;
};
const settle = async () => { for (let i = 0; i < 200; i++) await new Promise(resolve => setImmediate(resolve)); };

test('P3.6: a rejected labels read fails that sweep only; the next sweep runs and writes the heartbeat', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  t.after(() => mock.timers.reset());
  let labelReads = 0;
  const orb = controlOrb((name) => {
    // Read 1 arms the control thread; read 2 is the first sweep's.
    if (name === 'thread.labels' && ++labelReads === 2) throw new Error('labels 503');
    return emptyWork(name);
  });
  await orb.start();
  await until(() => labelReads >= 2);
  await settle();
  assert.equal(orb.updates.length, 0, 'the sweep whose labels read failed writes no heartbeat');
  mock.timers.tick(sweepMs);
  await until(() => orb.updates.length === 1);
  assert.equal(parseHeartbeat(orb.updates[0].body), '2026-10-24T15:10:00.000Z');
});

test('P3.6: a heartbeat write that keeps failing pages control-plane-blind once, 15 minutes into the episode', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  t.after(() => mock.timers.reset());
  let heartbeats = 0;
  const orb = controlOrb((name) => {
    if (name === 'linear.save_status_update') { heartbeats += 1; throw new Error('Linear 500'); }
    return emptyWork(name);
  });
  await orb.start();
  await until(() => heartbeats === 1);
  mock.timers.tick(sweepMs);
  await until(() => heartbeats === 2);
  await settle();
  assert.deepEqual(orb.dms, [], 'no page 10 minutes into the episode');
  mock.timers.tick(sweepMs);
  await until(() => orb.dms.length === 1);
  assert.match(orb.dms[0], /control-plane-blind/);
  assert.match(orb.dms[0], /since 2026-10-24T15:00:00\.000Z/);
  assert.match(orb.dms[0], /Linear 500/);
  mock.timers.tick(sweepMs);
  await until(() => heartbeats === 4);
  await settle();
  assert.equal(orb.dms.length, 1, 'one page per episode');
});

test('P3.6: a partially failed arm keeps its error, and arm: true retries it with one timer per purpose', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  const intervals = new Map<unknown, number>();
  const { setInterval: set, clearInterval: clear } = globalThis;
  globalThis.setInterval = ((fn: () => void, ms: number) => { const timer = set(fn, ms); intervals.set(timer, ms); return timer; }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { intervals.delete(timer); clear(timer); }) as typeof clearInterval;
  t.after(() => { Object.assign(globalThis, { setInterval: set, clearInterval: clear }); mock.timers.reset(); });
  let githubFailures = 1;
  const orb = controlOrb((name, input) => {
    if (name === 'createWebhook' && input.key === 'github' && githubFailures-- > 0) throw new Error('webhook 503');
    return emptyWork(name);
  });
  const status = await orb.start();
  const failed = await status({});
  assert.equal(failed.armed, false);
  assert.match(failed.error ?? '', /webhook 503/, 'the failure stays visible');
  assert.equal(intervals.size, 0);
  const armed = await status({ arm: true });
  assert.equal(armed.armed, true);
  assert.equal(armed.error, undefined);
  await status({ arm: true });
  assert.deepEqual([...intervals.values()].sort((a, b) => a - b), [5 * 60_000, sweepMs], 'one Slack poll and one sweep interval');
});

// --- P3.1: wait budgets, failure episodes and plane-blocked incidents ----------------------

const t0 = Date.parse('2026-10-26T12:00:00.000Z');
const episode = (over: Partial<Episode> = {}): Episode =>
  ({ issue: 'MET-364', key: 'spawn-reviewer-r1-aaaaaaaaaaaa', stage: 'spawn-reviewer', first: new Date(t0).toISOString(), attempts: 1, state: 'open', alert: 'pending', error: 'Error: Orb custom agents must be registered as an active agent mode', ...over });
const full = { orbs: 0, runnerSlots: 0, buildIssues: capacity.buildIssues };

test('P3.1: an overdue machine wait pages in the one format at its budget, not before; human waits never page', () => {
  const ci: Extract<Action, { kind: 'wait' }> = { kind: 'wait', reason: 'ci pending at aaaaaaaaaaaa', wait: { kind: 'ci', key: 'ci-aaaaaaaaaaaa', since: new Date(t0).toISOString() } };
  assert.equal(overduePage('MET-1', ci, t0 + 60 * 60_000 - 1), undefined);
  const text = overduePage('MET-1', ci, t0 + 60 * 60_000, { number: 9, headSha: 'a'.repeat(40) });
  assert.match(text ?? '', /^ODD page: wait-overdue \| issue MET-1 \| PR #9 \| a{40} \| default if silent: the issue keeps waiting; nothing is cancelled or escalated\. ci pending at a{12}: ci wait is 60 min old \(budget 60 min\) since 2026-10-26T12:00:00\.000Z\. episode=ci-a{12}$/);
  assert.equal(overduePage('MET-1', { ...ci, wait: { kind: 'ci', key: 'ci-x' } }, t0 + 1e9), undefined, 'unknown age is reported in the digest, not paged as overdue');
  assert.equal(overduePage('MET-1', { kind: 'wait', reason: 'risk security needs a human decision', wait: { kind: 'risk', key: 'risk-security' } }, t0 + 1e9), undefined);
  assert.deepEqual([...overdueKeys([{ body: overdueLine('ci-x') }, { body: 'other' }])], ['ci-x']);
});

test('P3.1: a failing action is due at its third attempt or five minutes after its first failure, whichever comes first', () => {
  assert.deepEqual(failureBudget, { attempts: 3, ms: 5 * 60_000 });
  assert.equal(failureDue(episode({ attempts: 2 }), t0 + 5 * 60_000 - 1), false);
  assert.equal(failureDue(episode({ attempts: 3 }), t0 + 1), true);
  assert.equal(failureDue(episode({ attempts: 1 }), t0 + 5 * 60_000), true);
  assert.equal(failureDue(episode({ attempts: 1, exhausted: true }), t0), true, 'a spent recheck budget is due at once');
  const durable = episode({ attempts: 4, alert: 'plane-blocked', commentId: 'c-1' });
  assert.deepEqual(parseEpisode('MET-364', { id: 'c-1', body: episodeLine(durable) }), durable);
  assert.equal(sanitizeError('Error: 401 for https://hooks.example/x?token=abc Bearer xyz ghp_abcdef123\nline2'), 'Error: 401 for https://hooks.example/x Bearer [redacted] [redacted] line2');
});

test('P3.1: one shared blocker is one incident; it is plane-blocked only when every occupied slot fails and ready work waits', () => {
  const both = [episode(), episode({ issue: 'MET-368', key: 'spawn-reviewer-r1-bbbbbbbbbbbb' })];
  const plane = { load: full, building: ['MET-364', 'MET-368'], waiting: ['MET-379'] };
  const [incident, ...rest] = incidents(both, plane, t0);
  assert.equal(rest.length, 0, 'the same error on two issues is one incident');
  assert.equal(incident.reason, 'plane-blocked');
  assert.equal(incident.due, false);
  assert.equal(incidents(both.map(e => ({ ...e, attempts: 3 })), plane, t0)[0].due, true);
  // Controls: free capacity, nothing waiting, or one slot progressing is not a deadlock.
  assert.equal(incidents(both, { ...plane, load: { ...full, buildIssues: 1 } }, t0)[0].reason, 'action-failed');
  assert.equal(incidents(both, { ...plane, waiting: [] }, t0)[0].reason, 'action-failed');
  assert.equal(incidents([both[0]], plane, t0)[0].reason, 'action-failed');
  // A different blocker is a different incident.
  assert.equal(incidents([...both, episode({ issue: 'MET-9', stage: 'merge', key: 'merge-c', error: 'merge refused' })], plane, t0).length, 2);
  const text = incidentText({ ...incident, episodes: both.map(e => ({ ...e, attempts: 3 })) }, plane, t0 + 4 * 60_000);
  assert.match(text, /^ODD page: plane-blocked \| issue MET-364, MET-368 \| - \| - \| default if silent: the build slots stay occupied; nothing is freed, replaced or recovered automatically\. /);
  assert.match(text, /spawn-reviewer failing since 2026-10-26T12:00:00\.000Z \(4 min, 6 attempts\): Error: Orb custom agents must be registered as an active agent mode\./);
  assert.match(text, /Occupied build slots 2\/2: MET-364, MET-368\. Ready work waiting for a build slot: MET-379\./);
  assert.match(text, /Needed: make the reviewer startable .* reload the control orb/);
  assert.equal(incidentPageDue({ ...incident, due: true, delivered: 'plane-blocked' }), false);
  assert.equal(incidentPageDue({ ...incident, due: true, delivered: 'action-failed' }), true, 'an action-failed page is raised to plane-blocked once');
});

type Pr = { number: number; headRefName: string; headRefOid: string; state: 'OPEN' | 'MERGED'; mergeCommit: { oid: string } | null; mergedAt?: string; mergeable: string; commits: { oid: string; committedDate: string }[]; statusCheckRollup: { name: string; conclusion: string }[]; body: string };
type Shell = { exitCode: number; stdout: string; stderr: string };

/**
 * GitHub behind `gh pr list` and `gh pr view <n> --json`: rows carry only the requested fields,
 * newest first, cut at `--limit`. gh reads at most 100 PRs per GraphQL page and `commits` asks
 * for 100 commits × 100 authors per PR, so a page over GitHub's 500,000-node bound is refused
 * with GitHub's own error (the full-field `--limit 100` list asked for 1,000,000). Other
 * commands are left to the caller.
 */
function github(command: string, prs: readonly Pr[]): Shell | undefined {
  const view = /^gh pr view (\d+) --json ([\w,]+)$/.exec(command);
  const list = /^gh pr list (?:--search "([^"]+)" )?--state (open|merged) --json ([\w,]+) --limit (\d+)$/.exec(command);
  if (!view && !list) return undefined;
  const fields = (view ? view[2] : list![3]).split(',');
  const nodes = (view ? 1 : Math.min(Number(list![4]), 100)) * (fields.includes('commits') ? 100 * 100 : 1);
  if (nodes > 500_000) return { exitCode: 1, stdout: '', stderr: `GraphQL: By the time this query traverses to the authors connection, it is requesting up to ${nodes.toLocaleString('en-US')} possible nodes which exceeds the maximum limit of 500,000.` };
  const row = (pr: Pr) => Object.fromEntries(fields.map(field => [field, pr[field as keyof Pr]]));
  if (view) {
    const pr = prs.find(candidate => candidate.number === Number(view[1]));
    return pr ? { exitCode: 0, stdout: JSON.stringify(row(pr)), stderr: '' } : { exitCode: 1, stdout: '', stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${view[1]}.` };
  }
  const [, search, state, , limit] = list!;
  const matches = prs.filter(pr => pr.state === state.toUpperCase() && (!search || `${pr.headRefName} ${pr.body}`.toLowerCase().includes(search.toLowerCase())));
  return { exitCode: 0, stdout: JSON.stringify(matches.slice(0, Number(limit)).map(row)), stderr: '' };
}
const fullSpec = '## Goal\nx\n\n## Isolation\nx\n\n## Build\n- x\n\n## Done means\n- x\n\n## Evidence\n- x\n';
const head = (n: number) => String(n).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, 'a');

/**
 * The factory around one control orb, with fake Linear, GitHub, Slack and thread transports and
 * a mocked clock. Each `start()` is a fresh plugin load (a reload); earlier loads see the control
 * labels removed, so their leftover timers only dry-run. Nothing leaves the process.
 */
function factory() {
  const issues = new Map<string, { id: string; status: string; labels: string[]; description: string }>();
  const comments = new Map<string, { id: string; body: string; createdAt: string }[]>();
  const prs: Pr[] = [];
  const threads = new Map<string, { labels: string[]; state: string; archived: boolean; updatedAt: string }>();
  const dms: string[] = [];
  const steers: string[] = [];
  const control = { slackDown: 0, spawnFails: false, steerFailures: 0, refuse: '', unreadable: '', gh: undefined as ((command: string) => Shell | undefined) | undefined, inject: undefined as ((name: string, input: Record<string, unknown>) => unknown) | undefined };
  /** Lifecycle mutations: status writes, builder launches and heartbeats (comments, archives, steers and DMs are kept above). */
  const saves: string[] = [];
  const launches: string[] = [];
  let heartbeats = 0;
  // No fixture starts a live `amp` builder; an attempt is recorded and fails.
  mock.method(io, 'start', (argv: readonly string[]) => { launches.push(argv.join(' ')); throw new Error('fixture: no live launch'); });
  let slackAttempts = 0;
  let commentIds = 0;
  let generation = 0;
  const tools = { call: async (name: string, input: Record<string, unknown>) => {
    const injected = control.inject?.(name, input);
    if (injected !== undefined) return injected;
    switch (name) {
      case 'linear.list_issues': return { issues: [...issues.values()].filter(issue => issue.status === input.state && (!input.label || issue.labels.includes(String(input.label)))).map(({ id }) => ({ id })), hasNextPage: false };
      case 'linear.get_issue':
        if (input.id === control.unreadable) throw new Error('Linear 503');
        return { ...issues.get(String(input.id))!, relations: { blockedBy: [] } };
      case 'linear.list_comments': return { comments: [...(comments.get(String(input.issueId)) ?? [])].reverse() };
      case 'linear.save_comment': {
        if (input.id) {
          for (const list of comments.values()) for (const comment of list) if (comment.id === input.id) comment.body = String(input.body);
          return { id: input.id };
        }
        const list = comments.get(String(input.issueId)) ?? [];
        const comment = { id: `c-${++commentIds}`, body: String(input.body), createdAt: new Date().toISOString() };
        comments.set(String(input.issueId), [...list, comment]);
        return { id: comment.id };
      }
      case 'linear.save_issue': saves.push(`${input.id} ${JSON.stringify(input.state ?? input.addLabels)}`); return {};
      case 'find_thread': {
        const label = /label:(\S+)/.exec(String(input.query))?.[1] ?? '';
        return { threads: [...threads].filter(([, thread]) => !thread.archived && thread.labels.includes(label)).map(([id, thread]) => ({ id, updatedAt: thread.updatedAt })) };
      }
      case 'get_thread_status': { const thread = threads.get(String(input.thread))!; return { metadata: { labels: thread.labels, archived: thread.archived }, agentState: { state: thread.state } }; }
      case 'update_thread': threads.get(String(input.thread))!.archived = true; return {};
      case 'slack_write':
        if (input.channelName) return {};
        slackAttempts += 1;
        if (control.slackDown > 0) { control.slackDown -= 1; throw new Error('slack 503'); }
        dms.push(String(input.text));
        return { ok: true };
      case 'slack_read': return { messages: [] };
      case 'linear.get_status_updates': return { statusUpdates: [], hasNextPage: false };
      case 'linear.save_status_update': heartbeats += 1; return { id: 'heartbeat' };
      default: return {};
    }
  } };
  const { $: shell } = fakeShell();
  const $ = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (control.refuse && strings.join('').includes(' check ')) return { exitCode: 1, stdout: '', stderr: control.refuse };
    const command = strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ''), '');
    return control.gh?.(command) ?? github(command, prs) ?? shell(strings, ...values);
  };
  let created = 0;
  const amp = (mine: number) => ({
    $,
    createAgent: (config: unknown) => ({ definition: config, createThread: async () => {
      if (control.spawnFails) throw new Error('Orb custom agents must be registered as an active agent mode');
      const id = `T-spawned-${++created}`;
      threads.set(id, { labels: [], state: 'running', archived: false, updatedAt: new Date().toISOString() });
      return { id, setLabels: async (labels: string[]) => { threads.get(id)!.labels = labels; }, appendUserMessage: async () => {} };
    } }),
    registerAgentMode: () => {}, registerTool: (tool: { execute: (input: Record<string, unknown>, ctx: unknown) => Promise<string> }) => { statuses.set(mine, tool.execute); },
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { if (name === 'session.start') starts.set(mine, handler); if (name === 'agent.end') ends.set(mine, handler); },
    createWebhook: async () => ({ url: 'https://hooks.example/x' }),
    system: { executor: { kind: 'remote', keepAlive: async () => {} } },
    threads: { get: (id: string) => ({ labels: async () => threads.get(id)!.labels, addLabels: async () => [], appendUserMessage: async (message: { content: string }) => {
      if (control.steerFailures > 0) { control.steerFailures -= 1; throw new Error('thread unavailable'); }
      steers.push(`${id}: ${message.content}`);
    } }) },
  });
  const starts = new Map<number, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const ends = new Map<number, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const statuses = new Map<number, (input: Record<string, unknown>, ctx: unknown) => Promise<string>>();
  const builder = (issue: string, state = 'idle', updatedAt = new Date().toISOString()) => threads.set(`T-${issue}`, { labels: [`odd-issue-${issue.toLowerCase()}`, 'odd-role-builder', 'odd-round-1', 'odd-engine-anthropic'], state, archived: false, updatedAt });
  const openPr = (issue: string, sha: string, over: Partial<Pr> = {}) => {
    const n = Number(issue.slice(4));
    prs.push({ number: n, headRefName: `${issue.toLowerCase()}-x`, headRefOid: sha, state: 'OPEN', mergeCommit: null, mergeable: 'MERGEABLE', commits: [{ oid: sha, committedDate: new Date().toISOString() }], statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], body: `closes ${issue}`, ...over });
  };
  return {
    issues, comments, prs, threads, dms, steers, control, builder, openPr, saves, launches, heartbeats: () => heartbeats, slackAttempts: () => slackAttempts,
    /** The latest plugin load's `odd_control_status`: its handled events. */
    events: async () => (JSON.parse(await statuses.get(generation)!({}, { thread: { id: 'T-control', labels: async () => ['odd-control-plane', 'odd-perform'] } })) as { events: { issue: string | null; stage: string; error?: string }[] }).events,
    /** The Ralph guard as the latest plugin load runs it at the end of a role thread's turn. */
    guard: (labels: string[]) => ends.get(generation)!({ status: 'done', message: '', thread: { id: 'T-role' } }, { thread: { id: 'T-role', labels: async () => labels }, ui: { confirm: async () => true, notify: async () => {} }, logger: { log: () => {} }, tools, $ }),
    issue: (id: string, status: string) => issues.set(id, { id, status, labels: ['odd', 'Bug', 'area:agents'], description: fullSpec }),
    episodes: (id: string) => (comments.get(id) ?? []).filter(comment => comment.body.startsWith('odd-failure')).map(comment => comment.body.split('\n')[0]),
    async start() {
      const mine = ++generation;
      await (plugin as unknown as (api: unknown) => Promise<void>)(amp(mine));
      const thread = { id: 'T-control', labels: async () => (mine === generation ? ['odd-control-plane', 'odd-perform'] : []) };
      await starts.get(mine)!({}, { thread, ui: { confirm: async () => true, notify: async () => {} }, logger: { log: () => {} }, tools });
    },
  };
}

/** Advances the mocked clock in steps so every timer due on the way fires, letting the plugin settle after each. */
async function advance(ms: number, step = 30_000) {
  for (let left = ms; left > 0; left -= step) {
    mock.timers.tick(Math.min(step, left));
    await settle();
  }
}

/** The MET-379 incident: MET-364 and MET-368 hold both build slots and need a reviewer that cannot spawn; MET-379 is the ready repair. */
function deadlock(builderState = 'idle') {
  const plant = factory();
  for (const id of ['MET-364', 'MET-368']) {
    plant.issue(id, 'In Progress');
    plant.builder(id, builderState);
    plant.openPr(id, id === 'MET-364' ? 'a'.repeat(40) : 'b'.repeat(40));
  }
  plant.issue('MET-379', 'Todo');
  plant.control.spawnFails = true;
  return plant;
}

test('P3.1: the MET-379 self-deadlock pages one actionable plane-blocked incident within the failure budget; a failed delivery and a reload keep it pending; recovery resolves it once; a recurrence is a new episode', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = deadlock();
  plant.control.slackDown = Number.POSITIVE_INFINITY;
  await plant.start();
  await settle();
  assert.deepEqual(plant.episodes('MET-364'), [], 'one failed attempt leaves no comment');
  // Rechecks at 90 s and 270 s: the third attempt is due, well inside five minutes.
  await advance(90_000);
  assert.deepEqual(plant.episodes('MET-364'), ['odd-failure key=spawn-reviewer-r1-aaaaaaaaaaaa stage=spawn-reviewer first=2026-10-26T15:00:00.000Z attempts=2 state=open alert=pending']);
  await advance(180_000);
  assert.ok(plant.slackAttempts() >= 1, 'the incident page was attempted');
  assert.deepEqual(plant.dms, [], 'Slack is down: nothing is delivered');
  assert.match(plant.episodes('MET-368')[0], /attempts=[34] state=open alert=pending$/, 'still pending, never marked delivered');

  // Reload while Slack is still down, then let Slack recover: the pending page goes out exactly once.
  await plant.start();
  await settle();
  assert.deepEqual(plant.dms, []);
  plant.control.slackDown = 0;
  await advance(10 * 60_000);
  assert.equal(plant.dms.length, 1, 'one page for both issues and every recheck');
  const [page] = plant.dms;
  assert.match(page, /^\[odd\] ODD page: plane-blocked \| issue MET-364, MET-368 \| /);
  assert.match(page, /spawn-reviewer failing since 2026-10-26T15:00:00\.000Z \(\d+ min, \d+ attempts\): Error: Orb custom agents must be registered as an active agent mode\./);
  assert.match(page, /Occupied build slots 2\/2: MET-364, MET-368\. Ready work waiting for a build slot: MET-379\./);
  assert.match(page, /Needed: make the reviewer startable/);
  assert.match(plant.episodes('MET-364')[0], /state=open alert=plane-blocked$/);

  // Another reload and more sweeps: delivered stays delivered.
  await plant.start();
  await advance(20 * 60_000);
  assert.equal(plant.dms.length, 1);

  // Recovery: the reviewer can spawn again. Both issues advance; one resolution closes the incident.
  plant.control.spawnFails = false;
  await advance(10 * 60_000);
  assert.equal(plant.dms.length, 2);
  assert.match(plant.dms[1], /^\[odd\] ODD resolved: plane-blocked \| issue MET-364, MET-368 \| spawn-reviewer advances again after \d+ min\./);
  assert.match(plant.episodes('MET-364')[0], /state=resolved alert=closed$/);
  await advance(20 * 60_000);
  assert.equal(plant.dms.length, 2, 'no second resolution');

  // Recurrence: the reviewers are gone and spawning breaks again; a new episode pages again.
  for (const [id, thread] of plant.threads) if (id.startsWith('T-spawned')) thread.archived = true;
  plant.control.spawnFails = true;
  await advance(10 * 60_000 + 5 * 60_000);
  assert.equal(plant.dms.length, 3);
  assert.match(plant.dms[2], /ODD page: plane-blocked \| issue MET-364, MET-368 /);
  assert.equal(plant.episodes('MET-364').length, 2, 'the recurrence is a new episode comment');
});

test('P3.1: an evaluation that keeps failing past its recheck budget still pages, retried until Slack takes it; it is not mistaken for a wait', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  plant.issue('MET-1', 'In Progress');
  plant.builder('MET-1', 'running');
  plant.issue('MET-364', 'In Progress');
  plant.builder('MET-364');
  // The derivation itself fails: Linear refuses to return the issue.
  plant.control.unreadable = 'MET-364';
  plant.control.slackDown = Number.POSITIVE_INFINITY;
  await plant.start();
  await settle();
  // Rechecks back off 90 s, 3, 6, 12 and 24 min; the budget is spent long before Slack recovers.
  await advance(50 * 60_000);
  const attempts = plant.slackAttempts();
  assert.ok(attempts >= 3, 'the incident page was attempted, not only logged');
  assert.deepEqual(plant.dms, []);
  plant.control.slackDown = 0;
  await advance(10 * 60_000);
  assert.equal(plant.dms.length, 1);
  assert.match(plant.dms[0], /^\[odd\] ODD page: action-failed \| issue MET-364 \| .*evaluate failing since 2026-10-26T15:00:00\.000Z .*Linear 503.*Needed: restore the Linear, GitHub or thread-search read that fails/);
});

test('P3.1: full build slots with progressing builders send no incident', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = deadlock('running');
  await plant.start();
  await advance(30 * 60_000);
  assert.deepEqual(plant.dms, []);
  assert.deepEqual(plant.episodes('MET-364'), []);
});

test('P3.1: a refused merge counts per head and pages at the third attempt; the refusal is posted once', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  const sha = 'c'.repeat(40);
  plant.issue('MET-8', 'In Progress');
  plant.builder('MET-8');
  plant.threads.set('T-review', { labels: ['odd-issue-met-8', 'odd-role-reviewer', 'odd-round-1', 'odd-engine-openai', `odd-verdict-ready-${sha.slice(0, 12)}`], state: 'idle', archived: false, updatedAt: new Date().toISOString() });
  plant.openPr('MET-8', sha);
  plant.control.refuse = 'mergeStateStatus BLOCKED';
  await plant.start();
  await settle();
  await advance(120_000);
  assert.deepEqual(plant.dms, [], 'two refusals do not page');
  await advance(60_000);
  assert.equal(plant.dms.length, 1);
  assert.match(plant.dms[0], /^\[odd\] ODD page: action-failed \| issue MET-8 \| .*merge failing since .*merge refused at c{40}: mergeStateStatus BLOCKED\..*Needed: resolve the merge refusal/);
  assert.equal((plant.comments.get('MET-8') ?? []).filter(comment => comment.body.startsWith('odd-merge-refused')).length, 1);
  assert.match(plant.episodes('MET-8')[0], /^odd-failure key=merge-c{12} stage=merge .* attempts=3 state=open alert=action-failed$/);
  await advance(20 * 60_000);
  assert.equal(plant.dms.length, 1, 'once per head');
});

test('P3.1: a failed steer is retried and recorded only after delivery; the record dedupes it across a reload; an unanswered steer pages once after 30 minutes', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  const sha = 'd'.repeat(40);
  plant.issue('MET-7', 'In Progress');
  plant.builder('MET-7');
  plant.openPr('MET-7', sha, { statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE' }] });
  plant.control.steerFailures = 1;
  const records = () => (plant.comments.get('MET-7') ?? []).filter(comment => comment.body.startsWith('odd-steer'));
  await plant.start();
  await settle();
  assert.deepEqual(plant.steers, []);
  assert.deepEqual(records(), [], 'a failed delivery writes no record');
  await advance(90_000);
  assert.deepEqual(plant.steers, [`T-MET-7: [odd] CI failed at ${sha}. Fix the failing jobs and push; do not open a new PR.`]);
  assert.deepEqual(records().map(comment => comment.body), [`odd-steer key=ci-failed-${sha.slice(0, 12)} thread=T-MET-7`]);
  assert.equal(records()[0].createdAt, '2026-10-26T15:01:30.000Z');

  await plant.start();
  await advance(20 * 60_000);
  assert.equal(plant.steers.length, 1, 'no second steer after a reload');
  // Sweeps run at :30 (28.5 min unanswered) and :40 (38.5 min).
  await advance(9 * 60_000 + 30_000);
  assert.deepEqual(plant.dms, [], 'not before 30 minutes');
  await advance(10 * 60_000);
  assert.equal(plant.dms.length, 1);
  assert.match(plant.dms[0], new RegExp(`^\\[odd\\] ODD page: wait-overdue \\| issue MET-7 \\| PR #7 \\| ${sha} \\| .*steer ci-failed-${sha.slice(0, 12)} unanswered: steer wait is 3\\d min old \\(budget 30 min\\) since 2026-10-26T15:01:30\\.000Z`));
  await plant.start();
  await advance(30 * 60_000);
  assert.equal(plant.dms.length, 1, 'one page per episode, across a reload');
  assert.equal(plant.steers.length, 1);
});

// --- P3.7: authoritative reads fail closed (MET-344) -----------------------------------------

const otherPr = (n: number): Pr => ({ number: n, headRefName: `met-${n}-other`, headRefOid: 'e'.repeat(40), state: 'OPEN', mergeCommit: null, mergeable: 'MERGEABLE', commits: [{ oid: 'e'.repeat(40), committedDate: '2026-10-26T10:00:00Z' }], statusCheckRollup: [], body: `closes MET-${n}` });
const builderLabels = ['odd-issue-met-7', 'odd-role-builder', 'odd-round-1', 'odd-engine-anthropic'];

test('P3.7: open-PR discovery stays under GitHub\'s node bound, finds an owned PR past the first 100 with its head time, and an open PR wins over a merged one', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  const sha = 'f'.repeat(40);
  plant.issue('MET-7', 'In Progress');
  plant.builder('MET-7');
  // An earlier merged PR of MET-7 must not win over its open PR (that would move MET-7 to Deploying).
  plant.prs.push({ ...otherPr(6), headRefName: 'met-7-first-try', state: 'MERGED', mergeCommit: { oid: '9'.repeat(40) }, mergedAt: '2026-10-25T12:00:00Z', body: 'closes MET-7' });
  for (let n = 1000; n < 1140; n++) plant.prs.push(otherPr(n));
  // The owned open PR is the 141st open PR, past gh's first 100-PR page; CI is still running.
  plant.openPr('MET-7', sha, { statusCheckRollup: [{ name: 'ci', conclusion: '' }], commits: [{ oid: 'a'.repeat(40), committedDate: '2026-10-26T13:00:00Z' }, { oid: sha, committedDate: '2026-10-26T13:30:00Z' }] });
  // A merged-only issue still derives Deploying from its merged PR.
  plant.issue('MET-8', 'In Progress');
  plant.prs.push({ ...otherPr(8), headRefName: 'met-8-done', state: 'MERGED', mergeCommit: { oid: '8'.repeat(40) }, mergedAt: '2026-10-26T14:00:00Z', body: 'closes MET-8' });
  await plant.start();
  await settle();
  // The CI wait is aged from the head commit (13:30), not an older commit or the sweep: 90 min is past its 60 min budget.
  assert.equal(plant.dms.length, 1);
  assert.match(plant.dms[0], new RegExp(`^\\[odd\\] ODD page: wait-overdue \\| issue MET-7 \\| PR #7 \\| ${sha} \\| .*ci pending at f{12}: ci wait is 90 min old \\(budget 60 min\\) since 2026-10-26T13:30:00Z`));
  assert.ok(!plant.saves.some(save => save.startsWith('MET-7 ')), 'MET-7 keeps its status');
  assert.ok(plant.saves.includes('MET-8 "Deploying"'));
  assert.deepEqual(plant.launches, []);
  assert.equal(plant.heartbeats(), 1);
  // The Ralph guard reads the same late-page PR: CI is running, not "no open PR".
  const verdict = await plant.guard(builderLabels) as { userMessage?: string } | undefined;
  assert.match(verdict?.userMessage ?? '', /CI still running on the PR head/);
});

test('P3.7: a failed, malformed or truncated read is never missing work: no cancellation, archive, status change, Builder, steer or heartbeat; the failure pages', async t => {
  const sha = 'c'.repeat(40);
  const refused = (match: string, stdout = '', stderr = 'HTTP 502: Bad Gateway (https://api.github.com/graphql)', exitCode = 1) =>
    (command: string): Shell | undefined => command.startsWith(match) ? { exitCode, stdout, stderr } : undefined;
  const envelope = (json: unknown) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(json) }] });
  const cases: { name: string; error: RegExp; guard?: RegExp; setup: (plant: ReturnType<typeof factory>) => void }[] = [
    { name: 'gh pr list fails', error: /gh pr list --state open failed: HTTP 502/, guard: /gh pr list --state open failed/, setup: plant => { plant.control.gh = refused('gh pr list --state open'); } },
    { name: 'gh pr list returns no list', error: /gh pr list --state open returned a malformed PR list/, guard: /malformed PR list/, setup: plant => { plant.control.gh = refused('gh pr list --state open', '{"message":"Bad credentials"}', '', 0); } },
    { name: 'gh pr list fills its limit', error: /filled its 1000 limit/, guard: /filled its 1000 limit/, setup: plant => { plant.prs.unshift(...Array.from({ length: 1000 }, (_, i) => otherPr(2000 + i))); } },
    { name: 'gh pr view fails', error: /gh pr view 7 failed: HTTP 502/, guard: /gh pr view 7 failed/, setup: plant => { plant.control.gh = refused('gh pr view 7 --json number'); } },
    { name: 'gh pr view drops the commits', error: /gh pr view 7 returned malformed or changed details/, guard: /malformed or changed details/, setup: plant => { plant.control.gh = refused('gh pr view 7 --json number', JSON.stringify({ number: 7, headRefName: 'met-7-x', headRefOid: sha, state: 'OPEN', statusCheckRollup: [], body: 'closes MET-7' }), '', 0); } },
    { name: 'list_comments isError', error: /linear\.list_comments returned an error/, setup: plant => { plant.control.inject = name => name === 'linear.list_comments' ? envelope({ comments: [] }) : undefined; } },
    { name: 'get_issue isError', error: /linear\.get_issue returned an error/, setup: plant => { plant.control.inject = name => name === 'linear.get_issue' ? envelope({ id: 'MET-7', status: 'Todo', labels: ['odd'], description: fullSpec }) : undefined; } },
    { name: 'list_comments without its payload', error: /linear\.list_comments returned no comments list/, setup: plant => { plant.control.inject = name => name === 'linear.list_comments' ? {} : undefined; } },
  ];
  for (const { name, error, guard, setup } of cases) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const plant = factory();
        plant.issue('MET-7', 'In Progress');
        // The MET-364 shape: an idle Builder past the stale limit whose PR is open and green.
        plant.builder('MET-7', 'idle', '2026-10-26T14:30:00.000Z');
        plant.openPr('MET-7', sha);
        setup(plant);
        await plant.start();
        // Rechecks and two more sweeps; the blind episode pages at the sweep 20 minutes in.
        await advance(21 * 60_000);
        assert.deepEqual(plant.comments.get('MET-7') ?? [], [], 'no cancellation, steer or launch-failure record');
        assert.equal(plant.threads.get('T-MET-7')!.archived, false, 'the Builder is not archived');
        assert.deepEqual([...plant.threads.keys()].filter(id => id.startsWith('T-spawned')), [], 'no role thread spawned');
        assert.deepEqual(plant.saves, [], 'no status change');
        assert.deepEqual(plant.launches, [], 'no duplicate Builder');
        assert.deepEqual(plant.steers, []);
        assert.equal(plant.heartbeats(), 0, 'a sweep whose only evaluation failed is not healthy');
        assert.equal(plant.dms.length, 1);
        const failed = (await plant.events()).filter(event => event.issue === 'MET-7');
        assert.ok(failed.length && failed.every(event => event.stage === 'failed'), 'every evaluation of MET-7 failed');
        assert.match(failed[0].error ?? '', error);
        assert.match(plant.dms[0], /^\[odd\] ODD page: control-plane-blind \| .*every sweep since 2026-10-26T15:00:00\.000Z failed: Error: all 1 evaluations failed/);
        // The Ralph guard neither continues the Builder nor tells it its PR is missing.
        if (guard) await assert.rejects(plant.guard(builderLabels), guard);
      } finally {
        mock.timers.reset();
      }
    });
  }
});

test('P3.7: an empty enumeration is healthy only when no live role thread holds an open issue, and a failed enumeration is not an empty one', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const liveBuilder = (status: string) => controlOrb((name, input) => {
    if (name === 'linear.list_issues') return { issues: [], hasNextPage: false, cursor: '' };
    if (name === 'find_thread') return /odd-role-builder|odd-issue-met-1 /.test(String(input.query)) ? { threads: [{ id: 'T-1', updatedAt: new Date().toISOString() }] } : { threads: [] };
    if (name === 'linear.get_issue') return { id: 'MET-1', status, labels: ['odd'], description: '', relations: { blockedBy: [] } };
    return undefined;
  });
  const swept = async (orb: ReturnType<typeof controlOrb>) => {
    await orb.start();
    await until(() => orb.calls.includes('linear.list_issues'));
    await settle();
    return orb.updates.length;
  };
  assert.equal(await swept(controlOrb(emptyWork)), 1, 'a valid empty, idle workspace writes its heartbeat');
  assert.equal(await swept(liveBuilder('Done')), 1, 'a live thread on a finished issue is resolved work');
  assert.equal(await swept(liveBuilder('In Progress')), 0, 'Linear listing nothing while a Builder holds an In Progress issue is a failed sweep');
  const listed = (result: unknown) => controlOrb(name => name === 'linear.list_issues' ? result : emptyWork(name));
  assert.equal(await swept(listed({ isError: true, content: [{ type: 'text', text: '{"issues":[],"hasNextPage":false}' }] })), 0, 'an isError envelope is a failed read');
  assert.equal(await swept(listed({})), 0, 'a missing issues payload is a failed read');
});
