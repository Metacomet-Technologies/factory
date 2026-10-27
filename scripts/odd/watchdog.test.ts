import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { blindMs, digest, digestDue, episodeLine, failureBudget, failureDue, incidentPageDue, incidentText, incidents, localClock, overCaps, overdueKeys, overdueLine, overduePage, parseEpisode, restoreStatus, sanitizeError, slackMessageMax, slackMessages, staleThreads, sweepMs, staleMs, type DigestInput, type Episode } from './watchdog.ts';
import { controlPlaneSilent, deployReceiptLine, heartbeatLine, parseHeartbeat, silenceMs, verifyLine } from './lifecycle.ts';
import { capacity, type Action } from './lifecycle.ts';
import { diagnosedLabel, readerLabel, receiptLabel, type LiveThread } from './snapshot.ts';
import plugin, { followUp } from '../../.amp/plugins/factory-odd.ts';
import { fakeShell } from './fixtures.ts';
import { io } from './launch.ts';
import { createHmac } from 'node:crypto';

// No test arms with the host's injected webhook secrets: each plugin load sees only the synthetic environment it is given.
const secretNames = ['ODD_GITHUB_WEBHOOK_SECRET', 'ODD_LINEAR_WEBHOOK_SECRET'] as const;
for (const name of secretNames) delete process.env[name];

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
  const spawned: string[] = [];
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
      case 'linear.list_comments': return { comments: [], hasNextPage: false };
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
      // `override('$', { command })` may answer a shell command with its stdout.
      $: fakeShell(command => override('$', { command }) as string | undefined).$,
      createAgent: () => ({ definition: {}, createThread: async () => ({ id: `T-spawned-${spawned.length + 1}`, setLabels: async () => {}, appendUserMessage: async (message: { content: string }) => { spawned.push(message.content); } }) }), registerAgentMode: () => {}, registerTool: (tool: typeof status) => { status = tool; },
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, handler); },
      createWebhook: async (options: Record<string, unknown>) => (await override('createWebhook', options)) ?? { url: 'https://hooks.example/x' },
      system: { executor: { kind: 'remote', keepAlive: async () => {} } },
    };
    await (plugin as unknown as (api: unknown) => Promise<void>)(amp);
    const thread = { id: 'T-control', labels: async () => (await override('thread.labels', {})) ?? ['odd-control-plane', 'odd-perform'] };
    const ctx = { thread, ui: { confirm: async () => true, notify: async () => {} }, logger: { log: () => {} }, tools };
    await handlers.get('session.start')!({}, ctx);
    return async (input: Record<string, unknown>) => JSON.parse(await status!.execute(input, ctx)) as { armed: boolean; error?: string; slack: { error?: string } };
  };
  return { start, evaluated, spawned, alerts, dms, calls, updates, reads: () => alertReads };
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

// MET-385: the error Amp's get_thread_status rejects with when its open-dialog read times out under load.
const dialogTimeout = () => Promise.reject(new Error('Could not read whether the thread is blocked on a question for the user: Timed out reading the thread\'s open dialogs after 10000ms. Retry get_thread_status.'));
const statusEnvelope = { isError: true, content: [{ type: 'text', text: 'Timed out reading the thread\'s open dialogs after 10000ms. Retry get_thread_status.' }] };
/** Resolves `answer()` only after every read already in flight has settled: a late, reordered result. */
const late = async (answer: () => unknown) => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); return answer(); };
type Watchdog = { sweptAt?: string; error?: string; blindSince?: string; paged?: boolean };

/**
 * MET-385: Builders T-1 and T-2 hold finished issues MET-1 and MET-2, so an evaluation that reads them archives each.
 * `t2(n)` may answer T-2's nth get_thread_status read; undefined keeps the valid status. `extra` may answer any other call first.
 */
function flakyPlane(t2: (read: number) => unknown, extra: (name: string, input: Record<string, unknown>) => unknown = () => undefined) {
  let reads = 0;
  const archived: string[] = [];
  const orb = controlOrb((name, input) => {
    const answered = extra(name, input);
    if (answered !== undefined) return answered;
    switch (name) {
      case 'linear.list_issues': return { issues: [], hasNextPage: false, cursor: '' };
      case 'find_thread': {
        const query = String(input.query);
        return { threads: ['1', '2'].filter(n => query === 'label:odd-role-builder archived:false' || query === `label:odd-issue-met-${n} archived:false`).map(n => ({ id: `T-${n}` })) };
      }
      case 'get_thread_status': return input.thread === 'T-2' ? t2(++reads) : undefined;
      case 'update_thread': archived.push(String(input.thread)); return {};
      default: return undefined;
    }
  });
  const watchdog = async (status: Awaited<ReturnType<typeof orb.start>>) => ((await status({})) as unknown as { watchdog: Watchdog }).watchdog;
  return { ...orb, archived, watchdog };
}

test('MET-385: a get_thread_status rejection that a retry answers leaves the sweep whole: every thread is acted on and the heartbeat persists', async t => {
  const cases: [string, (read: number) => unknown][] = [
    ['healthy control', () => undefined],
    ['one timeout at role enumeration', read => (read === 1 ? dialogTimeout() : undefined)],
    ['one timeout during an issue evaluation', read => (read === 2 ? dialogTimeout() : undefined)],
    ['two timeouts in a row on one read', read => (read <= 2 ? dialogTimeout() : undefined)],
    ['timeouts on two different reads', read => (read === 1 || read === 3 ? dialogTimeout() : undefined)],
    ['an MCP error envelope once', read => (read === 1 ? statusEnvelope : undefined)],
    ['a late timeout, then a late valid answer', read => (read === 1 ? late(dialogTimeout) : read === 2 ? late(() => undefined) : undefined)],
  ];
  for (const [name, t2] of cases) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
      try {
        const orb = flakyPlane(t2);
        const status = await orb.start();
        await until(() => orb.updates.length === 1);
        await settle();
        assert.deepEqual(orb.updates.map(update => update.body), [heartbeatLine('2026-10-24T15:00:00.000Z')], 'one row, this sweep');
        assert.deepEqual([...orb.archived].sort(), ['T-1', 'T-2'], 'both finished threads are archived on complete reads');
        const watchdog = await orb.watchdog(status);
        assert.equal(watchdog.error, undefined);
        assert.equal(watchdog.blindSince, undefined);
      } finally {
        mock.timers.reset();
      }
    });
  }
});

