import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builderArgs, io, launch, type Launcher } from './launch.ts';
import { reviewerEngines } from './engines.ts';
import { fakeConnections, fakeShell, servedBy } from './fixtures.ts';
import plugin from '../../.amp/plugins/factory-odd.ts';

const child = 'T-11111111-1111-4111-8111-111111111111';
const init = (id: string) => JSON.stringify({ type: 'system', subtype: 'init', cwd: '/home/user/workspace/repo', session_id: id, tools: [] });

/**
 * A fake `amp -ox --stream-json`: prints `lines`, then keeps streaming (like a running child turn)
 * until it is killed, unless `exits` says it ends by itself. Records what happened, in order.
 */
function fakeLauncher(lines: string[], options: { exits?: boolean; stderr?: string; onStart?: (argv: readonly string[]) => void } = {}) {
  const events: string[] = [];
  const launches: (readonly string[])[] = [];
  const start = (argv: readonly string[]): Launcher => {
    launches.push(argv);
    events.push('start');
    options.onStart?.(argv);
    let stop: () => void = () => {};
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    return {
      lines: (async function* () {
        for (const line of lines) yield line;
        if (!options.exits) await stopped;
      })(),
      stderr: () => options.stderr ?? '',
      kill: () => { events.push('kill'); stop(); },
    };
  };
  return { start, events, launches };
}

test('launch reads the session_id from stream-json, lets the caller record the child, and only then ends the launcher', async t => {
  const fake = fakeLauncher(['not json', JSON.stringify({ type: 'system', session_id: 'not-a-thread' }), init(child), JSON.stringify({ type: 'assistant' })]);
  mock.method(io, 'start', fake.start);
  t.after(() => mock.restoreAll());
  const id = await launch(['-ox', 'prompt'], async id => {
    await new Promise(resolve => setImmediate(resolve));
    fake.events.push(`own ${id}`);
  });
  assert.equal(id, child);
  assert.deepEqual(fake.events, ['start', `own ${child}`, 'kill']);
});

test('launch fails visibly and ends the launcher when amp exits without a session_id, never prints one, or the caller cannot record the child', async t => {
  t.after(() => mock.restoreAll());
  const exited = fakeLauncher([JSON.stringify({ type: 'result', subtype: 'error' })], { exits: true, stderr: 'Error: orb quota reached' });
  mock.method(io, 'start', exited.start);
  await assert.rejects(launch(['-ox'], async () => assert.fail('no child to own')), /amp exited without a session_id: Error: orb quota reached/);
  assert.deepEqual(exited.events, ['start', 'kill']);

  const silent = fakeLauncher([]);
  mock.method(io, 'start', silent.start);
  await assert.rejects(launch(['-ox'], async () => assert.fail('no child to own'), 20), /no session_id from amp within 0.02 s/);
  assert.deepEqual(silent.events, ['start', 'kill']);

  const unowned = fakeLauncher([init(child)]);
  mock.method(io, 'start', unowned.start);
  await assert.rejects(launch(['-ox'], async () => { throw new Error('Linear 503'); }), /Linear 503/);
  assert.deepEqual(unowned.events, ['start', 'kill']);
});

test('builder args pin Claude Code, the model and effort, the orb project, streaming, and every label at creation', () => {
  const args = builderArgs('PROMPT', ['odd-issue-met-7', 'odd-role-builder', 'odd-round-2'], 'MET-7 builder round 2');
  assert.deepEqual(args, ['-ox', 'PROMPT', '--mode', 'external-agent:claude-code', '--features', 'model:claude-opus-5-5,effort:high',
    '--project', 'Metacomet-Technologies/factory', '--title', 'MET-7 builder round 2', '--visibility', 'workspace', '--no-archive-after-execute', '--stream-json',
    '--label', 'odd-issue-met-7', '--label', 'odd-role-builder', '--label', 'odd-round-2', '--label', 'odd-engine-anthropic']);
});