test('MET-385: a status read that keeps failing withholds the heartbeat and every effect resting on it; the next wholly successful scheduled sweep updates the same row and ends blindness', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  t.after(() => mock.timers.reset());
  let mode: 'ok' | 'timeout' | 'timeout-once' | 'malformed-then-valid' = 'ok';
  let malformed = false;
  let writeFails = false;
  const orb = flakyPlane(() => {
    if (mode === 'timeout') return new Promise((_, reject) => setTimeout(() => dialogTimeout().catch(reject), 10_000));
    if (mode === 'timeout-once') { mode = 'ok'; return dialogTimeout(); }
    if (mode === 'malformed-then-valid' && !malformed) { malformed = true; return { metadata: { labels: ['odd-issue-met-2', 'odd-role-builder', 'odd-round-1'] } }; }
    return undefined;
  }, name => (name === 'linear.save_status_update' && writeFails ? Promise.reject(new Error('Linear 500')) : undefined));
  const status = await orb.start();
  await until(() => orb.updates.length === 1);
  await settle();
  const [{ id }] = orb.updates;
  const body = (at: string) => assert.deepEqual(orb.updates, [{ id, body: heartbeatLine(at) }], `the one row holds ${at}`);
  body('2026-10-24T15:00:00.000Z');
  const archives = orb.archived.length;

  // 15:10 and 15:20: T-2 times out on every attempt, each after Amp's 10 s. The enumeration is incomplete: nothing is
  // evaluated, archived or written. The failed sweep releases its exclusion, so the next scheduled sweep still runs.
  mode = 'timeout';
  await advance(sweepMs + 60_000, 5_000);
  let watchdog = await orb.watchdog(status);
  assert.equal(watchdog.sweptAt, '2026-10-24T15:10:00.000Z');
  assert.match(watchdog.error ?? '', /Timed out reading the thread's open dialogs/);
  assert.equal(watchdog.blindSince, '2026-10-24T15:10:00.000Z');
  await advance(sweepMs, 5_000);
  watchdog = await orb.watchdog(status);
  assert.equal(watchdog.sweptAt, '2026-10-24T15:20:00.000Z', 'the 15:20 sweep ran: no sweep is left holding the exclusion');
  assert.match(watchdog.error ?? '', /Timed out reading the thread's open dialogs/);
  assert.equal(watchdog.blindSince, '2026-10-24T15:10:00.000Z', 'the episode continues');
  assert.equal(orb.archived.length, archives, 'no archive on an incomplete read');
  assert.deepEqual(orb.dms, [], 'no page 10 minutes into the episode');
  body('2026-10-24T15:00:00.000Z');
  const persisted = Date.parse(parseHeartbeat(orb.updates[0].body)!);
  assert.equal(controlPlaneSilent([orb.updates[0].body], persisted + silenceMs - 1), false, 'the backstop skips 1 ms before 20 minutes');
  assert.equal(controlPlaneSilent([orb.updates[0].body], persisted + silenceMs), true, 'and resumes at exactly 20 minutes');
  assert.equal(controlPlaneSilent([orb.updates[0].body], persisted + silenceMs + 1), true);
  assert.equal(controlPlaneSilent([], persisted), true, 'and when the row is missing');

  // 15:30: a malformed status is not retried into a valid one; the sweep fails again, and 20 minutes blind pages once.
  mode = 'malformed-then-valid';
  await advance(sweepMs, 5_000);
  await until(() => malformed && orb.dms.length === 1);
  await settle();
  watchdog = await orb.watchdog(status);
  assert.match(watchdog.error ?? '', /get_thread_status T-2 returned no labels or agent state/);
  assert.match(orb.dms[0], /control-plane-blind \| .*every sweep since 2026-10-24T15:10:00\.000Z failed/);
  assert.equal(orb.archived.length, archives);
  body('2026-10-24T15:00:00.000Z');

  // 15:40: one timeout that a retry answers, but the heartbeat write fails. No false recovery.
  mode = 'timeout-once';
  writeFails = true;
  await advance(sweepMs, 5_000);
  await until(() => mode === 'ok');
  await settle();
  watchdog = await orb.watchdog(status);
  assert.match(watchdog.error ?? '', /Linear 500/);
  assert.equal(watchdog.blindSince, '2026-10-24T15:10:00.000Z');
  assert.equal(watchdog.paged, true);
  body('2026-10-24T15:00:00.000Z');

  // 15:50: every read and the write succeed. The same row advances; blindness ends without a reload.
  writeFails = false;
  await advance(sweepMs, 5_000);
  await until(() => orb.updates[0].body.includes('15:50'));
  await settle();
  body('2026-10-24T15:50:00.000Z');
  watchdog = await orb.watchdog(status);
  assert.equal(watchdog.error, undefined);
  assert.equal(watchdog.blindSince, undefined);
  assert.equal(watchdog.paged, false);
  assert.equal(controlPlaneSilent([orb.updates[0].body], Date.now()), false, 'the recovered row is fresh to the backstop');
  assert.equal(orb.dms.length, 1, 'one page per episode');
});

test('MET-385: after a reload the existing heartbeat row is found on a later page; a failing later page or a status timeout creates no second row, and recovery updates the same row', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  t.after(() => mock.timers.reset());
  let pageTwo: 'fails' | 'ok' = 'fails';
  let lookups = 0;
  const orb = flakyPlane(() => (Date.now() < Date.parse('2026-10-24T15:10:00Z') ? dialogTimeout() : undefined), (name, input) => {
    if (name !== 'linear.get_status_updates') return undefined;
    lookups += 1;
    // Newest first: other project updates fill page 1; the heartbeat row is on page 2, after an older unrelated row.
    if (!input.cursor) return { statusUpdates: [{ id: 'weekly-2', body: 'weekly update' }, { id: 'weekly-1', body: 'kickoff' }], hasNextPage: true, cursor: 'p2' };
    if (pageTwo === 'fails') return Promise.reject(new Error('Linear 502'));
    return { statusUpdates: [{ id: 'old', body: 'notes' }, ...orb.updates], hasNextPage: false, cursor: '' };
  });
  // The row the previous plugin load wrote; this load has forgotten its id.
  orb.updates.push({ id: 'row-1', body: heartbeatLine('2026-10-24T14:50:00.000Z') });
  const status = await orb.start();
  // 15:00: the first enumeration read of T-2 times out on every attempt; nothing is looked up or written.
  await settle();
  assert.equal(lookups, 0, 'a failed derivation never reaches the heartbeat lookup');
  assert.match((await orb.watchdog(status)).error ?? '', /Timed out reading the thread's open dialogs/);
  // 15:10: every read succeeds but the lookup's second page fails: no new row and no recovery.
  mock.timers.tick(sweepMs);
  await until(() => lookups >= 2);
  await settle();
  assert.deepEqual(orb.updates, [{ id: 'row-1', body: heartbeatLine('2026-10-24T14:50:00.000Z') }]);
  let watchdog = await orb.watchdog(status);
  assert.match(watchdog.error ?? '', /Linear 502/);
  assert.equal(watchdog.blindSince, '2026-10-24T15:00:00.000Z');
  // 15:20: the lookup reaches page 2 and updates the same row.
  pageTwo = 'ok';
  mock.timers.tick(sweepMs);
  await until(() => orb.updates[0].body.includes('15:20'));
  await settle();
  assert.deepEqual(orb.updates, [{ id: 'row-1', body: heartbeatLine('2026-10-24T15:20:00.000Z') }]);
  watchdog = await orb.watchdog(status);
  assert.equal(watchdog.error, undefined);
  assert.equal(watchdog.blindSince, undefined);
  // 15:30: the id is kept; the row advances again without another lookup.
  const looked = lookups;
  mock.timers.tick(sweepMs);
  await until(() => orb.updates[0].body.includes('15:30'));
  assert.deepEqual(orb.updates, [{ id: 'row-1', body: heartbeatLine('2026-10-24T15:30:00.000Z') }]);
  assert.equal(lookups, looked);
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

type Pr = { number: number; headRefName: string; headRefOid: string; state: 'OPEN' | 'MERGED'; mergeCommit: { oid: string } | null; mergedAt?: string; mergeable: string; commits: { oid: string; committedDate: string }[]; statusCheckRollup: Record<string, unknown>[]; body: string };
type Shell = { exitCode: number; stdout: string; stderr: string };

/**
 * GitHub behind `gh pr list` and `gh pr view <n> --json`: rows carry only the requested fields,
 * newest first, cut at `--limit`. gh reads at most 100 PRs per GraphQL page and `commits` asks
 * for 100 commits × 100 authors per PR, so a page over GitHub's 500,000-node bound is refused
 * with GitHub's own error (the full-field `--limit 100` list asked for 1,000,000). Other
 * commands are left to the caller.
 */
function github(command: string, prs: readonly Pr[], releases: ReadonlyMap<string, readonly string[]> = new Map()): Shell | undefined {
  // `gh api repos/{owner}/{repo}/compare/<base>...<head>`: `ahead` when the head release contains the base.
  const compare = /^gh api repos\/\{owner\}\/\{repo\}\/compare\/([0-9a-f]{7,40})\.\.\.([0-9a-f]{7,40}) --jq \.status$/.exec(command);
  if (compare) return { exitCode: 0, stdout: `${compare[1] === compare[2] ? 'identical' : releases.get(compare[2])?.includes(compare[1]) ? 'ahead' : 'diverged'}\n`, stderr: '' };
  // `gh api repos/{owner}/{repo}/commits/<sha>`: one commit, from any PR's full history.
  const commit = /^gh api repos\/\{owner\}\/\{repo\}\/commits\/([0-9a-f]{40}) --jq \.commit\.committer\.date$/.exec(command);
  if (commit) {
    const found = prs.flatMap(pr => pr.commits).find(candidate => candidate.oid === commit[1]);
    return found ? { exitCode: 0, stdout: `${found.committedDate}\n`, stderr: '' } : { exitCode: 1, stdout: '', stderr: 'gh: No commit found for SHA (HTTP 422)' };
  }
  // `gh pr view <n> --json isDraft --jq .isDraft`: the fixture's PRs are ready for review.
  const draft = /^gh pr view (\d+) --json isDraft --jq \.isDraft$/.exec(command);
  if (draft) return prs.some(pr => pr.number === Number(draft[1])) ? { exitCode: 0, stdout: 'false\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${draft[1]}.` };
  const view = /^gh pr view (\d+) --json ([\w,]+)$/.exec(command);
  const list = /^gh pr list (?:--search "([^"]+)" )?--state (open|merged) --json ([\w,]+) --limit (\d+)$/.exec(command);
  if (!view && !list) return undefined;
  const fields = (view ? view[2] : list![3]).split(',');
  const nodes = (view ? 1 : Math.min(Number(list![4]), 100)) * (fields.includes('commits') ? 100 * 100 : 1);
  if (nodes > 500_000) return { exitCode: 1, stdout: '', stderr: `GraphQL: By the time this query traverses to the authors connection, it is requesting up to ${nodes.toLocaleString('en-US')} possible nodes which exceeds the maximum limit of 500,000.` };
  // gh requests `commits(first: 100)` and does not paginate it.
  const row = (pr: Pr) => Object.fromEntries(fields.map(field => [field, field === 'commits' ? pr.commits.slice(0, 100) : pr[field as keyof Pr]]));
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
  /** Deployed revision → the merge commits it contains, for GitHub's compare. */
  const releases = new Map<string, string[]>();
  const threads = new Map<string, { labels: string[]; state: string; archived: boolean; updatedAt: string }>();
  const dms: string[] = [];
  const steers: string[] = [];
  // P4.1: `launch` lets a builder launch succeed; `indexLag` hides new threads from thread search until `index()`; `ambiguous` creates the thread, unlabelled, and then fails the call; `bindFailures` fails that many `odd-spawn` bindings.
  const control = { slackDown: 0, spawnFails: false, steerFailures: 0, refuse: '', unreadable: '', indexLag: false, ambiguous: false, bindFailures: 0, launch: false, gh: undefined as ((command: string) => Shell | undefined) | undefined, inject: undefined as ((name: string, input: Record<string, unknown>) => unknown) | undefined };
  /** Threads thread search does not return yet, and every create call the plane made (plugin agents and builder launches). */
  const hidden = new Set<string>();
  const creates: string[] = [];
  /** The outcome message each plugin-agent thread was started with. */
  const outcomes = new Map<string, string>();
  /** Lifecycle mutations: status writes, builder launches and heartbeats (comments, archives, steers and DMs are kept above). */
  const saves: string[] = [];
  const launches: string[] = [];
  let heartbeats = 0;
  // No fixture starts a live `amp` builder; an attempt is recorded and fails.
  // With `control.launch`, a launch prints the child's session_id and the child runs with the labels it was given (`--label`).
  let children = 0;
  mock.method(io, 'start', (argv: readonly string[]) => {
    launches.push(argv.join(' '));
    creates.push('builder');
    if (!control.launch) throw new Error('fixture: no live launch');
    const id = `T-00000000-0000-4000-8000-${String(++children).padStart(12, '0')}`;
    threads.set(id, { labels: argv.flatMap((value, i) => (argv[i - 1] === '--label' ? [value] : [])), state: 'running', archived: false, updatedAt: new Date().toISOString() });
    if (control.indexLag) hidden.add(id);
    return { lines: (async function* () { yield JSON.stringify({ type: 'system', session_id: id }); })(), stderr: () => '', kill: () => {} };
  });
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
      case 'linear.list_comments': {
        // Newest first, `limit` per page; each page repeats the previous page's last comment, as overlapping pages can.
        const all = [...(comments.get(String(input.issueId)) ?? [])].reverse();
        const from = Number(input.cursor ?? 0);
        const to = from + Number(input.limit ?? 50);
        return { comments: all.slice(from, to), hasNextPage: to < all.length, cursor: String(to - 1) };
      }
      case 'linear.save_comment': {
        if (control.bindFailures > 0 && /^odd-spawn .* thread=T-/.test(String(input.body))) { control.bindFailures -= 1; throw new Error('Linear 503'); }
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
        // Like Amp's thread search, archived threads are left out only when the query says `archived:false`.
        const label = /label:(\S+)/.exec(String(input.query))?.[1] ?? '';
        const live = String(input.query).includes('archived:false');
        return { threads: [...threads].filter(([id, thread]) => !hidden.has(id) && !(live && thread.archived) && thread.labels.includes(label)).map(([id, thread]) => ({ id, updatedAt: thread.updatedAt })) };
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
    return control.gh?.(command) ?? github(command, prs, releases) ?? shell(strings, ...values);
  };
  let created = 0;
  const amp = (mine: number) => ({
    $,
    createAgent: (config: unknown) => ({ definition: config, createThread: async () => {
      creates.push('plugin');
      if (control.spawnFails) throw new Error('Orb custom agents must be registered as an active agent mode');
      const id = `T-spawned-${++created}`;
      threads.set(id, { labels: [], state: 'running', archived: false, updatedAt: new Date().toISOString() });
      if (control.indexLag) hidden.add(id);
      if (control.ambiguous) throw new Error('fetch failed: socket hang up');
      return { id, setLabels: async (labels: string[]) => { threads.get(id)!.labels = labels; }, appendUserMessage: async (message: { content: string }) => { outcomes.set(id, message.content); } };
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
  let said = 0;
  const openPr = (issue: string, sha: string, over: Partial<Pr> = {}) => {
    const n = Number(issue.slice(4));
    prs.push({ number: n, headRefName: `${issue.toLowerCase()}-x`, headRefOid: sha, state: 'OPEN', mergeCommit: null, mergeable: 'MERGEABLE', commits: [{ oid: sha, committedDate: new Date().toISOString() }], statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], body: `closes ${issue}`, ...over });
  };
  return {
    issues, comments, prs, releases, threads, dms, steers, control, builder, openPr, saves, launches, hidden, creates, outcomes, heartbeats: () => heartbeats, slackAttempts: () => slackAttempts,
    /** Thread search catches up with every hidden thread. */
    index: () => hidden.clear(),
    /** The `odd-spawn` lines on an issue, oldest first. */
    spawnLines: (id: string) => (comments.get(id) ?? []).filter(comment => comment.body.startsWith('odd-spawn ')).map(comment => comment.body),
    /** The latest plugin load's `odd_control_status`: its handled events. */
    events: async () => (JSON.parse(await statuses.get(generation)!({}, { thread: { id: 'T-control', labels: async () => ['odd-control-plane', 'odd-perform'] } })) as { events: { issue: string | null; stage: string; error?: string }[] }).events,
    /** An `odd_control_status sweep: true` call on the latest plugin load, as a human or the control thread makes it. */
    sweep: () => statuses.get(generation)!({ sweep: true }, { thread: { id: 'T-control', labels: async () => ['odd-control-plane', 'odd-perform'] }, ui: { confirm: async () => true, notify: async () => {} }, logger: { log: () => {} }, tools }),
    /** The Ralph guard as the latest plugin load runs it at the end of a role thread's turn. */
    guard: (labels: string[]) => ends.get(generation)!({ status: 'done', message: '', thread: { id: 'T-role' } }, { thread: { id: 'T-role', labels: async () => labels }, ui: { confirm: async () => true, notify: async () => {} }, logger: { log: () => {} }, tools, $ }),
    /** A comment one second after the previous planted one, so creation order is unambiguous. */
    say: (issue: string, body: string) => comments.set(issue, [...(comments.get(issue) ?? []), { id: `said-${++said}`, body, createdAt: new Date(Date.parse('2026-10-26T12:00:00Z') + said * 1000).toISOString() }]),
    issue: (id: string, status: string) => issues.set(id, { id, status, labels: ['odd', 'Bug', 'area:agents'], description: fullSpec }),
    episodes: (id: string) => (comments.get(id) ?? []).filter(comment => comment.body.startsWith('odd-failure')).map(comment => comment.body.split('\n')[0]),
    /** `load` is the plugin's default export; pass a freshly imported module to model a control-orb restart that drops module state. */
    async start(load: unknown = plugin) {
      const mine = ++generation;
      await (load as (api: unknown) => Promise<void>)(amp(mine));
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
  assert.match(page, /spawn-reviewer failing since 2026-10-26T15:00:00\.000Z \(\d+ min, \d+ attempts\): Error: Orb custom agents must be registered as an active agent mode \(odd-spawn role=reviewer round=1 key=reviewer-[ab]{12} thread=pending stays pending: .*\)\./);
  assert.match(page, /Occupied build slots 2\/2: MET-364, MET-368\. Ready work waiting for a build slot: MET-379\./);
  assert.match(page, /Needed: make the reviewer startable/);
  assert.match(plant.episodes('MET-364')[0], /state=open alert=plane-blocked$/);

  // Another reload and more sweeps: delivered stays delivered.
  await plant.start();
  await advance(20 * 60_000);
  assert.equal(plant.dms.length, 1);

  // P4.1: a failed create is never retried blind; each issue made one create call and holds a pending record.
  assert.equal(plant.creates.length, 2, 'one create per issue across every recheck, sweep and reload');
  assert.deepEqual(plant.spawnLines('MET-364'), ['odd-spawn role=reviewer round=1 key=reviewer-aaaaaaaaaaaa thread=pending']);

  // Recovery: the reviewer can spawn again, and Devon removes the unconfirmed records. Both issues advance; one resolution closes the incident.
  plant.control.spawnFails = false;
  for (const id of ['MET-364', 'MET-368']) plant.comments.set(id, plant.comments.get(id)!.filter(comment => !comment.body.startsWith('odd-spawn ')));
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

test('P3.7: open-PR discovery stays under GitHub\'s node bound, finds an owned PR past the first 100 with the time of a head past its first 100 commits, and an open PR wins over a merged one', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  const sha = 'f'.repeat(40);
  plant.issue('MET-7', 'In Progress');
  plant.builder('MET-7');
  // A comment with an empty body is a valid row.
  plant.comments.set('MET-7', [{ id: 'c-0', body: '', createdAt: '2026-10-26T14:00:00.000Z' }]);
  // An earlier merged PR of MET-7 must not win over its open PR (that would move MET-7 to Deploying).
  plant.prs.push({ ...otherPr(6), headRefName: 'met-7-first-try', state: 'MERGED', mergeCommit: { oid: '9'.repeat(40) }, mergedAt: '2026-10-25T12:00:00Z', body: 'closes MET-7' });
  for (let n = 1000; n < 1140; n++) plant.prs.push(otherPr(n));
  // The owned open PR is the 141st open PR, past gh's first 100-PR page; CI is still running.
  // Its head is commit 150, past the 100 commits gh reads with a PR.
  const history = Array.from({ length: 149 }, (_, i) => ({ oid: (i + 1).toString(16).padStart(40, '0'), committedDate: '2026-10-26T13:00:00Z' }));
  plant.openPr('MET-7', sha, { statusCheckRollup: [{ name: 'ci', conclusion: '', status: 'IN_PROGRESS' }], commits: [...history, { oid: sha, committedDate: '2026-10-26T13:30:00Z' }] });
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
    { name: 'gh pr view drops the checks', error: /gh pr view 7 returned malformed or changed details/, guard: /malformed or changed details/, setup: plant => { plant.control.gh = refused('gh pr view 7 --json number', JSON.stringify({ number: 7, headRefName: 'met-7-x', headRefOid: sha, state: 'OPEN', body: 'closes MET-7' }), '', 0); } },
    // Review of aeae4e3: list rows missing their ownership fields hid the owning PR.
    { name: 'gh pr list rows lack ownership fields', error: /gh pr list --state open returned a malformed PR list/, guard: /malformed PR list/, setup: plant => { plant.control.gh = refused('gh pr list --state open', '[{"number":7}]', '', 0); } },
    { name: 'the head commit time is unreadable', error: /gh api head commit c{40} failed: HTTP 502/, guard: /gh api head commit c{40} failed/, setup: plant => { plant.control.gh = refused('gh api '); } },
    { name: 'the head commit time is malformed', error: /gh api head commit c{40} returned no commit time/, guard: /returned no commit time/, setup: plant => { plant.control.gh = refused('gh api ', 'null\n', '', 0); } },
    // An unknown execution state is not idleness: the Builder may be running.
    { name: 'thread status without agent state', error: /get_thread_status T-MET-7 returned no labels or agent state/, setup: plant => {
      // A running Builder with no PR yet and an old search timestamp: only its state keeps it from looking stale.
      plant.threads.get('T-MET-7')!.state = 'running';
      plant.prs.length = 0;
      plant.control.inject = (name, input) => name === 'get_thread_status' && input.thread === 'T-MET-7' ? { metadata: { labels: plant.threads.get('T-MET-7')!.labels, archived: false } } : undefined; } },
    { name: 'list_comments isError', error: /linear\.list_comments returned an error/, setup: plant => { plant.control.inject = name => name === 'linear.list_comments' ? envelope({ comments: [] }) : undefined; } },
    { name: 'get_issue isError', error: /linear\.get_issue returned an error/, setup: plant => { plant.control.inject = name => name === 'linear.get_issue' ? envelope({ id: 'MET-7', status: 'Todo', labels: ['odd'], description: fullSpec }) : undefined; } },
    // Re-review of 91d176c, and the same boundaries' equivalent omissions.
    { name: 'a comment row without a body', error: /linear\.list_comments returned a malformed comments row at 0/, setup: plant => { plant.control.inject = name => name === 'linear.list_comments' ? { comments: [{}] } : undefined; } },
    { name: 'a null comment row', error: /linear\.list_comments returned a malformed comments row at 0/, setup: plant => { plant.control.inject = name => name === 'linear.list_comments' ? { comments: [null] } : undefined; } },
    { name: 'get_issue with an empty id', error: /linear\.get_issue MET-7 returned a malformed issue/, setup: plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, id: '', relations: { blockedBy: [] } } : undefined; } },
    { name: 'get_issue with an empty status', error: /linear\.get_issue MET-7 returned a malformed issue/, setup: plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, status: '', relations: { blockedBy: [] } } : undefined; } },
    { name: 'get_issue with a whitespace status', error: /linear\.get_issue MET-7 returned a malformed issue/, setup: plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, status: '  ', relations: { blockedBy: [] } } : undefined; } },
    { name: 'get_issue without labels', error: /linear\.get_issue MET-7 returned a malformed issue/, setup: plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, labels: undefined, relations: { blockedBy: [] } } : undefined; } },
    { name: 'a blocker without an id', error: /linear\.get_issue MET-7 returned a malformed issue/, setup: plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, relations: { blockedBy: [{}] } } : undefined; } },
    { name: 'a thread search row without an id', error: /find_thread returned a malformed threads row at 0/, setup: plant => { plant.control.inject = name => name === 'find_thread' ? { threads: [{ updatedAt: '2026-10-26T14:30:00.000Z' }] } : undefined; } },
    // MET-385: a status read that times out on every attempt, or returns an MCP error each time, is not idleness either.
    { name: 'thread status that times out on every attempt', error: /Timed out reading the thread's open dialogs after 10000ms/, setup: plant => {
      plant.threads.get('T-MET-7')!.state = 'running';
      plant.prs.length = 0;
      plant.control.inject = (name, input) => name === 'get_thread_status' && input.thread === 'T-MET-7' ? dialogTimeout() : undefined; } },
    { name: 'thread status that is an MCP error on every attempt', error: /get_thread_status returned an error: Timed out/, setup: plant => { plant.control.inject = (name, input) => name === 'get_thread_status' && input.thread === 'T-MET-7' ? statusEnvelope : undefined; } },
    { name: 'thread labels that are not strings', error: /get_thread_status T-MET-7 returned no labels or agent state/, setup: plant => { plant.control.inject = (name, input) => name === 'get_thread_status' && input.thread === 'T-MET-7' ? { metadata: { labels: [null], archived: false }, agentState: { state: 'idle' } } : undefined; } },
    { name: 'a merged PR without its merge commit', error: /gh pr view 7 returned malformed or changed details for merged MET-7/, guard: /malformed or changed details for merged/, setup: plant => { plant.prs[0] = { ...plant.prs[0], state: 'MERGED', mergeCommit: null, mergedAt: '2026-10-26T14:00:00Z' }; } },
    // Re-review of 223e4f5, and the same boundaries' equivalent omissions.
    ...([['omitted', undefined], ['empty', {}], ['with a null blocker list', { blockedBy: null }]] as const).map(([how, relations]) => ({ name: `get_issue with requested relations ${how}`, error: /linear\.get_issue MET-7 returned a malformed issue/, setup: (plant: ReturnType<typeof factory>) => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, relations } : undefined; } })),
    { name: 'a check record without its fields', error: /gh pr view 7 returned malformed or changed details for open MET-7/, guard: /malformed or changed details/, setup: plant => { plant.prs[0].statusCheckRollup = [{}]; } },
    { name: 'a check record with a numeric conclusion', error: /gh pr view 7 returned malformed or changed details for open MET-7/, guard: /malformed or changed details/, setup: plant => { plant.prs[0].statusCheckRollup = [{ name: 'ci', conclusion: 1 }]; } },
    { name: 'a status context without its state', error: /gh pr view 7 returned malformed or changed details for open MET-7/, guard: /malformed or changed details/, setup: plant => { plant.prs[0].statusCheckRollup = [{ __typename: 'StatusContext', context: 'buildkite' }]; } },
    { name: 'a merged PR with an unusable merge time', error: /gh pr view 7 returned malformed or changed details for merged MET-7/, guard: /malformed or changed details for merged/, setup: plant => { plant.prs[0] = { ...plant.prs[0], state: 'MERGED', mergeCommit: { oid: '9'.repeat(40) }, mergedAt: 'not-a-date' }; } },
    { name: 'a thread search page with a malformed cursor', error: /find_thread returned a malformed nextCursor/, setup: plant => { plant.control.inject = name => name === 'find_thread' ? { threads: [], nextCursor: 7 } : undefined; } },
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
        const events = await plant.events();
        assert.ok(events.filter(event => event.issue === 'MET-7').every(event => event.stage === 'failed'), 'no evaluation of MET-7 succeeded');
        assert.ok(events.some(event => event.stage === 'failed' && error.test(event.error ?? '')), 'the read error is recorded');
        assert.match(plant.dms[0], /^\[odd\] ODD page: control-plane-blind \| .*every sweep since 2026-10-26T15:00:00\.000Z failed: /);
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
  assert.equal(await swept(listed({ issues: [{}], hasNextPage: false })), 0, 'an issue row without an identifier is a failed read, not an empty workspace');
  assert.equal(await swept(listed({ issues: [{ id: '' }], hasNextPage: false })), 0);
  assert.equal(await swept(listed({ issues: [{ id: 'MET-9' }], hasNextPage: true })), 0, 'a next page without a cursor is an incomplete read');
  assert.equal(await swept(listed({ issues: [] })), 0, 'a page without hasNextPage is an incomplete read');
});

test('P3.7: any failed derivation withholds the sweep heartbeat even when other issues evaluate; a failed action does not', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = (unreadable: boolean) => {
    const it = factory();
    for (const id of ['MET-7', 'MET-8']) {
      it.issue(id, 'In Progress');
      it.builder(id, 'running');
      it.openPr(id, id === 'MET-7' ? 'c'.repeat(40) : 'd'.repeat(40), { statusCheckRollup: [{ name: 'ci', conclusion: '', status: 'IN_PROGRESS' }] });
    }
    if (unreadable) it.control.inject = (name, input) => name === 'linear.get_issue' && input.id === 'MET-7' ? { isError: true, content: [{ type: 'text', text: '{"id":"MET-7","status":"Todo"}' }] } : undefined;
    return it;
  };
  const mixed = plant(true);
  await mixed.start();
  await advance(21 * 60_000);
  const events = await mixed.events();
  assert.ok(events.some(event => event.issue === 'MET-8' && event.stage !== 'failed'), 'MET-8 evaluates normally');
  assert.equal(mixed.heartbeats(), 0, 'one failed authoritative read keeps every sweep from looking healthy');
  assert.ok(events.some(event => event.issue === null && event.stage === 'failed' && /1 of 2 evaluations failed/.test(event.error ?? '')));
  assert.match(mixed.dms.join('\n'), /ODD page: action-failed \| issue MET-7 \| .*linear\.get_issue returned an error/, 'the failing issue pages its own incident');
  assert.doesNotMatch(mixed.dms.join('\n'), /control-plane-blind/, 'a partly failing sweep is not a blind plane');

  // Control: every read succeeds, and only an action fails (no reviewer can spawn): the sweep stays healthy.
  const refusing = factory();
  refusing.issue('MET-8', 'In Progress');
  refusing.builder('MET-8');
  refusing.openPr('MET-8', 'd'.repeat(40));
  refusing.control.spawnFails = true;
  await refusing.start();
  await advance(21 * 60_000);
  assert.ok(refusing.heartbeats() >= 3, 'a failed action keeps the heartbeat');
  assert.match(refusing.dms.join('\n'), /ODD page: action-failed \| issue MET-8 \| .*spawn-reviewer failing/);
});

test('P3.7: a malformed comment or issue read on a Todo issue launches no Builder and writes no heartbeat; valid reads launch one', async t => {
  const payloads: [string, (plant: ReturnType<typeof factory>) => void][] = [
    ['valid (control)', () => {}],
    ['comments [{}]', plant => { plant.control.inject = name => name === 'linear.list_comments' ? { comments: [{}] } : undefined; }],
    ['id ""', plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, id: '', relations: { blockedBy: [] } } : undefined; }],
    ['status ""', plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, status: '', relations: { blockedBy: [] } } : undefined; }],
    ['relations omitted', plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))! } : undefined; }],
    ['relations {}', plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, relations: {} } : undefined; }],
    ['blockedBy null', plant => { plant.control.inject = (name, input) => name === 'linear.get_issue' ? { ...plant.issues.get(String(input.id))!, relations: { blockedBy: null } } : undefined; }],
    // Control: an open blocker holds a valid issue back, and the sweep stays healthy.
    ['valid, blocked by an open issue (control)', plant => {
      // The blocker is not an ODD issue, so the sweep does not work it.
      plant.issues.set('MET-8', { id: 'MET-8', status: 'In Progress', labels: [], description: '' });
      plant.control.inject = (name, input) => name === 'linear.get_issue' && input.id === 'MET-7' ? { ...plant.issues.get('MET-7')!, relations: { blockedBy: [{ id: 'MET-8' }] } } : undefined;
    }],
  ];
  for (const [name, inject] of payloads) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const plant = factory();
        plant.issue('MET-7', 'Todo');
        inject(plant);
        await plant.start();
        await settle();
        const valid = name.startsWith('valid');
        const blocked = name.includes('blocked by');
        // The fixture's launcher refuses every launch, so the valid control records one attempt.
        assert.equal(plant.launches.length, valid && !blocked ? 1 : 0, valid && !blocked ? 'a valid Todo issue launches its Builder' : 'no Builder launch');
        assert.equal(plant.heartbeats(), valid ? 1 : 0);
        assert.deepEqual(plant.saves, []);
      } finally {
        mock.timers.reset();
      }
    });
  }
});

test('P3.7: the heartbeat lookup needs every row\'s id and body; a malformed lookup writes no new heartbeat row', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const writes = async (page: unknown) => {
    const saved: Record<string, unknown>[] = [];
    const orb = controlOrb((name, input) => {
      if (name === 'linear.get_status_updates') return page;
      if (name === 'linear.save_status_update') { saved.push(input); return { id: String(input.id ?? 'update-new') }; }
      return emptyWork(name);
    });
    await orb.start();
    await until(() => orb.calls.includes('linear.get_status_updates'));
    await settle();
    return saved.map(input => input.id ?? 'new');
  };
  assert.deepEqual(await writes({ statusUpdates: [], hasNextPage: false }), ['new'], 'no row yet: the first heartbeat row is created');
  assert.deepEqual(await writes({ statusUpdates: [{ id: 'u-1', body: 'weekly update' }, { id: 'u-2', body: heartbeatLine('2026-10-26T14:00:00.000Z') }], hasNextPage: false }), ['u-2'], 'the existing row is updated in place');
  assert.deepEqual(await writes({ statusUpdates: [{}], hasNextPage: false }), [], 'a row without id or body');
  assert.deepEqual(await writes({ statusUpdates: [{ body: heartbeatLine('2026-10-26T14:00:00.000Z') }], hasNextPage: false }), [], 'the heartbeat row without its id');
  assert.deepEqual(await writes({ statusUpdates: [{ id: 'u-3' }], hasNextPage: false }), [], 'a row without its body');
  assert.deepEqual(await writes({ statusUpdates: [{ id: 'u-1', body: 'weekly update' }], hasNextPage: true }), [], 'a next page without a cursor');
});

test('P3.7: genuine pending CheckRuns, status contexts and an empty rollup are valid check reads', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const rollups: [string, Record<string, unknown>[], RegExp | undefined][] = [
    ['a queued CheckRun with a null conclusion', [{ __typename: 'CheckRun', name: 'ci', conclusion: null, status: 'QUEUED' }], /CI still running/],
    ['an in-progress CheckRun with an empty conclusion', [{ __typename: 'CheckRun', name: 'ci', conclusion: '', status: 'IN_PROGRESS' }], /CI still running/],
    ['a failed CheckRun', [{ __typename: 'CheckRun', name: 'ci', conclusion: 'FAILURE', status: 'COMPLETED' }], /CI job ci failed/],
    ['a pending status context', [{ __typename: 'StatusContext', context: 'buildkite/amp', state: 'PENDING' }], /CI still running/],
    ['an empty rollup', [], undefined],
  ];
  for (const [name, rollup, expected] of rollups) {
    const plant = factory();
    plant.issue('MET-7', 'In Progress');
    plant.builder('MET-7', 'running');
    plant.openPr('MET-7', 'c'.repeat(40), { statusCheckRollup: rollup });
    await plant.start();
    await settle();
    const verdict = await plant.guard(builderLabels) as { userMessage?: string } | undefined;
    if (expected) assert.match(verdict?.userMessage ?? '', expected, name);
    else assert.equal(verdict, undefined, name);
  }
});

test('P3.7: the follow-up Bug lookup rejects malformed rows instead of filing a duplicate; valid empty and matching lookups create or reuse', async () => {
  const title = 'Release 1.2.3 rolled back (abcdef123456)';
  const run = async (lookup: unknown) => {
    const saves: Record<string, unknown>[] = [];
    const tools = { call: async (name: string, input: Record<string, unknown>) => {
      if (name === 'linear.list_issues') return lookup;
      if (name === 'linear.save_issue') { saves.push(input); return { id: 'uuid-new', identifier: 'MET-900' }; }
      return {};
    } };
    const issue = { identifier: 'MET-7' } as Parameters<typeof followUp>[1];
    const result = await followUp({ tools, logger: { log: () => {} } } as Parameters<typeof followUp>[0], issue, { title, body: 'x' }).then(id => ({ id }), (error: unknown) => ({ error: String(error) }));
    return { result, saves: saves.map(input => (input.title ? 'create' : `relate ${String(input.id)}`)) };
  };
  assert.deepEqual(await run({ issues: [] }), { result: { id: 'MET-900' }, saves: ['create'] });
  assert.deepEqual(await run({ issues: [{ id: 'MET-55', title }] }), { result: { id: 'MET-55' }, saves: ['relate MET-55'] });
  for (const rows of [[{}], [{ title }], [{ id: '', title }], [{ id: 'MET-55' }]]) {
    const { result, saves } = await run({ issues: rows });
    assert.match((result as { error?: string }).error ?? '', /linear\.list_issues returned a malformed issues row at 0/, JSON.stringify(rows));
    assert.deepEqual(saves, [], `no Bug filed for ${JSON.stringify(rows)}`);
  }
});

// --- P3.7 round 4: a failed read is a failed derivation wherever it happens -----------------

const rolledBack = (plant: ReturnType<typeof factory>) => {
  plant.issue('MET-9', 'Deploying');
  plant.comments.set('MET-9', [{ id: 'c-r', body: 'odd-deploy host=factory-gpu component=meter sha=' + 'e'.repeat(40) + ' health=fail rollback=' + 'd'.repeat(12), createdAt: '2026-10-26T14:00:00.000Z' }]);
};

test('P3.7: a read that fails while acting withholds the heartbeat and writes nothing; a valid read acts and heartbeats', async t => {
  const lookups: [string, unknown, boolean][] = [
    ['valid empty Bug lookup (control)', undefined, true],
    ['Bug lookup rows [{}]', { issues: [{}], hasNextPage: false }, false],
    ['Bug lookup isError', { isError: true, content: [{ type: 'text', text: '{"issues":[],"hasNextPage":false}' }] }, false],
  ];
  for (const [name, lookup, healthy] of lookups) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const plant = factory();
        rolledBack(plant);
        if (lookup !== undefined) plant.control.inject = (call, input) => call === 'linear.list_issues' && input.query ? lookup : undefined;
        await plant.start();
        await settle();
        const sweep = (await plant.events()).find(event => event.issue === null);
        assert.equal(plant.heartbeats(), healthy ? 1 : 0);
        assert.equal(sweep?.stage, healthy ? 'performed' : 'failed');
        // The rollback's follow-up: a Bug filed and MET-9 returned to Todo, or nothing at all.
        assert.deepEqual(plant.saves, healthy ? ['undefined "Triage"', 'MET-9 "Todo"'] : []);
      } finally {
        mock.timers.reset();
      }
    });
  }
});

test('P3.7: malformed digest reads fail the sweep without a heartbeat; a valid empty day posts the digest and heartbeats', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const digestRead = (input: Record<string, unknown>) => Array.isArray(input.fields) && input.fields.includes('title');
  const run = async (override: (name: string, input: Record<string, unknown>) => unknown) => {
    const orb = controlOrb((name, input) => override(name, input) ?? emptyWork(name));
    await orb.start();
    await until(() => orb.calls.includes('linear.list_issues'));
    await settle();
    return { heartbeats: orb.updates.length, digests: orb.alerts.filter(text => text.startsWith('ODD digest')).length };
  };
  assert.deepEqual(await run(() => undefined), { heartbeats: 1, digests: 1 }, 'control');
  for (const [name, override] of [
    ['digest issues {}', (call: string, input: Record<string, unknown>) => call === 'linear.list_issues' && digestRead(input) ? {} : undefined],
    ['digest issue rows [{}]', (call: string, input: Record<string, unknown>) => call === 'linear.list_issues' && digestRead(input) ? { issues: [{}], hasNextPage: false } : undefined],
    ['digest merged PRs [{}]', (call: string, input: Record<string, unknown>) => call === '$' && String(input.command).startsWith('gh pr list --state merged') ? '[{}]' : undefined],
    ['digest posted-check without messages', (call: string, input: Record<string, unknown>) => call === 'slack_read' && input.channelName === 'factory-alerts' ? {} : undefined],
  ] as const) {
    assert.deepEqual(await run(override), { heartbeats: 0, digests: 0 }, name);
  }
});

test('P3.7: a merge whose confirmation read fails posts no receipt and no heartbeat; the next evaluation posts the receipt once from the merged PR', async t => {
  const cases: [string, (mergeSha: string) => Shell][] = [
    ['valid merge commit (control)', mergeSha => ({ exitCode: 0, stdout: `${mergeSha}\n`, stderr: '' })],
    ['confirmation fails', () => ({ exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' })],
    ['confirmation is null', () => ({ exitCode: 0, stdout: 'null\n', stderr: '' })],
    ['confirmation read rejects', () => { throw new Error('spawn gh ENOENT'); }],
  ];
  for (const [name, confirm] of cases) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const plant = factory();
        const sha = 'c'.repeat(40);
        const mergeSha = '7'.repeat(40);
        plant.issue('MET-8', 'In Progress');
        plant.builder('MET-8');
        plant.threads.set('T-review', { labels: ['odd-issue-met-8', 'odd-role-reviewer', 'odd-round-1', 'odd-engine-openai', `odd-verdict-ready-${sha.slice(0, 12)}`], state: 'idle', archived: false, updatedAt: new Date().toISOString() });
        plant.openPr('MET-8', sha);
        const merges: string[] = [];
        plant.control.gh = command => {
          if (command === 'gh pr view 8 --json isDraft --jq .isDraft') return { exitCode: 0, stdout: 'false\n', stderr: '' };
          if (command.startsWith('gh pr merge 8 ')) {
            merges.push(command);
            Object.assign(plant.prs[0], { state: 'MERGED', mergeCommit: { oid: mergeSha }, mergedAt: new Date().toISOString() });
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (command === 'gh pr view 8 --json mergeCommit --jq .mergeCommit.oid') return confirm(mergeSha);
          return undefined;
        };
        const receipts = () => (plant.comments.get('MET-8') ?? []).filter(comment => comment.body.startsWith('odd-merge pr=')).map(comment => comment.body);
        await plant.start();
        await settle();
        const valid = name.startsWith('valid');
        assert.deepEqual(merges.length, 1);
        assert.deepEqual(receipts(), valid ? [`odd-merge pr=8 head=${sha} merge=${mergeSha} release=none`] : [], 'no merge=unknown or merge=null receipt');
        assert.equal(plant.heartbeats(), valid ? 1 : 0);
        // The recheck finds the PR merged: one receipt from its validated merge commit, then Deploying; no second merge.
        await advance(10 * 60_000);
        assert.deepEqual(merges.length, 1, 'never merged twice');
        assert.deepEqual(receipts(), [`odd-merge pr=8 head=${sha} merge=${mergeSha} release=none`]);
        assert.ok(plant.saves.includes('MET-8 "Deploying"'));
        assert.ok(plant.heartbeats() >= 1, 'later sweeps are healthy again');
      } finally {
        mock.timers.reset();
      }
    });
  }
});

// --- P3.7 round 5: diagnosis and shell-transport reads; receipt recovery ownership and chronology ---

const merged8 = (mergedAt: string, mergeSha = '7'.repeat(40)): Pr => ({ number: 8, headRefName: 'met-8-x', headRefOid: 'c'.repeat(40), state: 'MERGED', mergeCommit: { oid: mergeSha }, mergedAt, mergeable: 'UNKNOWN', commits: [{ oid: 'c'.repeat(40), committedDate: '2026-10-26T13:00:00Z' }], statusCheckRollup: [], body: 'closes MET-8' });
const deployLine = (sha: string, health = 'pass', rollback = 'none') => `odd-deploy host=factory-gpu component=meter sha=${sha} health=${health} rollback=${rollback}`;