// --- The registered plugin, armed in a control thread, with fake Amp threads, Linear, GitHub and Slack.

const spec = `## Goal\nShip it.\n\n## Isolation\nscripts/odd/\n\n## Build\n- change\n\n## Done means\n- it works\n\n## Evidence\n- node --test scripts/odd`;
const sha = 'a'.repeat(40);

type FakeThread = { id: string; labels: string[]; state: string; archived: boolean; model?: string; mode?: string; steers: string[] };
type Pr = { number: number; headRefName: string; headRefOid: string; state: 'OPEN' | 'MERGED'; mergeCommit?: { oid: string } | null; commits: { oid: string; committedDate: string }[]; statusCheckRollup: { name: string; conclusion: string }[]; body: string };

function controlPlane(options: { status?: string; threads?: Omit<FakeThread, 'archived' | 'steers'>[]; usage?: (id: string) => string; checkAccess?: (model: string) => unknown; launcher?: ReturnType<typeof fakeLauncher> } = {}) {
  const issue = { id: 'MET-7', status: options.status ?? 'Todo', labels: ['odd', 'Improvement', 'area:agents'], description: spec };
  const threads = new Map<string, FakeThread>((options.threads ?? []).map(thread => [thread.id, { ...thread, archived: false, steers: [] }]));
  const comments: string[] = [];
  const dms: string[] = [];
  const agentModels: { model?: string; reasoningEffort?: string }[] = [];
  let pr: Pr | undefined;
  let created = 0;
  const tools = { call: async (name: string, input: Record<string, unknown>) => {
    switch (name) {
      case 'linear.get_issue': return { ...issue, relations: { blockedBy: [] } };
      case 'linear.list_comments': return { comments: comments.map((body, i) => ({ body, createdAt: new Date(Date.UTC(2026, 9, 26, 0, i)).toISOString() })) };
      case 'linear.save_comment': comments.push(String(input.body)); return {};
      case 'linear.save_issue': if (typeof input.state === 'string') issue.status = input.state; return {};
      // The sweep's own enumeration is not under test; issues reach evaluation through webhooks.
      case 'linear.list_issues': return { issues: [], hasNextPage: false };
      case 'find_thread': {
        const label = /label:(\S+)/.exec(String(input.query))?.[1];
        return { threads: [...threads.values()].filter(thread => !thread.archived && thread.labels.includes(label ?? '')).map(({ id }) => ({ id, updatedAt: '2026-10-26T00:00:00.000Z' })) };
      }
      case 'get_thread_status': {
        const thread = threads.get(String(input.thread))!;
        return { metadata: { labels: [...thread.labels].sort(), archived: thread.archived }, agentState: { state: thread.state } };
      }
      case 'update_thread': threads.get(String(input.thread))!.archived = input.archived === true; return {};
      case 'slack_write': if (input.channelName === undefined) dms.push(String(input.text)); return {};
      case 'slack_read': return { messages: [] };
      case 'linear.get_status_updates': return { statusUpdates: [], hasNextPage: false };
      case 'linear.save_status_update': return { id: 'heartbeat' };
      default: return {};
    }
  } };
  const { $, commands } = fakeShell((command, values) => {
    // Ownership lists carry flat fields only; the owning PR's details come from `gh pr view`.
    const listed = (state: Pr['state']) => JSON.stringify(pr?.state === state ? [{ number: pr.number, headRefName: pr.headRefName, body: pr.body }] : []);
    if (command.startsWith('gh pr list --state open')) return listed('OPEN');
    if (command.startsWith('gh pr list --search')) return listed('MERGED');
    if (pr && command.startsWith(`gh pr view ${pr.number} --json number,`)) return JSON.stringify(pr);
    if (pr && command === `gh api repos/{owner}/{repo}/commits/${pr.headRefOid} --jq .commit.committer.date`) return `${pr.commits.find(commit => commit.oid === pr.headRefOid)!.committedDate}\n`;
    if (command.startsWith('amp threads usage')) return options.usage?.(String(values[0])) ?? '';
    if (command.startsWith('amp config model-providers check-access') && options.checkAccess) return JSON.stringify(options.checkAccess(String(values[0])));
    return undefined;
  });
  const handle = (id: string) => ({
    id,
    labels: async () => [...threads.get(id)!.labels].sort(),
    addLabels: async (labels: string[]) => { const thread = threads.get(id)!; thread.labels = [...new Set([...thread.labels, ...labels])]; return thread.labels; },
    appendUserMessage: async (message: { content: string }, opts?: { steer?: boolean }) => { threads.get(id)!.steers.push(`${opts?.steer ? 'steer' : 'append'}: ${message.content}`); },
  });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const webhooks = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  // Orbs only run plugin agents whose definition is registered as an active agent mode.
  const modes = new Map<string, unknown>();
  // The label a mode shows: its own, else its agent's display label (plugin API default).
  const modeLabels = new Map<string, string | undefined>();
  const amp = {
    $,
    createAgent: (config: { model?: string; reasoningEffort?: string }) => {
      agentModels.push({ model: config.model, reasoningEffort: config.reasoningEffort });
      return { definition: config, createThread: async (opts: { executor?: string }) => {
        const mode = [...modes].find(([, agent]) => agent === config)?.[0];
        if (opts.executor === 'orb' && !mode) throw new Error('Orb custom agents must be registered as an active agent mode');
        const id = `T-22222222-2222-4222-8222-${String(++created).padStart(12, '0')}`;
        threads.set(id, { id, labels: [], state: 'running', archived: false, model: config.model, mode, steers: [] });
        return { id, setLabels: async (labels: string[]) => { threads.get(id)!.labels = labels; return labels; }, appendUserMessage: async () => {} };
      } };
    },
    registerAgentMode: ({ key, label, agent }: { key: string; label?: string; agent: { display?: { label?: string } } }) => { modes.set(key, agent); modeLabels.set(key, label ?? agent.display?.label); }, registerTool: () => {},
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, handler); },
    createWebhook: async ({ key, handler }: { key: string; handler: (event: unknown, ctx: unknown) => Promise<void> }) => { webhooks.set(key, handler); return { url: `https://hooks.example/${key}` }; },
    system: { executor: { kind: 'remote', keepAlive: async () => {} } },
    threads: { get: handle },
  };
  const control = { id: 'T-control', labels: async () => ['odd-control-plane', 'odd-perform'] };
  const ctx = { thread: control, ui: { confirm: async () => true, notify: async () => {} }, logger: { log: () => {} }, tools, $ };
  let events = 0;
  return {
    issue, threads, comments, dms, commands, agentModels, modes, modeLabels,
    setPr: (next: Pr | undefined) => { pr = next; },
    async start() {
      if (options.launcher) mock.method(io, 'start', options.launcher.start);
      await (plugin as unknown as (api: unknown) => Promise<void>)(amp);
      await handlers.get('session.start')!({}, ctx);
      await settle();
    },
    async deliver() {
      await webhooks.get('linear')!({ id: `evt-${++events}`, receivedAt: '2026-10-26T00:00:01Z', body: new TextEncoder().encode(JSON.stringify({ data: { identifier: 'MET-7' } })) }, ctx);
      await settle();
    },
  };
}

const settle = async () => { for (let i = 0; i < 100; i++) await new Promise(resolve => setImmediate(resolve)); };

/** The launcher creates the child thread in its orb with the labels it was given (`--label`). */
function launcherFor(plane: () => ReturnType<typeof controlPlane>, options: { exits?: boolean; stderr?: string } = {}, lines = [init(child)]) {
  return fakeLauncher(lines, { ...options, onStart: argv => {
    if (!lines.length) return;
    const labels = argv.flatMap((value, i) => (argv[i - 1] === '--label' ? [value] : []));
    plane().threads.set(child, { id: child, labels, state: 'running', archived: false, model: 'anthropic/claude-opus-5-5', steers: [] });
  } });
}

const prWith = (state: 'OPEN' | 'MERGED', conclusion: string): Pr => ({ number: 41, headRefName: 'met-7-change', headRefOid: sha, state, mergeCommit: state === 'MERGED' ? { oid: 'b'.repeat(40) } : null, commits: [{ oid: sha, committedDate: '2026-10-26T00:00:00Z' }], statusCheckRollup: [{ name: 'scripts', conclusion }], body: 'closes MET-7' });
const claudeUsage = `## Model Routing\n\n| Model ID | Purpose | Routing | Requests | Cost |\n| --- | --- | --- | ---: | ---: |\n| anthropic/claude-opus-5-5 | Agent | Via [Subscription](https://ampcode.com/settings/model-routing#${fakeConnections[0].id}) | 40 | $0 |\n`;
const live = (plane: ReturnType<typeof controlPlane>) => [...plane.threads.values()].filter(thread => !thread.archived);