test('P3.7: a failed log-reader lookup still pages a failed rollback, but the sweep is not healthy; a valid lookup is', async t => {
  const lookups: [string, unknown][] = [
    ['valid lookup (control)', undefined],
    ['lookup {}', {}],
    ['lookup rows [{}]', { threads: [{}] }],
    ['lookup isError', { isError: true, content: [{ type: 'text', text: '{"threads":[]}' }] }],
  ];
  for (const [name, lookup] of lookups) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const plant = factory();
        plant.issue('MET-9', 'Deploying');
        plant.comments.set('MET-9', [{ id: 'c-r', body: deployLine('e'.repeat(40), 'fail', 'none'), createdAt: '2026-10-26T14:00:00.000Z' }]);
        if (lookup !== undefined) plant.control.inject = (call, input) => call === 'find_thread' && String(input.query).startsWith('label:odd-deploy-') ? lookup : undefined;
        await plant.start();
        await settle();
        assert.match(plant.dms.join('\n'), /ODD page: failed-rollback \| issue MET-9 /, 'the urgent page goes out');
        assert.ok(plant.saves.includes('MET-9 ["escalated"]'));
        assert.equal(plant.heartbeats(), lookup === undefined ? 1 : 0);
      } finally {
        mock.timers.reset();
      }
    });
  }
  // A page write failing after the failed lookup is still a failed read; with a valid lookup it stays an action failure.
  const writes: [string, (call: string, input: Record<string, unknown>) => boolean][] = [
    ['escalation comment', (call, input) => call === 'linear.save_comment' && String(input.body).startsWith('odd-escalated')],
    ['Slack page', (call, input) => call === 'slack_write' && !input.channelName],
    ['escalated label', (call, input) => call === 'linear.save_issue' && Array.isArray(input.addLabels)],
  ];
  for (const [write, fails] of writes) {
    for (const failedLookup of [true, false]) {
      await t.test(`${failedLookup ? 'lookup isError' : 'valid lookup (control)'}, then the ${write} fails`, async () => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
        try {
          const plant = factory();
          plant.issue('MET-9', 'Deploying');
          plant.comments.set('MET-9', [{ id: 'c-r', body: deployLine('e'.repeat(40), 'fail', 'none'), createdAt: '2026-10-26T14:00:00.000Z' }]);
          plant.control.inject = (call, input) => {
            if (fails(call, input)) throw new Error(`${write} 503`);
            return failedLookup && call === 'find_thread' && String(input.query).startsWith('label:odd-deploy-') ? { isError: true, content: [{ type: 'text', text: '{"threads":[]}' }] } : undefined;
          };
          await plant.start();
          await settle();
          const failed = (await plant.events() as { issue: string | null; stage: string; error?: string; read?: boolean }[]).filter(event => event.issue === 'MET-9' && event.stage === 'failed');
          assert.ok(failed.length > 0 && failed.every(event => String(event.error).includes(`${write} 503`)), 'the write failure stays observable');
          if (write === 'escalation comment') {
            // MET-348: the latch is written before any side effect, so its failure leaves no label, DM or log reader, and no lookup ran to fail.
            assert.deepEqual(plant.saves, []);
            assert.deepEqual(plant.dms, []);
            assert.deepEqual([...plant.threads.values()].filter(thread => thread.labels.includes('odd-role-deployer')), []);
            assert.deepEqual([...new Set(failed.map(event => event.read === true))], [false]);
            return;
          }
          assert.deepEqual([...new Set(failed.map(event => event.read === true))], [failedLookup], failedLookup ? 'the read failure is kept' : 'an action failure stays one');
          if (failedLookup) assert.equal(plant.heartbeats(), 0);
        } finally {
          mock.timers.reset();
        }
      });
    }
  }
});

test('P3.7: a rejected or malformed draft read before a merge merges nothing and writes no heartbeat; true and false merge', async t => {
  const reads: [string, string | undefined, boolean][] = [
    ['rejected', undefined, false],
    ['null', 'null\n', false],
    ['empty', '', false],
    ['not a boolean', '{"isDraft":false}\n', false],
    ['false (control)', 'false\n', true],
    ['true (control)', 'true\n', true],
  ];
  for (const [name, stdout, merges] of reads) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const plant = factory();
        const sha = 'c'.repeat(40);
        plant.issue('MET-8', 'In Progress');
        plant.builder('MET-8');
        plant.threads.set('T-review', { labels: ['odd-issue-met-8', 'odd-role-reviewer', 'odd-round-1', 'odd-engine-openai', `odd-verdict-ready-${sha.slice(0, 12)}`], state: 'idle', archived: false, updatedAt: new Date().toISOString() });
        plant.openPr('MET-8', sha);
        const merged: string[] = [];
        plant.control.gh = command => {
          if (command.startsWith('gh pr view 8 --json isDraft')) {
            if (stdout === undefined) throw new Error('spawn gh ENOENT');
            return { exitCode: 0, stdout, stderr: '' };
          }
          if (command.startsWith('gh pr ready 8')) return { exitCode: 0, stdout: '', stderr: '' };
          if (command.startsWith('gh pr merge')) { merged.push(command); return { exitCode: 0, stdout: '', stderr: '' }; }
          if (command.startsWith('gh pr view 8 --json mergeCommit')) return { exitCode: 0, stdout: `${'7'.repeat(40)}\n`, stderr: '' };
          return undefined;
        };
        await plant.start();
        await settle();
        assert.equal(merged.length, merges ? 1 : 0);
        assert.equal(plant.heartbeats(), merges ? 1 : 0);
      } finally {
        mock.timers.reset();
      }
    });
  }
});

test('P3.7: receipt recovery never writes to an issue ODD does not own', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  plant.issues.set('MET-8', { id: 'MET-8', status: 'In Progress', labels: ['Bug', 'area:agents'], description: fullSpec });
  plant.builder('MET-8');
  plant.prs.push(merged8('2026-10-26T14:00:00Z'));
  await plant.start();
  await advance(10 * 60_000);
  assert.deepEqual((plant.comments.get('MET-8') ?? []).map(comment => comment.body), [], 'no odd-merge comment on a dispatcher issue');
  assert.deepEqual(plant.saves, []);
});

test('P3.7: a recovered receipt keeps a deployment of a release containing the merge and retires every other', async t => {
  const mergeSha = '7'.repeat(40);
  const [d, e] = ['d'.repeat(40), 'e'.repeat(40)];
  // [name, deploy receipts (sha, posted at), outcome, Linear returns comments oldest first, the compare of this release fails]
  const cases: [string, [string, string][], 'current' | 'stale' | 'unread', boolean?, string?][] = [
    ['the merge deployed after it', [[mergeSha, '2026-10-26T14:10:00.000Z']], 'current'],
    ['the merge deployed at the merge time', [[mergeSha, '2026-10-26T14:00:00.000Z']], 'current'],
    ['a descendant release deployed after the merge', [[d, '2026-10-26T14:10:00.000Z']], 'current'],
    ['an old release delivered after the merge (stale)', [[e, '2026-10-26T14:10:00.000Z']], 'stale'],
    ['deployed before the merge (stale)', [[e, '2026-10-26T13:50:00.000Z']], 'stale'],
    // Only the effective (latest) receipt counts: an earlier valid one never vouches for a later stale one.
    ['a valid descendant, then an old release (newest first)', [[d, '2026-10-26T14:10:00.000Z'], [e, '2026-10-26T14:20:00.000Z']], 'stale'],
    ['a valid descendant, then an old release (oldest first)', [[d, '2026-10-26T14:10:00.000Z'], [e, '2026-10-26T14:20:00.000Z']], 'stale', true],
    ['a valid descendant, then a release whose compare fails (oldest first)', [[d, '2026-10-26T14:10:00.000Z'], [e, '2026-10-26T14:20:00.000Z']], 'unread', true, e],
    ['an old release, then a valid descendant (control)', [[e, '2026-10-26T14:10:00.000Z'], [d, '2026-10-26T14:20:00.000Z']], 'current'],
    ['an old release, then a valid descendant (control, oldest first)', [[e, '2026-10-26T14:10:00.000Z'], [d, '2026-10-26T14:20:00.000Z']], 'current', true],
  ];
  for (const [name, deploys, outcome, oldestFirst, unreadable] of cases) {
    const current = outcome === 'current';
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const plant = factory();
        plant.issue('MET-8', 'In Progress');
        plant.builder('MET-8');
        plant.prs.push(merged8('2026-10-26T14:00:00Z', mergeSha));
        plant.releases.set('d'.repeat(40), ['e'.repeat(40), mergeSha]);
        // The old release's own passing verification must not finish the new work.
        plant.comments.set('MET-8', [
          { id: 'c-v', body: `odd-verify sha=${'e'.repeat(40)} result=pass bug=none`, createdAt: '2026-10-26T13:40:00.000Z' },
          ...deploys.map(([sha, createdAt], i) => ({ id: `c-d${i}`, body: deployLine(sha), createdAt })),
        ]);
        // Let the issue follow its status writes, so the next evaluation sees Deploying.
        plant.control.inject = (call, input) => {
          if (call === 'linear.save_issue' && typeof input.state === 'string') plant.issues.get(String(input.id))!.status = input.state;
          if (call === 'linear.list_comments' && oldestFirst) return { comments: [...(plant.comments.get(String(input.issueId)) ?? [])], hasNextPage: false };
          return undefined;
        };
        if (unreadable) plant.control.gh = command => command.startsWith('gh api repos/{owner}/{repo}/compare/') && command.includes(`...${unreadable}`) ? { exitCode: 1, stdout: '', stderr: 'HTTP 502' } : undefined;
        await plant.start();
        // The status write, then the next sweep evaluates MET-8 in Deploying.
        await advance(11 * 60_000);
        const receipts = (plant.comments.get('MET-8') ?? []).filter(comment => comment.body.startsWith('odd-merge pr=')).map(comment => comment.body);
        assert.deepEqual(receipts, outcome === 'stale' ? [`odd-merge pr=8 head=${'c'.repeat(40)} merge=${mergeSha} release=none`] : []);
        if (outcome === 'unread') {
          assert.equal(plant.issues.get('MET-8')!.status, 'In Progress', 'an unread ancestry moves nothing');
          assert.equal(plant.heartbeats(), 0);
          return;
        }
        assert.equal(plant.issues.get('MET-8')!.status, 'Deploying');
        const verifiers = [...plant.threads.values()].filter(thread => thread.labels.includes('odd-role-verifier'));
        assert.equal(verifiers.length, current ? 1 : 0, current ? 'the post-merge deployment is verified' : 'the stale deployment waits for a new release');
        await advance(11 * 60_000);
        assert.equal(plant.issues.get('MET-8')!.status, 'Deploying', 'no earlier verification marks it Done');
      } finally {
        mock.timers.reset();
      }
    });
  }
});

// --- P4.6-webhooks: signed deliveries only ---------------------------------------------------

const githubSecret = 'p46-github-signing-secret-fixture';
const linearSecret = 'p46-linear-signing-secret-fixture';
const hmac = (secret: string, bytes: Uint8Array | string) => createHmac('sha256', secret).update(bytes).digest('hex');
const received = '2026-10-26T15:00:00.000Z';

/** A control orb with every external transport faked: Linear, thread search, Slack and the shell. `answers` feeds the secret dialogs, in order. Counts snapshot reads and lifecycle effects. Each load sees only the synthetic project environment it is given, never the host's. */
function signedOrb() {
  const reads: string[] = [];
  const effects: string[] = [];
  const output: string[] = [];
  const dialogs: Record<string, unknown>[] = [];
  const registrations: string[] = [];
  let answers: (string | undefined)[] = [];
  const tools = { call: async (name: string, input: Record<string, unknown>) => {
    output.push(JSON.stringify(input));
    switch (name) {
      case 'linear.list_issues': return { issues: [], hasNextPage: false };
      case 'find_thread': return { threads: [] };
      case 'linear.get_issue': reads.push(String(input.id)); return { id: input.id, status: 'Todo', labels: ['odd'], description: '', relations: { blockedBy: [] } };
      case 'linear.list_comments': return { comments: [], hasNextPage: false };
      case 'slack_read': return { messages: [] };
      case 'linear.get_status_updates': return { statusUpdates: [], hasNextPage: false };
      default: if (name !== 'linear.save_status_update') effects.push(name); return {};
    }
  } };
  const { $: shell, commands } = fakeShell();
  /** While set, every gh read fails the way an unreachable GitHub does (P3.7 fail-closed control). */
  const github = { down: false };
  const $ = async (strings: TemplateStringsArray, ...values: unknown[]) =>
    github.down && strings[0].startsWith('gh ') ? { exitCode: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' } : shell(strings, ...values);
  const logger = { log: (...args: unknown[]) => { output.push(args.map(String).join(' ')); } };
  const ui = {
    input: async (options: Record<string, unknown>) => { dialogs.push(options); return answers.shift(); },
    confirm: async (options: unknown) => { output.push(JSON.stringify(options)); dialogs.push({ confirm: true }); return true; },
    notify: async (message: string) => { output.push(message); },
  };
  let webhooks = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  let status: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const thread = { id: 'T-control', labels: async () => ['odd-control-plane', 'odd-perform'] };
  const ctx = { thread, ui, logger, tools, $ };
  return {
    reads, effects, output, dialogs, registrations, commands, github,
    /** A fresh plugin load arming the control thread with no project secrets; `secrets` answer its dialogs (undefined = dismissed). */
    start(...secrets: (string | undefined)[]) { return this.startWith({}, ...secrets); },
    /** `start` with the project environment `env` in place while the plugin loads and arms. */
    async startWith(env: Partial<Record<typeof secretNames[number], string>>, ...secrets: (string | undefined)[]) {
      Object.assign(process.env, env);
      try {
        await this.load(...secrets);
      } finally {
        for (const name of secretNames) delete process.env[name];
      }
    },
    async load(...secrets: (string | undefined)[]) {
      answers = secrets;
      webhooks = new Map();
      let tool: { execute: (input: Record<string, unknown>, ctx: unknown) => Promise<string> } | undefined;
      const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
      await (plugin as unknown as (api: unknown) => Promise<void>)({
        $, createAgent: () => ({ definition: {} }), registerAgentMode: () => {}, registerTool: (definition: typeof tool) => { tool = definition; },
        on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, handler); },
        createWebhook: async ({ key, handler }: { key: string; handler: (event: unknown, ctx: unknown) => Promise<void> }) => { registrations.push(key); webhooks.set(key, handler); return { url: `https://hooks.example/${key}` }; },
        system: { executor: { kind: 'remote', keepAlive: async () => {} } },
      });
      await handlers.get('session.start')!({}, ctx);
      await settle();
      // The arming sweep posts the day's digest; only effects of deliveries are under test.
      effects.length = 0;
      commands.length = 0;
      status = async input => { const text = await tool!.execute(input, ctx); output.push(text); return JSON.parse(text); };
    },
    status: (input: Record<string, unknown> = {}) => status(input),
    answer: (...secrets: (string | undefined)[]) => { answers = secrets; },
    async deliver(key: string, id: string, body: string, headers: Record<string, string>, at = received) {
      try {
        await webhooks.get(key)!({ id, receivedAt: at, body: new TextEncoder().encode(body), headers }, ctx);
      } catch (error: unknown) {
        output.push(String(error));
        throw error;
      } finally {
        await settle();
      }
    },
  };
}

const githubBody = JSON.stringify({ action: 'synchronize', pull_request: { head: { ref: 'met-7-signed' }, body: 'closes MET-7' } });
const linearBody = (sentAt: number, spacing = 0) => JSON.stringify({ action: 'update', type: 'Issue', data: { identifier: 'MET-8' }, webhookTimestamp: sentAt }, null, spacing);
const sent = Date.parse(received) - 5_000;

/** One delivery as the provider would send it. `secret` signs `signed` (default: `body`); `header` overrides the signature header. */
type Delivery = { provider: 'github' | 'linear'; id: string; body: string; at?: string; header?: Record<string, string>; secret?: string; signed?: string };
const sign = ({ provider, body, header, secret, signed }: Delivery): Record<string, string> => {
  if (header) return header;
  const hex = hmac(secret ?? (provider === 'github' ? githubSecret : linearSecret), signed ?? body);
  return provider === 'github' ? { 'x-hub-signature-256': `sha256=${hex}` } : { 'linear-signature': hex };
};
const ghSig = (hex: string) => ({ 'x-hub-signature-256': hex });
const linSig = (hex: string) => ({ 'linear-signature': hex });
const fresh = linearBody(sent);
const spaced = linearBody(sent, 2);
const at = (offsetMs: number) => linearBody(Date.parse(received) + offsetMs);

/**
 * The webhook-to-decision matrix. `evaluated`: the delivery reaches a lifecycle decision (the
 * fixture issue sits in Todo without a spec, so the decision is `set-status Triage`, one
 * `linear.save_issue`). `rejected`: recorded with `reason` and nothing else happens: no Linear
 * read, no gh read, no write. `retried`: the handler throws so Amp redelivers, and nothing
 * happens. `before` deliveries run first on the same plane and must be evaluated.
 */
const matrix: { name: string; delivery: Delivery; expect: 'evaluated' | 'rejected' | 'retried'; reason?: RegExp; before?: Delivery[]; setup?: 'no-secrets' | 'github-down' }[] = [
  // Valid controls.
  { name: 'GitHub: valid sha256= signature', delivery: { provider: 'github', id: 'g', body: githubBody }, expect: 'evaluated' },
  { name: 'GitHub: valid signature in upper-case hex', delivery: { provider: 'github', id: 'g', body: githubBody, header: ghSig(`sha256=${hmac(githubSecret, githubBody).toUpperCase()}`) }, expect: 'evaluated' },
  { name: 'Linear: valid bare-hex signature', delivery: { provider: 'linear', id: 'l', body: fresh }, expect: 'evaluated' },
  { name: 'Linear: valid over the exact raw bytes, whitespace included', delivery: { provider: 'linear', id: 'l', body: spaced }, expect: 'evaluated' },
  { name: 'Linear: sent 59 s before receipt is fresh', delivery: { provider: 'linear', id: 'l', body: at(-59_000) }, expect: 'evaluated' },
  // Absent, malformed or wrong signatures.
  { name: 'GitHub: no signature header', delivery: { provider: 'github', id: 'g', body: githubBody, header: {} }, expect: 'rejected', reason: /^missing x-hub-signature-256$/ },
  { name: 'GitHub: bare hex without sha256=', delivery: { provider: 'github', id: 'g', body: githubBody, header: ghSig(hmac(githubSecret, githubBody)) }, expect: 'rejected', reason: /^malformed/ },
  { name: 'GitHub: legacy sha1= signature', delivery: { provider: 'github', id: 'g', body: githubBody, header: ghSig(`sha1=${hmac(githubSecret, githubBody).slice(0, 40)}`) }, expect: 'rejected', reason: /^malformed/ },
  { name: 'GitHub: truncated signature', delivery: { provider: 'github', id: 'g', body: githubBody, header: ghSig(`sha256=${hmac(githubSecret, githubBody).slice(0, -2)}`) }, expect: 'rejected', reason: /^malformed/ },
  { name: 'GitHub: signed with the Linear secret', delivery: { provider: 'github', id: 'g', body: githubBody, secret: linearSecret }, expect: 'rejected', reason: /^invalid/ },
  { name: 'GitHub: only a Linear-style header', delivery: { provider: 'github', id: 'g', body: githubBody, header: linSig(hmac(githubSecret, githubBody)) }, expect: 'rejected', reason: /^missing/ },
  { name: 'Linear: no signature header', delivery: { provider: 'linear', id: 'l', body: fresh, header: {} }, expect: 'rejected', reason: /^missing linear-signature$/ },
  { name: 'Linear: GitHub-style sha256= header', delivery: { provider: 'linear', id: 'l', body: fresh, header: linSig(`sha256=${hmac(linearSecret, fresh)}`) }, expect: 'rejected', reason: /^malformed/ },
  { name: 'Linear: signed with the GitHub secret', delivery: { provider: 'linear', id: 'l', body: fresh, secret: githubSecret }, expect: 'rejected', reason: /^invalid/ },
  // Raw bytes: a verifier that parses and re-serializes would accept these.
  { name: 'GitHub: one space added after signing', delivery: { provider: 'github', id: 'g', body: githubBody.replace('"closes', ' "closes'), signed: githubBody }, expect: 'rejected', reason: /^invalid/ },
  { name: 'Linear: issue identifier changed after signing', delivery: { provider: 'linear', id: 'l', body: fresh.replace('MET-8', 'MET-9'), signed: fresh }, expect: 'rejected', reason: /^invalid/ },
  { name: 'Linear: same JSON re-serialized compactly', delivery: { provider: 'linear', id: 'l', body: fresh, signed: spaced }, expect: 'rejected', reason: /^invalid/ },
  // Linear freshness.
  { name: 'Linear: sent 61 s before receipt is stale', delivery: { provider: 'linear', id: 'l', body: at(-61_000) }, expect: 'rejected', reason: /^stale delivery/ },
  { name: 'Linear: stamped 61 s after receipt is stale', delivery: { provider: 'linear', id: 'l', body: at(61_000) }, expect: 'rejected', reason: /^stale delivery/ },
  { name: 'Linear: signed body without webhookTimestamp', delivery: { provider: 'linear', id: 'l', body: JSON.stringify({ data: { identifier: 'MET-8' } }) }, expect: 'rejected', reason: /^missing webhookTimestamp$/ },
  { name: 'Linear: signed body that is not JSON', delivery: { provider: 'linear', id: 'l', body: 'MET-8' }, expect: 'rejected', reason: /^unparseable body$/ },
  // Duplicates and replays.
  { name: 'Linear: same signed bytes under a new event ID is a replay', before: [{ provider: 'linear', id: 'l-first', body: spaced }], delivery: { provider: 'linear', id: 'l-replay', body: spaced, at: '2026-10-26T15:00:20.000Z' }, expect: 'rejected', reason: /^replayed delivery$/ },
  { name: 'Linear: Amp redelivering the same event is deduplicated', before: [{ provider: 'linear', id: 'l', body: fresh }], delivery: { provider: 'linear', id: 'l', body: fresh }, expect: 'rejected' },
  { name: 'GitHub: Amp redelivering the same event is deduplicated', before: [{ provider: 'github', id: 'g', body: githubBody }], delivery: { provider: 'github', id: 'g', body: githubBody }, expect: 'rejected' },
  // Arming and #222.
  { name: 'GitHub: valid signature, secret never entered', setup: 'no-secrets', delivery: { provider: 'github', id: 'g', body: githubBody }, expect: 'retried' },
  { name: 'Linear: valid signature, secret never entered', setup: 'no-secrets', delivery: { provider: 'linear', id: 'l', body: fresh }, expect: 'retried' },
  { name: 'Linear: valid signature, GitHub unreadable (P3.7 fails closed)', setup: 'github-down', delivery: { provider: 'linear', id: 'l', body: fresh }, expect: 'retried' },
];

test('P4.6-webhooks: webhook-to-decision matrix', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(received) });
  t.after(() => mock.timers.reset());
  for (const row of matrix) {
    await t.test(`${row.expect}: ${row.name}`, async () => {
      const orb = signedOrb();
      await (row.setup === 'no-secrets' ? orb.start(undefined, undefined) : orb.start(linearSecret, githubSecret));
      const send = (delivery: Delivery) => orb.deliver(delivery.provider, delivery.id, delivery.body, sign(delivery), delivery.at);
      const issue = (delivery: Delivery) => (delivery.provider === 'github' ? 'MET-7' : 'MET-8');
      for (const prior of row.before ?? []) await send(prior);
      assert.deepEqual(orb.reads, (row.before ?? []).map(issue), 'every prior delivery is evaluated');
      const [reads, effects, commands] = [orb.reads.length, orb.effects.length, orb.commands.length];
      orb.github.down = row.setup === 'github-down';
      if (row.expect === 'retried') await assert.rejects(send(row.delivery), row.setup === 'github-down' ? /HTTP 502/ : /signing secret not set/);
      else await send(row.delivery);
      const { events } = await orb.status() as { events: { source: string; issue: string | null; stage: string; error?: string; action?: { kind: string; status?: string } }[] };
      const last = events.findLast(event => event.source === row.delivery.provider)!;
      const newReads = orb.reads.slice(reads);
      const newEffects = orb.effects.slice(effects);
      if (row.expect === 'evaluated') {
        assert.deepEqual(newReads, [issue(row.delivery)], 'one snapshot read');
        assert.deepEqual([last.issue, last.stage, last.action?.kind, last.action?.status], [issue(row.delivery), 'performed', 'set-status', 'Triage'], 'the lifecycle decision');
        assert.deepEqual(newEffects, ['linear.save_issue'], 'the decision is carried out');
        return;
      }
      assert.deepEqual(newEffects, [], 'no lifecycle action');
      // An authenticated delivery may read; P3.7 holds its decision when GitHub is unreadable.
      if (row.setup !== 'github-down') {
        assert.deepEqual(newReads, [], 'no Linear read');
        assert.deepEqual(orb.commands.slice(commands), [], 'no gh read');
      } else assert.equal(last.stage, 'failed');
      if (row.reason) assert.deepEqual([last.stage, last.issue], ['rejected', null]), assert.match(last.error ?? '', row.reason);
      if (row.expect === 'retried') {
        // Recovery: the same event, redelivered once the cause is gone, is decided exactly once.
        orb.github.down = false;
        orb.answer(linearSecret, githubSecret);
        if (row.setup === 'no-secrets') await orb.status({ set_secrets: true });
        await send(row.delivery);
        assert.deepEqual(orb.reads.slice(reads).filter(id => id === issue(row.delivery)).length, row.setup === 'github-down' ? 2 : 1, 'the redelivery is evaluated');
        assert.deepEqual(orb.effects.slice(effects), ['linear.save_issue'], 'and decided once');
      }
    });
  }
});

test('P4.6-webhooks: without a secret (first arm, dismissed dialog, plugin reload) every delivery is refused and retried; private setup recovers without new URLs; no secret reaches status, logs, errors or tools', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(received) });
  t.after(() => mock.timers.reset());
  const orb = signedOrb();
  const linearSig = (body: string) => ({ 'linear-signature': hmac(linearSecret, body) });
  const body = linearBody(sent);

  // Arm with both dialogs dismissed: secret, owner-only dialogs, and the URLs are not shown.
  await orb.start(undefined, undefined);
  assert.equal(orb.dialogs.length, 2);
  assert.ok(orb.dialogs.every(dialog => dialog.secret === true && dialog.requireHuman === true && dialog.initialValue === undefined));
  assert.ok(!orb.dialogs.some(dialog => dialog.confirm), 'arming shows no URL dialog');
  assert.deepEqual((await orb.status()).signing, { linear: 'missing', github: 'missing' });
  // A validly signed delivery fails its handler, so Amp retries it, and nothing is read.
  await assert.rejects(orb.deliver('linear', 'lin-1', body, linearSig(body)), /linear signing secret not set/);
  await assert.rejects(orb.deliver('github', 'gh-1', githubBody, { 'x-hub-signature-256': `sha256=${hmac(githubSecret, githubBody)}` }), /github signing secret not set/);
  assert.deepEqual(orb.reads, []);
  assert.deepEqual(orb.effects, []);

  // Private setup: only secret dialogs, no re-registration, so the URLs Linear and GitHub hold stay valid.
  orb.answer(linearSecret, `  ${githubSecret}\n`);
  assert.deepEqual((await orb.status({ set_secrets: true })).signing, { linear: 'set', github: 'set' });
  assert.deepEqual(orb.registrations, ['linear', 'github']);
  assert.ok(!orb.dialogs.some(dialog => dialog.confirm));
  // Amp's retry of the refused event (same ID, same receipt time) is now evaluated, once.
  await orb.deliver('linear', 'lin-1', body, linearSig(body));
  await orb.deliver('github', 'gh-1', githubBody, { 'x-hub-signature-256': `sha256=${hmac(githubSecret, githubBody)}` });
  assert.deepEqual(orb.reads, ['MET-8', 'MET-7']);

  // Reload: the secrets lived in memory only, so the new instance fails closed until set again.
  await orb.start(undefined, undefined);
  assert.deepEqual(orb.registrations, ['linear', 'github', 'linear', 'github'], 'the same stable keys');
  assert.deepEqual((await orb.status()).signing, { linear: 'missing', github: 'missing' });
  const later = linearBody(sent + 1_000);
  await assert.rejects(orb.deliver('linear', 'lin-2', later, linearSig(later)), /signing secret not set/);
  assert.deepEqual(orb.reads, ['MET-8', 'MET-7']);
  orb.answer(linearSecret, githubSecret);
  await orb.status({ set_secrets: true });
  await orb.deliver('linear', 'lin-2', later, linearSig(later));
  assert.deepEqual(orb.reads, ['MET-8', 'MET-7', 'MET-8']);

  // Redaction: nothing the plane wrote, logged, returned or threw carries a secret.
  await orb.status({ show_urls: true });
  for (const secret of [githubSecret, linearSecret]) {
    assert.ok(!orb.output.some(text => text.includes(secret)), 'a secret leaked into status, logs, errors or tool inputs');
  }
  assert.ok(orb.output.some(text => text.includes('"signing"')), 'status output was captured');
});

test('MET-382: project-environment secrets survive plugin reload without dialogs; partial, empty and removed values fail closed per provider; a changed value on a fresh runtime replaces the old one; private input never overrides the environment', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(received) });
  t.after(() => mock.timers.reset());
  const orb = signedOrb();
  const rotated = 'met382-rotated-github-signing-secret-fixture';
  const both = { ODD_GITHUB_WEBHOOK_SECRET: githubSecret, ODD_LINEAR_WEBHOOK_SECRET: ` ${linearSecret}\n` };
  let n = 0;
  const linear = (secret: string) => { const body = linearBody(sent + ++n); return orb.deliver('linear', `lin-${n}`, body, { 'linear-signature': hmac(secret, body) }); };
  const github = (secret: string) => orb.deliver('github', `gh-${++n}`, githubBody, { 'x-hub-signature-256': `sha256=${hmac(secret, githubBody)}` });
  const readsAfter = async (deliver: () => Promise<void>) => { const before = orb.reads.length; await deliver(); return orb.reads.slice(before); };

  // Both configured: arming asks nothing, and both providers verify; a reload (fresh plugin state) needs no re-entry.
  for (const load of ['first arm', 'reload']) {
    await orb.startWith(both);
    assert.deepEqual(orb.dialogs, [], `${load}: no dialog for configured providers`);
    const status = await orb.status();
    assert.deepEqual(status.signing, { linear: 'set', github: 'set' }, load);
    assert.deepEqual(status.signingSource, { linear: 'environment', github: 'environment' }, load);
    assert.deepEqual(await readsAfter(() => linear(linearSecret)), ['MET-8'], `${load}: linear evaluated`);
    assert.deepEqual(await readsAfter(() => github(githubSecret)), ['MET-7'], `${load}: github evaluated`);
    assert.deepEqual(await readsAfter(() => github(linearSecret)), [], `${load}: wrong secret still refused`);
  }
  // Explicit private setup does not prompt for, or replace, an environment-configured provider.
  orb.answer(rotated, rotated);
  assert.deepEqual((await orb.status({ set_secrets: true })).signingSource, { linear: 'environment', github: 'environment' });
  assert.deepEqual(orb.dialogs, []);
  assert.deepEqual(await readsAfter(() => github(rotated)), []);
  assert.deepEqual(await readsAfter(() => github(githubSecret)), ['MET-7']);

  // Partial (Linear empty): only Linear is asked; dismissed, Linear fails closed while GitHub works.
  await orb.startWith({ ODD_GITHUB_WEBHOOK_SECRET: githubSecret, ODD_LINEAR_WEBHOOK_SECRET: '  ' }, undefined);
  assert.deepEqual(orb.dialogs.map(dialog => String(dialog.title)), ['ODD Linear webhook signing secret']);
  assert.deepEqual((await orb.status()).signing, { linear: 'missing', github: 'set' });
  await assert.rejects(linear(linearSecret), /linear signing secret not set; set project secret ODD_LINEAR_WEBHOOK_SECRET/);
  assert.deepEqual(await readsAfter(() => github(githubSecret)), ['MET-7']);
  // The private fallback fills only the missing provider, for this runtime.
  orb.answer(linearSecret);
  assert.deepEqual((await orb.status({ set_secrets: true })).signingSource, { linear: 'private', github: 'environment' });
  assert.equal(orb.dialogs.length, 2);
  assert.deepEqual(await readsAfter(() => linear(linearSecret)), ['MET-8']);

  // Fresh runtime with GitHub rotated and Linear removed: the old GitHub secret and the private Linear one are gone.
  orb.dialogs.length = 0;
  await orb.startWith({ ODD_GITHUB_WEBHOOK_SECRET: rotated }, undefined);
  assert.deepEqual(orb.dialogs.map(dialog => String(dialog.title)), ['ODD Linear webhook signing secret']);
  assert.deepEqual((await orb.status()).signingSource, { github: 'environment' });
  assert.deepEqual(await readsAfter(() => github(githubSecret)), [], 'the replaced secret is not reused');
  assert.deepEqual(await readsAfter(() => github(rotated)), ['MET-7']);
  await assert.rejects(linear(linearSecret), /linear signing secret not set/);

  // Neither configured: both fail closed, as before.
  orb.dialogs.length = 0;
  await orb.startWith({ ODD_GITHUB_WEBHOOK_SECRET: '', ODD_LINEAR_WEBHOOK_SECRET: '' }, undefined, undefined);
  assert.equal(orb.dialogs.length, 2);
  assert.deepEqual((await orb.status()).signing, { linear: 'missing', github: 'missing' });
  await assert.rejects(github(rotated), /github signing secret not set/);
  await assert.rejects(linear(linearSecret), /linear signing secret not set/);
  assert.deepEqual(orb.effects, []);

  await orb.status({ show_urls: true });
  for (const secret of [githubSecret, linearSecret, rotated]) {
    assert.ok(!orb.output.some(text => text.includes(secret)), 'a secret leaked into status, logs, errors or tool inputs');
  }
});