test('control plane: a builder launched through the CLI survives the launcher, keeps its labels and steering, records its routing and frees its orb on archival', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => { mock.timers.reset(); mock.restoreAll(); });
  let plane!: ReturnType<typeof controlPlane>;
  const launcher = launcherFor(() => plane);
  plane = controlPlane({ launcher, usage: id => (id === child ? claudeUsage : '') });
  await plane.start();
  await plane.deliver();

  assert.equal(launcher.launches.length, 1);
  const argv = launcher.launches[0];
  assert.deepEqual(argv.slice(2, 6), ['--mode', 'external-agent:claude-code', '--features', 'model:claude-opus-5-5,effort:high']);
  assert.ok(argv.includes('--stream-json') && argv[0] === '-ox');
  assert.deepEqual(launcher.events, ['start', 'kill'], 'the launcher is ended once the child is owned');
  assert.deepEqual([...plane.threads.get(child)!.labels].sort(), ['odd-engine-anthropic', 'odd-issue-met-7', 'odd-role-builder', 'odd-round-1']);
  assert.equal(plane.issue.status, 'In Progress');
  assert.ok(!plane.agentModels.some(agent => agent.model?.startsWith('anthropic/')), 'no plugin agent builds on Amp-paid Anthropic');
  assert.equal([...plane.threads.values()].filter(thread => thread.labels.includes('odd-role-builder')).length, 1);

  // The launcher is gone; the child keeps running in its orb and still owns the issue.
  await plane.deliver();
  assert.equal(launcher.launches.length, 1, 'no second builder while the first one runs');
  assert.equal(plane.threads.get(child)!.state, 'running');

  // Same-thread steering reaches the CLI-launched child.
  plane.threads.get(child)!.state = 'idle';
  plane.setPr(prWith('OPEN', 'FAILURE'));
  await plane.deliver();
  assert.deepEqual(plane.threads.get(child)!.steers, [`steer: [odd] CI failed at ${sha}. Fix the failing jobs and push; do not open a new PR.`]);

  // Merged: the issue leaves the builder's stage, so its idle thread is archived after its routing is recorded.
  plane.setPr(prWith('MERGED', 'SUCCESS'));
  await plane.deliver();
  assert.equal(plane.issue.status, 'Deploying');
  await plane.deliver();
  assert.equal(plane.threads.get(child)!.archived, true);
  assert.equal(live(plane).length, 0, 'the archived builder no longer holds an orb or a build slot');
  assert.ok(plane.commands.includes(`amp threads usage ${child} --details`));
  assert.equal(plane.comments.filter(body => body.startsWith(`odd-routing thread=${child} role=builder engine=anthropic model=anthropic/claude-opus-5-5 result=match`)).length, 1);
  assert.deepEqual(plane.dms, []);
  assert.equal(launcher.launches.length, 1);
});

test('control plane: a launch that yields no child is a visible failure on the issue, and nothing else builds', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => { mock.timers.reset(); mock.restoreAll(); });
  let plane!: ReturnType<typeof controlPlane>;
  const launcher = launcherFor(() => plane, { exits: true, stderr: 'Error: No project matches' }, []);
  plane = controlPlane({ launcher });
  await plane.start();
  await assert.rejects(plane.deliver(), /amp exited without a session_id: Error: No project matches/);
  assert.deepEqual(launcher.events, ['start', 'kill']);
  assert.equal(plane.issue.status, 'Todo');
  assert.equal(plane.threads.size, 0, 'no plugin agent stands in for the builder');
  assert.equal(plane.comments.length, 1);
  assert.match(plane.comments[0], /^odd-launch-failed role=builder engine=anthropic model=anthropic\/claude-opus-5-5\n\n.*No project matches/);
});

const builder = (lab: string) => ({ id: child, labels: ['odd-issue-met-7', 'odd-role-builder', 'odd-round-1', `odd-engine-${lab}`], state: 'idle' });

// A live reviewer on another issue: one unit of load on its lab's subscription.
const busy = (lab: string, n: number) => ({ id: `T-44444444-4444-4444-8444-${String(n).padStart(12, '0')}`, labels: [`odd-issue-met-${8 + n}`, 'odd-role-reviewer', 'odd-round-1', `odd-engine-${lab}`], state: 'running' });
const reviewerCases = [
  { builderLab: 'anthropic', busyLabs: [], reviewerLab: 'openai', model: 'openai/gpt-6-astra', mode: 'odd-reviewer' },
  { builderLab: 'anthropic', busyLabs: ['openai'], reviewerLab: 'xai', model: 'xai/grok-4.7', mode: 'odd-reviewer-xai' },
  { builderLab: 'anthropic', busyLabs: ['xai'], reviewerLab: 'openai', model: 'openai/gpt-6-astra', mode: 'odd-reviewer' },
  // Same-lab refusal outweighs usage: the busier lab still reviews an OpenAI builder.
  { builderLab: 'openai', busyLabs: [], reviewerLab: 'xai', model: 'xai/grok-4.7', mode: 'odd-reviewer-xai' },
  { builderLab: 'openai', busyLabs: ['xai'], reviewerLab: 'xai', model: 'xai/grok-4.7', mode: 'odd-reviewer-xai' },
] as const;

for (const { builderLab, busyLabs, reviewerLab, model, mode } of reviewerCases) {
  test(`control plane: a ${builderLab} builder with busy [${busyLabs.join(', ')}] gets a ${reviewerLab} reviewer pinned to ${model} through registered mode ${mode}`, async t => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    t.after(() => mock.timers.reset());
    const plane = controlPlane({ status: 'In Progress', threads: [builder(builderLab), ...busyLabs.map(busy)] });
    plane.setPr(prWith('OPEN', 'SUCCESS'));
    await plane.start();
    await plane.deliver();
    const reviewers = live(plane).filter(thread => thread.labels.includes('odd-role-reviewer') && thread.labels.includes('odd-issue-met-7'));
    assert.equal(reviewers.length, 1);
    assert.equal(reviewers[0].model, model);
    assert.equal(reviewers[0].mode, mode);
    assert.deepEqual([...reviewers[0].labels].sort(), [`odd-engine-${reviewerLab}`, 'odd-issue-met-7', 'odd-role-reviewer', 'odd-round-1']);
  });
}