test('P3.13: an unresolved issue-scoped Linear delivery logs one sanitized diagnostic and is neither read nor acted on; a documented Comment payload resolves from its URL with no diagnostic', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(received) });
  t.after(() => mock.timers.reset());
  const issueId = '731161c3-191b-46df-8500-c493d2eba9e1';
  const commentUrl = (identifier: string) => `https://linear.app/metacomet/issue/${identifier}/p313-fixture#comment-c0ffee`;
  const comment = (url: string, body = 'p313 private comment text') =>
    JSON.stringify({ action: 'create', type: 'Comment', data: { id: 'c-p313', body, issueId }, url, webhookTimestamp: sent });
  const cases = [
    { name: 'foreign team in the URL', body: comment(commentUrl('ENG-8')), reads: [] as string[], diagnostic: true },
    { name: 'URL not on linear.app', body: comment('https://linear.app.example/metacomet/issue/MET-8/x'), reads: [], diagnostic: true },
    { name: 'documented Comment payload', body: comment(commentUrl('MET-8')), reads: ['MET-8'], diagnostic: false },
    { name: 'not issue-scoped', body: JSON.stringify({ action: 'update', type: 'Project', data: { id: 'p' }, url: commentUrl('MET-8'), webhookTimestamp: sent }), reads: [], diagnostic: false },
  ];
  for (const [index, row] of cases.entries()) {
    await t.test(row.name, async () => {
      const orb = signedOrb();
      await orb.start(linearSecret, githubSecret);
      const [logged, commands] = [orb.output.length, orb.commands.length];
      await orb.deliver('linear', `p313-${index}`, row.body, { 'linear-signature': hmac(linearSecret, row.body) });
      const lines = orb.output.slice(logged).filter(line => line.includes('linear-unresolved'));
      assert.deepEqual(lines, row.diagnostic ? ['[odd] linear-unresolved type=Comment'] : [], 'one sanitized diagnostic, or none');
      assert.deepEqual(orb.reads, row.reads, 'snapshot reads');
      if (row.reads.length === 0) {
        assert.deepEqual(orb.effects, [], 'no mutation');
        assert.deepEqual(orb.commands.slice(commands), [], 'no gh read');
      } else assert.deepEqual(orb.effects, ['linear.save_issue'], 'the resolved issue is decided');
      const { events } = await orb.status() as { events: { source: string; issue: string | null; stage: string }[] };
      const last = events.findLast(event => event.source === 'linear')!;
      assert.deepEqual([last.issue, last.stage], row.reads.length ? ['MET-8', 'performed'] : [null, 'ignored']);
      for (const secret of ['p313 private comment text', 'linear.app', issueId, 'c0ffee', linearSecret, hmac(linearSecret, row.body)]) {
        assert.ok(!orb.output.some(line => line.includes(secret)), `the payload, URL or signature leaked: ${secret}`);
      }
    });
  }
});

// --- P4.5: every authoritative lifecycle read follows its pages --------------------------

const unrelatedPr = (n: number, state: Pr['state'] = 'OPEN'): Pr =>
  ({ number: 1000 + n, headRefName: `renovate-${n}`, headRefOid: 'f'.repeat(40), state, mergeCommit: null, mergeable: 'MERGEABLE', commits: [], statusCheckRollup: [], body: `Mentions MET-30 and MET-32 without owning them (${n}).` });
const rolesOf = (plant: ReturnType<typeof factory>, issue: string, role: string) =>
  [...plant.threads.values()].filter(thread => thread.labels.includes(`odd-issue-${issue.toLowerCase()}`) && thread.labels.includes(`odd-role-${role}`));

test('P4.5: a receipt beyond comment 50 starts the verifier, and the verifier\'s guard reads it and the verdict on another page', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  const sha = 'e'.repeat(40);
  plant.issue('MET-20', 'Deploying');
  plant.say('MET-20', deployReceiptLine({ host: 'gpu', component: 'api', sha, health: 'pass', rollback: 'none' }));
  for (let i = 0; i < 120; i++) plant.say('MET-20', `note ${i}`);
  await plant.start();
  await settle();
  assert.equal(rolesOf(plant, 'MET-20', 'verifier').length, 1, 'the receipt is the oldest of 121 comments');
  const labels = ['odd-issue-met-20', 'odd-role-verifier', 'odd-round-1'];
  const unmet = await plant.guard(labels) as Promise<{ userMessage: string } | undefined>;
  assert.match(unmet?.userMessage ?? '', new RegExp(`odd-verify sha=${sha}`), 'the guard found the receipt and waits for its verdict');
  plant.say('MET-20', verifyLine({ sha, result: 'pass' }));
  assert.equal(await plant.guard(labels) as Promise<{ userMessage: string } | undefined>, undefined, 'verdict on page 1, receipt on page 2: stop met');
});

test('P4.5: an owned open PR beyond the first 100 and a merged one beyond 100 search results both count; mentions do not own', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  for (let i = 0; i < 150; i++) plant.prs.push(unrelatedPr(i));
  plant.issue('MET-30', 'In Progress');
  plant.builder('MET-30');
  plant.openPr('MET-30', 'a'.repeat(40));
  // 150 merged PRs the quoted search matches (they mention MET-32) but that do not own it, newer than the owner.
  plant.prs.push({ ...unrelatedPr(999, 'MERGED'), number: 32, headRefName: 'met-32-x', headRefOid: '3'.repeat(40), mergeCommit: { oid: '4'.repeat(40) } as never, mergedAt: '2026-10-26T14:00:00Z', commits: [{ oid: '3'.repeat(40), committedDate: '2026-10-26T13:00:00Z' }], body: 'MET-32' } as Pr);
  for (let i = 0; i < 150; i++) plant.prs.unshift({ ...unrelatedPr(i, 'MERGED'), mergeCommit: { oid: '5'.repeat(40) } as never, mergedAt: '2026-10-26T14:00:00Z' } as Pr);
  plant.issue('MET-32', 'In Progress');
  plant.builder('MET-32');
  await plant.start();
  await settle();
  assert.equal(rolesOf(plant, 'MET-30', 'reviewer').length, 1, 'open PR #30 is the 151st open PR');
  assert.ok(plant.saves.includes('MET-32 "Deploying"'), 'merged PR #32 is the 151st search result');
});


// The P4.5 proof matrix: each paged read the lifecycle acts on, through the real plugin, under
// every page shape. Rows are cut at the plugin's `limit` and each page repeats the previous
// page's last row, as overlapping pages can. A shape breaks the page after the first (or the
// first page's cursor) until `broken` is cleared; the recovery step then reruns the consumer.
// Every row asserts what the plane did, so a failure prints the concrete wrong decision.
type Shape = 'complete' | 'empty' | 'malformed' | 'error' | 'no-cursor' | 'no-flag' | 'no-metadata' | 'repeated-cursor';
const shapes: readonly Shape[] = ['complete', 'empty', 'malformed', 'error', 'no-cursor', 'no-flag', 'no-metadata', 'repeated-cursor'];
// Slack's read_messages has no hasNextPage: a page without nextCursor is the last page by contract, so the
// Linear-only shapes (no-cursor: more without a cursor; no-flag and no-metadata: a page without hasNextPage) are not Slack shapes.
const slackShapes = shapes.filter(shape => !['no-cursor', 'no-flag', 'no-metadata'].includes(shape));
const failing = (shape: Shape) => shape !== 'complete' && shape !== 'empty';

function pager<T>(all: readonly T[], shape: Shape, style: 'linear' | 'slack', key: string) {
  const state = { broken: true, reads: 0 };
  const read = (input: Record<string, unknown>) => {
    state.reads += 1;
    const rows = shape === 'empty' ? [] : all;
    const size = Number(input.limit);
    const from = Number(input.cursor ?? 0);
    const to = from + size;
    let page: unknown[] = rows.slice(from, to);
    let more = to < rows.length;
    let next: string | undefined = more ? String(to - 1) : undefined;
    const late = state.broken && from > 0;
    if (late && shape === 'error') throw new Error(`${style} 503 on page 2`);
    if (late && shape === 'malformed') page = [...page, null];
    if (state.broken && shape === 'no-cursor' && more) next = undefined;
    // A server that keeps handing back the cursor it was sent; it gives up after ten reads so an unguarded reader ends.
    if (late && shape === 'repeated-cursor' && state.reads < 10) { next = String(input.cursor); more = true; }
    if (style === 'slack') return { [key]: page, ...(next ? { nextCursor: next } : {}) };
    // A first page that omits hasNextPage: with its cursor (`{ comments, cursor }`), or with no pagination fields at all.
    if (state.broken && from === 0 && shape === 'no-flag') return { [key]: page, ...(next ? { cursor: next } : {}) };
    if (state.broken && from === 0 && shape === 'no-metadata') return { [key]: page };
    return { [key]: page, hasNextPage: more, ...(next ? { cursor: next } : {}) };
  };
  return { state, read };
}

const verifierLabels = ['odd-issue-met-40', 'odd-role-verifier', 'odd-round-1'];
for (const shape of shapes) for (const total of shape === 'complete' ? [100, 101, 200, 201] : [201]) {
  test(`P4.5 matrix: issue comments ${shape}${shape === 'complete' ? ` (${total})` : ''}: the verdict on the oldest comment is read or nothing acts`, async t => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
    t.after(() => mock.timers.reset());
    const plant = factory();
    const sha = 'e'.repeat(40);
    plant.issue('MET-40', 'Deploying');
    // Newest first: the green receipt, notes, and the pass verdict for it as the oldest comment.
    const at = (i: number) => new Date(Date.parse('2026-10-26T14:00:00Z') - i * 1000).toISOString();
    const rows = Array.from({ length: total }, (_, i) => ({ id: `c-${i}`, createdAt: at(i),
      body: i === 0 ? deployReceiptLine({ host: 'gpu', component: 'api', sha, health: 'pass', rollback: 'none' }) : i === total - 1 ? verifyLine({ sha, result: 'pass' }) : `note ${i}` }));
    const comments = pager(rows, shape, 'linear', 'comments');
    plant.control.inject = (name, input) => name === 'linear.list_comments' && input.issueId === 'MET-40' ? comments.read(input) : undefined;
    const outcome = async () => {
      const guard = await (plant.guard(verifierLabels) as Promise<{ userMessage: string } | undefined>).then(result => !result ? 'stop' : result.userMessage.includes('no odd-deploy receipt') ? 'continue: no receipt' : result.userMessage.includes('odd-verify sha=') ? 'continue: no verdict' : `continue: ${result.userMessage}`, (error: unknown) => `refused: ${String(error).slice(0, 40)}`);
      return { status: plant.saves.filter(save => save.startsWith('MET-40 ')), verifiers: rolesOf(plant, 'MET-40', 'verifier').length, guard: guard.startsWith('refused') ? 'refused' : guard };
    };
    await plant.start();
    await settle();
    const empty = { status: [], verifiers: 0, guard: 'continue: no receipt' };
    const done = { status: ['MET-40 "Done"'], verifiers: 0, guard: 'stop' };
    assert.deepEqual(await outcome(), shape === 'empty' ? empty : failing(shape) ? { status: [], verifiers: 0, guard: 'refused' } : done);
    comments.state.broken = false;
    await advance(90_000);
    if (failing(shape)) assert.deepEqual(await outcome(), done, 'the recheck reads every page and acts once');
  });
}

const intakeMessage = (ts: string, text: string) => ({ ts, text, userID: 'U1' });
for (const shape of slackShapes) {
  test(`P4.5 matrix: Slack intake ${shape}: the message on page 2 gets one Intake thread or none does`, async t => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
    t.after(() => mock.timers.reset());
    const rows = Array.from({ length: 51 }, (_, i) => intakeMessage(`1761310000.${String(i).padStart(6, '0')}`, i === 50 ? 'late intake sentinel' : `intake ${i}`));
    const intake = pager(rows, shape, 'slack', 'messages');
    // Each Intake thread is indexed and idle as soon as it exists, so the orb cap (P4.1) never holds a message back here.
    const intakeThreads = () => ({ threads: orb.spawned.map((_, i) => ({ id: `T-spawned-${i + 1}` })) });
    const orb: ReturnType<typeof controlOrb> = controlOrb((name, input) => {
      if (name === 'slack_read' && input.channelName === '#factory-intake' && input.operation === 'read_messages') return intake.read(input);
      if (name === 'find_thread' && input.query === 'label:odd-role-intake archived:false') return intakeThreads();
      if (name === 'get_thread_status' && String(input.thread).startsWith('T-spawned-')) return { metadata: { labels: ['odd-role-intake', 'odd-round-1'] }, agentState: { state: 'idle' } };
      return emptyWork(name);
    });
    const status = await orb.start();
    await settle();
    const outcome = async () => ({ spawned: orb.spawned.length, sentinel: orb.spawned.filter(prompt => prompt.includes('late intake sentinel')).length, error: Boolean((await status({})).slack.error) });
    assert.deepEqual(await outcome(), shape === 'empty' ? { spawned: 0, sentinel: 0, error: false } : failing(shape) ? { spawned: 0, sentinel: 0, error: true } : { spawned: 51, sentinel: 1, error: false });
    intake.state.broken = false;
    await advance(5 * 60_000);
    if (failing(shape)) assert.deepEqual(await outcome(), { spawned: 51, sentinel: 1, error: false }, 'the next poll hands every message to Intake once');
  });
}

for (const shape of shapes) {
  test(`P4.5 matrix: digest Done issues ${shape}: the issue done on page 2 is listed once, or no digest and no heartbeat`, async t => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
    t.after(() => mock.timers.reset());
    const rows = Array.from({ length: 101 }, (_, i) => ({ id: `MET-${i + 1}`, title: i === 100 ? 'late Done sentinel' : 'long done', completedAt: i === 100 ? '2026-10-24T14:00:00Z' : '2026-10-01T00:00:00Z' }));
    const done = pager(rows, shape, 'linear', 'issues');
    const orb = controlOrb((name, input) => name === 'linear.list_issues' && input.state === 'Done' ? done.read(input) : emptyWork(name));
    await orb.start();
    await settle();
    const outcome = () => ({ digests: orb.alerts.filter(text => text.startsWith('ODD digest')).length, sentinel: orb.alerts.filter(text => /^- MET-101 late Done sentinel$/m.test(text)).length, heartbeats: orb.updates.length });
    assert.deepEqual(outcome(), shape === 'empty' ? { digests: 1, sentinel: 0, heartbeats: 1 } : failing(shape) ? { digests: 0, sentinel: 0, heartbeats: 0 } : { digests: 1, sentinel: 1, heartbeats: 1 });
    done.state.broken = false;
    await advance(sweepMs);
    if (failing(shape)) assert.deepEqual(outcome(), { digests: 1, sentinel: 1, heartbeats: 1 }, 'the next sweep posts the full digest once');
  });

}

for (const shape of slackShapes) {
  test(`P4.5 matrix: digest-posted check ${shape}: a digest posted on page 2 is never posted again`, async t => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-24T15:00:00Z') });
    t.after(() => mock.timers.reset());
    // #factory-alerts today: other alerts, then the day's digest past the first page. Slack filters each page after the limit.
    const rows = Array.from({ length: 101 }, (_, i) => ({ ts: `1761300000.${String(i).padStart(6, '0')}`, text: i === 100 ? 'ODD digest 2026-10-24\nMerged PRs (0):' : `alert ${i}` }));
    const alerts = pager(rows, shape, 'slack', 'messages');
    const orb = controlOrb((name, input) => {
      if (name !== 'slack_read' || input.channelName !== 'factory-alerts') return emptyWork(name);
      const page = alerts.read(input) as { messages: ({ text: string } | null)[] };
      const terms = (input.filter as { containsAll: string[] }).containsAll;
      return { ...page, messages: page.messages.filter(message => message === null || terms.every(term => message.text.includes(term))) };
    });
    await orb.start();
    await settle();
    const outcome = () => ({ reposted: orb.alerts.filter(text => text.startsWith('ODD digest')).length, heartbeats: orb.updates.length });
    // An empty channel is a true "not posted yet": the digest goes out.
    assert.deepEqual(outcome(), shape === 'empty' ? { reposted: 1, heartbeats: 1 } : failing(shape) ? { reposted: 0, heartbeats: 0 } : { reposted: 0, heartbeats: 1 });
    alerts.state.broken = false;
    await advance(sweepMs);
    if (failing(shape)) assert.deepEqual(outcome(), { reposted: 0, heartbeats: 1 }, 'the next sweep finds the digest and still does not repost');
  });
}

// --- P4.1: durable spawn intent and one admission queue --------------------------------

const rolesIn = (plant: ReturnType<typeof factory>, role: string) => [...plant.threads.values()].filter(thread => thread.labels.includes(`odd-role-${role}`));

test('P4.1: duplicate events separated by a reload, with thread search lagging, create and message one reviewer and one builder, each bound by its odd-spawn record', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  plant.control.indexLag = true;
  plant.control.launch = true;
  plant.issue('MET-50', 'In Progress');
  plant.builder('MET-50');
  plant.openPr('MET-50', 'a'.repeat(40));
  plant.issue('MET-51', 'Todo');
  await plant.start();
  await settle();
  assert.equal(rolesOf(plant, 'MET-50', 'reviewer').length, 1);
  assert.equal(rolesOf(plant, 'MET-51', 'builder').length, 1);

  // Reload: no memory survives and thread search still returns neither thread. The duplicate events (sweep, rechecks) find them by their records.
  await plant.start();
  await settle();
  await advance(5 * 60_000);
  assert.equal(plant.creates.length, 2, 'one create per issue across the reload');
  assert.equal(rolesOf(plant, 'MET-50', 'reviewer').length, 1);
  assert.equal(rolesOf(plant, 'MET-51', 'builder').length, 1);
  assert.deepEqual(plant.dms, []);
  // One record per spawn: written before the create, bound to the returned ID before the outcome is sent.
  const reviewer = [...plant.threads].find(([, thread]) => thread.labels.includes('odd-role-reviewer'))![0];
  const builder = [...plant.threads].find(([, thread]) => thread.labels.includes('odd-issue-met-51'))![0];
  assert.deepEqual(plant.spawnLines('MET-50'), ['odd-spawn role=reviewer round=1 key=reviewer-aaaaaaaaaaaa thread=pending', `odd-spawn role=reviewer round=1 key=reviewer-aaaaaaaaaaaa thread=${reviewer}`]);
  assert.deepEqual(plant.spawnLines('MET-51'), ['odd-spawn role=builder round=1 key=builder thread=pending', `odd-spawn role=builder round=1 key=builder thread=${builder}`]);
});

test('P4.1: an ambiguous create keeps its reservation: no second thread or launch across rechecks and a reload, and the failure pages', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  plant.control.indexLag = true;
  // The reviewer create fails after the thread exists; the builder launcher prints no session_id.
  plant.control.ambiguous = true;
  plant.issue('MET-52', 'In Progress');
  plant.builder('MET-52');
  plant.openPr('MET-52', 'b'.repeat(40));
  plant.issue('MET-53', 'Todo');
  await plant.start();
  await settle();
  assert.deepEqual(plant.creates.sort(), ['builder', 'plugin']);
  await advance(6 * 60_000);
  await plant.start();
  await advance(15 * 60_000);
  assert.deepEqual(plant.creates.sort(), ['builder', 'plugin'], 'neither create is retried blind');
  assert.deepEqual(plant.spawnLines('MET-52'), ['odd-spawn role=reviewer round=1 key=reviewer-bbbbbbbbbbbb thread=pending']);
  assert.deepEqual(plant.spawnLines('MET-53'), ['odd-spawn role=builder round=1 key=builder thread=pending']);
  assert.equal((plant.comments.get('MET-53') ?? []).filter(comment => comment.body.startsWith('odd-launch-failed')).length, 1, 'the launch failure is still reported once');
  assert.ok(!plant.saves.includes('MET-53 "In Progress"'), 'the issue status is unchanged');
  // Each page names the record to reconcile.
  assert.match(plant.dms.join('\n'), /ODD page: action-failed \| issue MET-52 \| .*spawn-reviewer failing .*socket hang up \(odd-spawn role=reviewer round=1 key=reviewer-bbbbbbbbbbbb thread=pending stays pending/);
  assert.match(plant.dms.join('\n'), /ODD page: action-failed \| issue MET-53 \| .*spawn-builder failing .*no live launch \(odd-spawn role=builder round=1 key=builder thread=pending stays pending/);
  const events = await plant.events();
  assert.ok(events.some(event => event.issue === 'MET-52' && /odd-spawn role=reviewer round=1 key=reviewer-bbbbbbbbbbbb thread=pending has no confirmed thread/.test(event.error ?? '')));
});

test('P4.1: each interruption boundary of a spawn resolves to one thread with its round: a failed reservation creates nothing; a lost binding is reconciled from the labelled thread, never relaunched', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  plant.control.indexLag = true;
  // Before the create: the reservation write fails once, so no thread is created until it lands.
  let reservationFailures = 1;
  plant.control.inject = (name, input) => {
    if (name === 'linear.save_comment' && /^odd-spawn .* thread=pending$/.test(String(input.body)) && reservationFailures-- > 0) throw new Error('Linear 503');
    return undefined;
  };
  plant.issue('MET-54', 'In Progress');
  plant.builder('MET-54');
  plant.openPr('MET-54', 'c'.repeat(40));
  await plant.start();
  await settle();
  assert.deepEqual(plant.creates, [], 'no create without its record');
  assert.deepEqual(plant.spawnLines('MET-54'), []);
  // After the create, before the binding: the thread is labelled, the binding write fails, nothing is sent.
  plant.control.bindFailures = 1;
  await advance(90_000);
  assert.deepEqual(plant.creates, ['plugin']);
  assert.deepEqual(plant.spawnLines('MET-54'), ['odd-spawn role=reviewer round=1 key=reviewer-cccccccccccc thread=pending']);
  // Thread search still lags: the pending record holds and fails closed.
  await advance(5 * 60_000);
  assert.deepEqual(plant.creates, ['plugin'], 'an unconfirmed record is never relaunched');
  // Search catches up: the one thread with the record's labels binds it, with its round, and the issue waits on it.
  plant.index();
  await advance(10 * 60_000);
  assert.deepEqual(plant.creates, ['plugin']);
  assert.deepEqual(plant.spawnLines('MET-54'), ['odd-spawn role=reviewer round=1 key=reviewer-cccccccccccc thread=pending', 'odd-spawn role=reviewer round=1 key=reviewer-cccccccccccc thread=T-spawned-1']);
  assert.deepEqual(rolesOf(plant, 'MET-54', 'reviewer').map(thread => thread.labels.find(label => label.startsWith('odd-round-'))), ['odd-round-1']);
});

test('P4.1: concurrent issue, Slack and log-reader admissions stay at 4 orbs, 2 runner slots and 2 build issues while thread search returns nothing new', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  plant.control.indexLag = true;
  plant.control.launch = true;
  // Orb demand 6 for 4 orbs: an issue Intake, a Slack Intake, 3 Builders (2 build slots) and a Verifier, evaluated in that
  // order or racing it; runner demand 3 log readers for 2 runner slots.
  plant.issues.set('MET-60', { id: 'MET-60', status: 'Triage', labels: [], description: '' });
  for (const id of ['MET-61', 'MET-62', 'MET-63']) plant.issue(id, 'Todo');
  for (const [i, id] of ['MET-64', 'MET-65', 'MET-66', 'MET-67'].entries()) {
    plant.issue(id, 'Deploying');
    plant.say(id, deployReceiptLine({ host: 'gpu', component: 'kiosk', sha: String(i + 1).repeat(40), health: i === 3 ? 'pass' : 'fail', rollback: i === 3 ? 'none' : '/var/backups/kiosk/snap' }));
  }
  const slack = [{ ts: '1761490000.000001', text: 'slack intake', userID: 'U1' }];
  plant.control.inject = (name, input) => name === 'slack_read' && input.channelName === '#factory-intake' && input.operation === 'read_messages' ? { messages: slack } : undefined;
  const running = () => {
    const live = [...plant.threads.values()].filter(thread => !thread.archived && thread.state === 'running');
    const count = (roles: string[]) => live.filter(thread => roles.some(role => thread.labels.includes(`odd-role-${role}`))).length;
    return { orbs: count(['intake', 'spec', 'builder', 'reviewer', 'verifier']), runnerSlots: count(['deployer']), buildIssues: new Set(live.filter(thread => thread.labels.includes('odd-role-builder')).map(thread => thread.labels.find(label => label.startsWith('odd-issue-')))).size };
  };
  await plant.start();
  await settle();
  // Rechecks of every issue fire together and race the Slack poll and the sweep.
  await advance(30 * 60_000);
  assert.deepEqual(running(), { orbs: capacity.orbs, runnerSlots: capacity.runnerSlots, buildIssues: capacity.buildIssues });
  assert.equal(plant.hidden.size, capacity.orbs + capacity.runnerSlots, 'thread search returned none of them');
  // Search catches up and nothing has finished: still nothing past the caps.
  plant.index();
  await advance(20 * 60_000);
  assert.deepEqual(running(), { orbs: capacity.orbs, runnerSlots: capacity.runnerSlots, buildIssues: capacity.buildIssues });
});

// --- MET-348: outcome correction budget through the plugin -------------------------------------

/** MET-7 In Progress with an idle builder and a green PR; `reject(n, head)` moves the PR to `head` and has a reviewer reject it. Linear labels follow writes. */
function correcting() {
  const plant = factory();
  plant.issue('MET-7', 'In Progress');
  plant.builder('MET-7');
  plant.openPr('MET-7', head(1));
  plant.control.inject = (call, input) => {
    if (call === 'linear.save_issue' && Array.isArray(input.addLabels)) plant.issues.get(String(input.id))!.labels.push(...input.addLabels as string[]);
    return undefined;
  };
  const reject = (n: number, sha: string) => {
    const pr = plant.prs[0];
    pr.headRefOid = sha;
    pr.commits = [{ oid: sha, committedDate: new Date().toISOString() }];
    plant.threads.set(`T-r${n}`, { labels: ['odd-issue-met-7', 'odd-role-reviewer', `odd-round-${n}`, 'odd-engine-openai', `odd-verdict-changes-${sha.slice(0, 12)}`], state: 'idle', archived: false, updatedAt: new Date().toISOString() });
  };
  /** Escalation DMs; archiving a reviewer records its routing, which the fixture cannot serve (an unchanged, separate page). */
  const pages = () => plant.dms.filter(dm => !dm.includes('subscription-mismatch'));
  const lines = (prefix: string) => (plant.comments.get('MET-7') ?? []).filter(comment => comment.body.startsWith(prefix));
  return { plant, reject, lines, pages };
}

test('MET-348 matrix: third and fourth heads are corrected inside one fixed 120-minute epoch; at the deadline correction holds and pages once; reloads, duplicates and replacement workers never extend it', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-27T03:00:00Z') });
  t.after(() => mock.timers.reset());
  const { plant, reject, lines, pages } = correcting();
  reject(1, head(1));
  await plant.start();
  await settle();
  // The admission rechecks at once (a 0 ms timer), which delivers the steer.
  mock.timers.tick(0);
  await settle();
  // The budget is recorded before the first correction steer.
  assert.deepEqual(lines('odd-budget').map(comment => comment.body.split(' contract=')[0]), ['odd-budget epoch=1 start=2026-10-27T03:00:00.000Z deadline=2026-10-27T05:00:00.000Z']);
  assert.equal(plant.steers.length, 1);
  const order = (plant.comments.get('MET-7') ?? []).map(comment => comment.body.split(' ')[0]);
  assert.ok(order.indexOf('odd-budget') < order.indexOf('odd-steer'), 'budget before steer');
  // Heads 2, 3 and 4 are rejected inside the window, across a reload and a replacement builder thread.
  for (const [n, minutes] of [[2, 20], [3, 40], [4, 60]] as const) {
    void minutes;
    await advance(20 * 60_000);
    if (n === 3) await plant.start();
    if (n === 4) {
      plant.threads.get('T-MET-7')!.archived = true;
      plant.threads.set('T-MET-7b', { labels: ['odd-issue-met-7', 'odd-role-builder', 'odd-round-2', 'odd-engine-anthropic'], state: 'idle', archived: false, updatedAt: new Date().toISOString() });
    }
    reject(n, head(n));
    await advance(11 * 60_000);
  }
  assert.equal(plant.steers.length, 4, 'every head inside the budget is corrected');
  assert.ok(plant.steers.slice(2).every(steer => steer.includes('design reassessment')), 'from the second rejected head the handoff asks for a reassessment');
  assert.deepEqual(pages(), [], 'no round-count-only page');
  assert.equal(lines('odd-budget').length, 1, 'reloads, new heads and a replacement worker do not record another budget');
  assert.deepEqual(plant.launches, [], 'no live role launched');
  // The builder is working on head 4 when the deadline arrives: it is paged, not cancelled.
  plant.threads.get('T-MET-7b')!.state = 'running';
  await advance(Date.parse('2026-10-27T05:00:00Z') - Date.now() - 1);
  assert.deepEqual(pages(), [], 'not one millisecond before the deadline');
  await advance(10 * 60_000);
  assert.equal(pages().length, 1);
  assert.match(pages()[0], new RegExp(`^\\[odd\\] ODD page: budget-ceiling \\| issue MET-7 \\| PR #7 \\| ${head(4)} \\| default if silent: nothing more is started, steered or merged.*epoch 1 correction budget ended at 2026-10-27T05:00:00\\.000Z.*last blocker: builder running`));
  assert.ok(plant.issues.get('MET-7')!.labels.includes('escalated'));
  assert.equal(plant.threads.get('T-MET-7b')!.archived, false, 'running work is kept');
  assert.match(lines('odd-escalated')[0].body, /^odd-escalated reason=budget-ceiling pr=7 sha=\w{40} done=label,draft,page,archive\n/);
  // A ready verdict after the deadline does not merge; reloads and sweeps send nothing more.
  plant.threads.set('T-r5', { labels: ['odd-issue-met-7', 'odd-role-reviewer', 'odd-round-5', 'odd-engine-openai', `odd-verdict-ready-${head(4).slice(0, 12)}`], state: 'idle', archived: false, updatedAt: new Date().toISOString() });
  plant.threads.get('T-MET-7b')!.state = 'idle';
  await plant.start();
  await advance(30 * 60_000);
  assert.equal(pages().length, 1);
  assert.equal(plant.steers.length, 4);
  assert.equal(lines('odd-merge').length, 0);
  assert.equal(lines('odd-escalated').length, 1);
  // Devon removes the label: one odd-resume, across a reload; then epoch 2 records its own budget at its first correction.
  plant.issues.get('MET-7')!.labels = plant.issues.get('MET-7')!.labels.filter(label => label !== 'escalated');
  plant.threads.delete('T-r5');
  await advance(10 * 60_000);
  await plant.start();
  await advance(20 * 60_000);
  assert.deepEqual(lines('odd-resume').map(comment => comment.body), [`odd-resume escalation=${lines('odd-escalated')[0].id} epoch=2`]);
});

test('MET-348 matrix: an interrupted escalation retries only its missing steps, never resets on the escalation comment, and keeps legacy histories at the round cap', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-27T03:00:00Z') });
  t.after(() => mock.timers.reset());
  // Legacy: steered without a budget (prior history of unknown age), now at its third rejected head.
  const { plant, reject, lines, pages } = correcting();
  plant.say('MET-7', `odd-steer key=changes-${head(1).slice(0, 12)} thread=T-MET-7`);
  plant.say('MET-7', `odd-steer key=changes-${head(2).slice(0, 12)} thread=T-MET-7`);
  reject(1, head(1));
  reject(2, head(2));
  reject(3, head(3));
  plant.control.slackDown = 1;
  await plant.start();
  await settle();
  // The latch exists before any side effect; the label landed, Slack refused, no DM went out.
  assert.equal(lines('odd-escalated').length, 1);
  assert.match(lines('odd-escalated')[0].body, /^odd-escalated reason=third-failed-qa-round pr=7 sha=\w{40} done=label,draft,archive\n/);
  assert.deepEqual(pages(), []);
  assert.equal(lines('odd-budget').length, 0, 'a legacy history mints no budget');
  // The retry finishes the page once; the escalation comment granted no new epoch, so nothing is steered.
  await advance(90_000);
  assert.equal(pages().length, 1);
  assert.match(pages()[0], /ODD page: third-failed-qa-round \| issue MET-7 \| PR #7/);
  assert.match(lines('odd-escalated')[0].body, /done=label,draft,page,archive\n/);
  await plant.start();
  await advance(30 * 60_000);
  assert.equal(pages().length, 1);
  assert.equal(plant.steers.length, 0);
  assert.equal(plant.saves.filter(save => save.includes('escalated')).length, 1, 'the label is set once');
  assert.equal(lines('odd-resume').length, 0, 'no resume while the label is present');
});

// --- P4.6-recheck: a successful merge re-evaluates its issue at once ---