test('control plane: every registered mode is discoverable from the plugin header, and each reviewer engine has its own mode', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const plane = controlPlane();
  await plane.start();
  const header = [...readFileSync(new URL('../../.amp/plugins/factory-odd.ts', import.meta.url), 'utf8').matchAll(/^\/\/ @amp-agent-mode (.+)$/gm)].map(m => JSON.parse(m[1]) as { key: string; label: string });
  assert.deepEqual(Object.fromEntries([...plane.modeLabels].sort()), Object.fromEntries(header.map(({ key, label }) => [key, label]).sort()));
  const reviewerModels = [...plane.modes].filter(([key]) => key.startsWith('odd-reviewer')).map(([, agent]) => (agent as { model: string }).model).sort();
  assert.deepEqual(reviewerModels, reviewerEngines.map(engine => engine.model).sort());
});

test('control plane: a ready verdict from the builder\'s own lab never merges; a reviewer from another lab is started instead', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const sameLab = { id: 'T-33333333-3333-4333-8333-333333333333', labels: ['odd-issue-met-7', 'odd-role-reviewer', 'odd-round-1', 'odd-engine-anthropic', `odd-verdict-ready-${sha.slice(0, 12)}`], state: 'idle' };
  const plane = controlPlane({ status: 'In Progress', threads: [builder('anthropic'), sameLab] });
  plane.setPr(prWith('OPEN', 'SUCCESS'));
  await plane.start();
  await plane.deliver();
  assert.ok(!plane.commands.some(command => command.includes('qa.ts') || command.startsWith('gh pr merge')), 'no merge on a same-lab verdict');
  const started = live(plane).filter(thread => thread.labels.includes('odd-role-reviewer') && thread.id !== sameLab.id);
  assert.equal(started.length, 1);
  assert.ok(started[0].labels.includes('odd-engine-openai'));
});

test('control plane: every plugin agent pins its model; a pin served off its subscription pages at arm, and a role served off its subscription pages when archived', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const paid = `## Model Routing\n\n| Model ID | Purpose | Routing | Requests | Cost |\n| --- | --- | --- | ---: | ---: |\n| anthropic/claude-opus-5-5 | Agent | Via Amp | 15 | $1.18 |\n`;
  const plane = controlPlane({
    status: 'Deploying',
    threads: [builder('anthropic')],
    usage: () => paid,
    checkAccess: model => (model === 'xai/grok-4.7' ? { ok: true, modelRouting: { kind: 'upstream-model-provider', modelProviderName: 'xAI', connectionType: null } } : servedBy(model)),
  });
  await plane.start();
  assert.ok(plane.agentModels.length >= 7, 'six roles, a second reviewer and the control thread');
  for (const agent of plane.agentModels) {
    assert.match(agent.model ?? '', /^(openai|xai)\//);
    assert.ok(agent.reasoningEffort, agent.model);
  }
  assert.ok(plane.commands.includes('amp config model-providers check-access --provider-model openai/gpt-6-astra --reasoning-effort high --thread T-control'));
  assert.ok(plane.commands.includes('amp config model-providers check-access --provider-model xai/grok-4.7 --reasoning-effort high --thread T-control'));
  // The arm-time sweep already reaches the issue (its builder thread is live), so both pages are out.
  await plane.deliver();
  assert.equal(plane.dms.length, 2, 'one page per mismatch, not per evaluation');
  assert.match(plane.dms.find(text => text.includes('issue - '))!, /^\[odd\] ODD page: subscription-mismatch \| issue - \| .*xai\/grok-4\.7 via xAI, expected SuperGrok connection Cursor/);
  assert.match(plane.dms.find(text => text.includes('issue MET-7'))!, /^\[odd\] ODD page: subscription-mismatch \| issue MET-7 \| .*builder thread T-1111.*via Amp, expected anthropic via Claude Subscription/);
  assert.equal(plane.threads.get(child)!.archived, true);
  assert.match(plane.comments.find(body => body.startsWith('odd-routing'))!, /result=mismatch\n- anthropic\/claude-opus-5-5 Agent: 15 via Amp\n- problem: /);
  assert.ok(!plane.dms.join('\n').includes(fakeConnections[0].id), 'no connection IDs in pages');
});