/** MET-8 with a ready verdict at its open PR's head. GitHub merges on `gh pr merge`; `lag` makes reads trail the merge. */
function readyToMerge() {
  const plant = factory();
  const sha = 'c'.repeat(40);
  const mergeSha = '7'.repeat(40);
  plant.issue('MET-8', 'In Progress');
  plant.builder('MET-8');
  plant.threads.set('T-review', { labels: ['odd-issue-met-8', 'odd-role-reviewer', 'odd-round-1', 'odd-engine-openai', `odd-verdict-ready-${sha.slice(0, 12)}`], state: 'idle', archived: false, updatedAt: new Date().toISOString() });
  plant.openPr('MET-8', sha);
  const open = { ...plant.prs[0] };
  // `search`: the merged search misses the PR; `open`: the open list and the PR view still show it open with its ready head; `openList`: only the open list does.
  const lag = { search: false, open: false, openList: false, mergeFailures: 0 };
  const merges: string[] = [];
  plant.control.gh = command => {
    if (command.startsWith('gh pr merge 8 ')) {
      merges.push(command);
      if (lag.mergeFailures > 0) { lag.mergeFailures -= 1; return { exitCode: 1, stdout: '', stderr: 'GraphQL: Base branch was modified. Review and try the merge again.' }; }
      Object.assign(plant.prs[0], { state: 'MERGED', mergeCommit: { oid: mergeSha }, mergedAt: new Date().toISOString() });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'gh pr view 8 --json mergeCommit --jq .mergeCommit.oid') return { exitCode: 0, stdout: `${mergeSha}\n`, stderr: '' };
    if (lag.search && /^gh pr list --search .* --state merged /.test(command)) return { exitCode: 0, stdout: '[]', stderr: '' };
    if ((lag.open || lag.openList) && /^gh pr list --state open /.test(command)) return github(command, [open]);
    if (lag.open && /^gh pr view 8 --json number,/.test(command)) return github(command, [open]);
    return undefined;
  };
  const receipts = () => (plant.comments.get('MET-8') ?? []).filter(comment => comment.body.startsWith('odd-merge pr=')).map(comment => comment.body);
  const deploying = () => plant.saves.includes('MET-8 "Deploying"');
  return { plant, lag, merges, receipts, deploying, receipt: `odd-merge pr=8 head=${sha} merge=${mergeSha} release=none` };
}

test('P4.6-recheck: a successful merge moves its issue to Deploying a second later, with no webhook and long before the next sweep', async t => {
  for (const name of ['merged search caught up', 'merged search lagging', 'open list lagging, PR view caught up']) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const { plant, lag, merges, receipts, deploying, receipt } = readyToMerge();
        await plant.start();
        await settle();
        assert.equal(merges.length, 1);
        assert.deepEqual(receipts(), [receipt]);
        assert.equal(deploying(), false, 'the merge itself does not set the status');
        // The merged PR is not searchable yet: the re-check reads it by the number its receipt names.
        lag.search = name === 'merged search lagging';
        // A stale open-list row for the merged PR is read as merged, not as an open PR whose view disagrees.
        lag.openList = name.startsWith('open list');
        await advance(1_000, 1_000);
        assert.ok(deploying(), 'Deploying one second after the merge');
        await advance(11 * 60_000);
        assert.equal(merges.length, 1, 'never merged twice');
        assert.deepEqual(receipts(), [receipt]);
      } finally {
        mock.timers.reset();
      }
    });
  }
});

test('P4.6-recheck: duplicate events, a lagging PR index, a failed merge and a failed receipt each yield one merge and one receipt, and Deploying only after the receipt', async t => {
  const cases = ['duplicate events', 'pending refusal re-check', 'open PR read lags the merge', 'merge error', 'receipt error'] as const;
  for (const name of cases) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const { plant, lag, merges, receipts, deploying, receipt } = readyToMerge();
        let receiptFailures = name === 'receipt error' ? 1 : 0;
        plant.control.inject = (tool, input) => {
          if (tool === 'linear.save_comment' && String(input.body).startsWith('odd-merge pr=') && receiptFailures > 0) { receiptFailures -= 1; throw new Error('Linear 503'); }
          return undefined;
        };
        if (name === 'merge error') lag.mergeFailures = 1;
        // GitHub's merge state lags CI: the first evaluation is refused and re-checks in 90 s.
        if (name === 'pending refusal re-check') plant.control.refuse = 'mergeStateStatus BLOCKED';
        await plant.start();
        await settle();
        if (name === 'pending refusal re-check') {
          assert.equal(merges.length, 0);
          plant.control.refuse = '';
          // An event (here a sweep request) merges while the refusal's 90 s re-check is pending; the merge's re-check replaces it.
          await plant.sweep();
          await settle();
        }
        if (name === 'open PR read lags the merge') lag.open = true;
        if (name === 'duplicate events') {
          // Two more evaluations race the merge's own re-check.
          void plant.sweep();
          void plant.sweep();
        }
        await advance(1_000, 1_000);
        const failed = ['merge error', 'receipt error', 'open PR read lags the merge'].includes(name);
        assert.equal(merges.length, 1, 'one merge attempt so far');
        assert.deepEqual(receipts(), name === 'merge error' || name === 'receipt error' ? [] : [receipt]);
        assert.equal(deploying(), !failed, failed ? 'no Deploying without a merge and its receipt' : 'Deploying one second after the merge');
        lag.open = false;
        // The failure re-check (90 s), still before the 10-minute sweep, completes the handoff.
        await advance(2 * 60_000);
        assert.equal(merges.length, name === 'merge error' ? 2 : 1, name === 'merge error' ? 'the failed merge is retried once' : 'never merged twice');
        assert.deepEqual(receipts(), [receipt], 'exactly one receipt');
        assert.ok(deploying());
      } finally {
        mock.timers.reset();
      }
    });
  }
});

const readers = (plant: ReturnType<typeof factory>) => [...plant.threads].filter(([, thread]) => thread.labels.includes('odd-role-deployer'));

test('P4.6-deployer-archive: a diagnosed idle log reader is archived once, also while a failed rollback keeps the issue in Deploying; running, undiagnosed and other-release readers stay', async t => {
  // Each case its own release, used by no other test: one module load remembers the readers it spawned.
  for (const [name, rollback, moved, red] of [['failed rollback, issue stays Deploying', 'none', 'Deploying', '0d1a'.repeat(10)], ['rolled back, issue moves to Todo', '/var/snap/1', 'Todo', '0d2a'.repeat(10)]] as const) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const plant = factory();
        plant.control.launch = true;
        plant.issue('MET-9', 'Deploying');
        plant.say('MET-9', deployLine(red, 'fail', rollback));
        const archives: string[] = [];
        plant.control.inject = (call, input) => { if (call === 'update_thread' && input.archived === true) archives.push(String(input.thread)); return undefined; };
        await plant.start();
        await settle();
        const [[id, reader]] = readers(plant);
        assert.equal(readers(plant).length, 1);
        assert.ok(reader.labels.includes(readerLabel(red)));
        assert.match(plant.outcomes.get(id)!, new RegExp(`add the label \`${diagnosedLabel(red)}\` to this thread`), 'the reader is told its handoff label');
        plant.issues.get('MET-9')!.status = moved;
        const sweep = async (state: string, labels: string[]) => {
          reader.state = state;
          reader.labels = [...reader.labels.filter(label => !label.startsWith('odd-diagnosed-')), ...labels];
          await advance(sweepMs);
        };
        await sweep('running', [diagnosedLabel(red)]);
        assert.equal(reader.archived, false, 'a running reader stays even with its label');
        await sweep('idle', []);
        assert.equal(reader.archived, false, `an idle reader without its diagnosed label stays (issue ${moved})`);
        await sweep('idle', [diagnosedLabel('f'.repeat(40))]);
        assert.equal(reader.archived, false, 'another release\'s diagnosed label is not this reader\'s handoff');
        await sweep('idle', [diagnosedLabel(red)]);
        assert.equal(reader.archived, true, `the diagnosed idle reader is archived (issue ${moved})`);
        await advance(3 * sweepMs);
        assert.deepEqual(archives.filter(archived => archived === id), [id], 'archived once');
        assert.equal(readers(plant).length, 1);
      } finally {
        mock.timers.reset();
      }
    });
  }
});

test('P4.6-deployer-archive: an archived reader is never respawned for its release across repeated receipts and a reload; a new release gets one reader and runner slots are freed', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  try {
    const plant = factory();
    // The fixture never applies a status write, so the issue stays in Deploying and every evaluation repeats the red receipt's action.
    plant.issue('MET-9', 'Deploying');
    const finish = async (sha: string) => {
      const found = readers(plant).filter(([, thread]) => thread.labels.includes(readerLabel(sha)));
      assert.equal(found.length, 1, `one reader for ${sha.slice(0, 12)}`);
      const [, thread] = found[0];
      thread.state = 'idle';
      thread.labels.push(diagnosedLabel(sha));
      await advance(sweepMs);
      assert.equal(thread.archived, true);
    };
    const [a, b, c] = ['0d3a', '0d4a', '0d5a'].map(x => x.repeat(10));
    plant.say('MET-9', deployLine(a, 'fail', '/var/snap/a'));
    await plant.start();
    await settle();
    await finish(a);
    await advance(2 * sweepMs);
    plant.say('MET-9', deployLine(a, 'fail', '/var/snap/a'));
    await advance(sweepMs);
    assert.equal(readers(plant).length, 1, 'a redelivered receipt for the archived release starts no reader');
    // Two further releases, each archived before any admission saw its reader indexed: the archived readers hold no runner slot.
    for (const sha of [b, c]) {
      plant.say('MET-9', deployLine(sha, 'fail', `/var/snap/${sha.slice(0, 4)}`));
      await advance(sweepMs);
      await finish(sha);
    }
    assert.equal(readers(plant).length, 3, 'one reader per release');
    // A restarted control orb: a fresh module load with no memory of the readers it spawned; only thread search remembers them.
    await plant.start((await import(`../../.amp/plugins/factory-odd.ts?restart=deployer-archive`)).default);
    await settle();
    await advance(2 * sweepMs);
    plant.say('MET-9', deployLine(a, 'fail', '/var/snap/a'));
    await advance(2 * sweepMs);
    assert.equal(readers(plant).length, 3, 'a reload and a repeated receipt start no reader for an archived release');
    assert.ok(readers(plant).every(([, thread]) => thread.archived));
  } finally {
    mock.timers.reset();
  }
});

test('P4.6-deployer-archive: a diagnosed reader thread search has never returned is archived and frees its runner slot for a waiting receipt; undiagnosed hidden readers keep theirs', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  try {
    const plant = factory();
    plant.control.indexLag = true;
    const shas = ['0d6a', '0d7a', '0d8a'].map(x => x.repeat(10));
    const ids = ['MET-91', 'MET-92', 'MET-93'];
    const readerOf = (sha: string) => [...plant.threads.values()].find(thread => thread.labels.includes(readerLabel(sha)));
    for (const [i, id] of ids.slice(0, 2).entries()) {
      plant.issue(id, 'Deploying');
      plant.say(id, deployLine(shas[i], 'fail', '/var/snap/x'));
    }
    await plant.start();
    await settle();
    assert.ok(readerOf(shas[0]) && readerOf(shas[1]), 'two readers fill both runner slots');
    plant.issue(ids[2], 'Deploying');
    plant.say(ids[2], deployLine(shas[2], 'fail', '/var/snap/x'));
    await advance(sweepMs);
    assert.equal(readerOf(shas[2]), undefined, 'a third reader waits for a runner slot');
    // The first reader finishes; thread search still returns neither.
    const first = readerOf(shas[0])!;
    first.state = 'idle';
    first.labels.push(diagnosedLabel(shas[0]));
    await advance(sweepMs);
    assert.equal(first.archived, true, 'the diagnosed reader is archived though search never returned it');
    assert.equal(readerOf(shas[1])!.archived, false, 'the running hidden reader stays');
    await advance(sweepMs);
    assert.ok(readerOf(shas[2]), 'the freed slot admits the waiting receipt\'s reader');
    assert.equal([...plant.threads.values()].filter(thread => thread.labels.includes('odd-role-deployer') && !thread.archived && thread.state === 'running').length, 2, 'never past 2 runner slots');
  } finally {
    mock.timers.reset();
  }
});

// --- P4.3: a merge at or before the latest failed receipt is history after a rollback -------

const mergedPr = (issue: string, n: number, mergedAt: string, over: Partial<Pr> = {}): Pr => {
  const sha = head(n);
  return { number: n, headRefName: `${issue.toLowerCase()}-x`, headRefOid: sha, state: 'MERGED', mergeCommit: { oid: '7'.repeat(40) }, mergedAt, mergeable: 'UNKNOWN', commits: [{ oid: sha, committedDate: '2026-10-26T10:00:00Z' }], statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], body: `closes ${issue}`, ...over };
};
/** MET-41's first release: PR #41 merged at 11:00, its merge receipt, then a red receipt at 12:00:02 that rolled it back. */
const rolledBack41 = (plant: ReturnType<typeof factory>, status: string) => {
  plant.issue('MET-41', status);
  plant.prs.push(mergedPr('MET-41', 41, '2026-10-26T11:00:00Z'));
  plant.say('MET-41', `odd-merge pr=41 head=${head(41)} merge=${'7'.repeat(40)} release=none`);
  plant.say('MET-41', deployLine('7'.repeat(40), 'fail', 'd'.repeat(12)));
};
const builder41 = ['odd-issue-met-41', 'odd-role-builder', 'odd-round-1', 'odd-engine-anthropic'];
const guardMessage = async (plant: ReturnType<typeof factory>) => ((await plant.guard(builder41)) as { userMessage?: string } | undefined)?.userMessage;

test('P4.3: rollback -> Todo -> a new builder with no new PR never returns to Deploying, and the old merge does not meet its stop', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const plant = factory();
  plant.control.launch = true;
  rolledBack41(plant, 'Deploying');
  await plant.start();
  await settle();
  assert.ok(plant.saves.includes('MET-41 "Todo"'), 'the red receipt returns the issue to Todo');

  // Its log reader posted the diagnosis and idled.
  for (const reader of rolesOf(plant, 'MET-41', 'deployer')) Object.assign(reader, { state: 'idle', labels: [...reader.labels, diagnosedLabel('7'.repeat(40))] });
  plant.issues.get('MET-41')!.status = 'Todo';
  await plant.sweep();
  await settle();
  const builders = rolesOf(plant, 'MET-41', 'builder');
  assert.equal(builders.length, 1, 'Todo starts a fresh builder although the old PR is merged');

  // The builder ran and idled without opening a PR.
  plant.issues.get('MET-41')!.status = 'In Progress';
  builders[0].state = 'idle';
  const before = plant.saves.length;
  await plant.sweep();
  await settle();
  await advance(30 * 60_000);
  assert.ok(!plant.saves.includes('MET-41 "Deploying"'), `never Deploying off the rolled-back merge: ${plant.saves.slice(before).join('; ')}`);
  assert.equal((plant.comments.get('MET-41') ?? []).filter(comment => comment.body.startsWith('odd-merge')).length, 1, 'no merge receipt is recovered for the old PR');
  assert.match(await guardMessage(plant) ?? '', /no open PR for MET-41/, 'the Ralph guard continues the builder');
});

test('P4.3: after a rollback a new owned open or later-merged PR advances; mentions and equal or older merges stay excluded', async t => {
  // Each row adds PRs to the rolled-back issue. The old #41 is listed first (as newest), so a later merge must not hide behind it.
  const cases: { name: string; add: (plant: ReturnType<typeof factory>) => void; deploying: boolean; reviewer: boolean; stop: boolean }[] = [
    { name: 'no new PR (control)', add: () => {}, deploying: false, reviewer: false, stop: false },
    // The red receipt is 12:00:02.000Z in Linear's format; GitHub reports the same instant without milliseconds.
    { name: 'owned merge at the failure instant', add: plant => plant.prs.push(mergedPr('MET-41', 42, '2026-10-26T12:00:02Z')), deploying: false, reviewer: false, stop: false },
    { name: 'owned merge before the failure', add: plant => plant.prs.push(mergedPr('MET-41', 43, '2026-10-26T12:00:01Z')), deploying: false, reviewer: false, stop: false },
    { name: 'later merge that only mentions MET-41', add: plant => plant.prs.push(mergedPr('MET-41', 44, '2026-10-26T13:00:00Z', { headRefName: 'met-279-x', body: 'contributes MET-279\n\nMET-41 was rolled back.' })), deploying: false, reviewer: false, stop: false },
    { name: 'owned merge one second after the failure', add: plant => plant.prs.push(mergedPr('MET-41', 45, '2026-10-26T12:00:03Z')), deploying: true, reviewer: false, stop: true },
    { name: 'new owned open PR', add: plant => plant.openPr('MET-41', head(46), { number: 46 }), deploying: false, reviewer: true, stop: true },
  ];
  for (const { name, add, deploying, reviewer, stop } of cases) {
    await t.test(name, async () => {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-26T15:00:00Z') });
      try {
        const plant = factory();
        rolledBack41(plant, 'In Progress');
        plant.builder('MET-41');
        add(plant);
        await plant.start();
        await settle();
        assert.equal(plant.saves.includes('MET-41 "Deploying"'), deploying, plant.saves.join('; '));
        assert.equal(rolesOf(plant, 'MET-41', 'reviewer').length, reviewer ? 1 : 0);
        const message = await guardMessage(plant);
        assert.equal(message === undefined, stop, message);
        if (!stop) assert.match(message ?? '', /no open PR for MET-41/);
      } finally {
        mock.timers.reset();
      }
    });
  }
});
