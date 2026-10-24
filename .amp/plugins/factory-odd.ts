// @amp-agent-mode {"key":"odd-intake","label":"ODD Intake"}
// @amp-agent-mode {"key":"odd-spec","label":"ODD Spec"}
// @amp-agent-mode {"key":"odd-reviewer","label":"ODD Reviewer"}
// @amp-agent-mode {"key":"odd-verifier","label":"ODD Verifier"}
// @amp-agent-mode {"key":"odd-control","label":"ODD Control"}

import type { Agent, PluginAPI, PluginEventContext, ThreadID, WebhookEvent, WebhookHandlerContext } from '@ampcode/plugin'
import {
	capacity,
	contracts,
	issueTriaged,
	nextAction,
	parseThreadLabels,
	ralphGuard,
	specComplete,
	threadLabels,
	type Action,
	type IssueSnapshot,
	type Load,
	type Role,
} from '../../scripts/odd/lifecycle.ts'
import { intakeChannel, intakeEmoji, intakePrompt, pendingIntake, slackSourceLabel, type SlackMessage } from '../../scripts/odd/intake.ts'
import { finishedThreads, issueFromEvent, loadFrom, roleLabelQueries, toSnapshot, type GitHubPullRequest, type LinearIssue, type LiveThread } from '../../scripts/odd/snapshot.ts'

export const description =
	'Factory ODD control plane: Linear, GitHub and Slack webhooks drive a deterministic outcome lifecycle; role agents run in orbs; Ralph loops are bounded by external checks. See docs/odd/README.md.'

// The plugin is armed only in the control thread (label odd-control-plane). Everywhere else it
// registers the role modes and the Ralph guard and does nothing on its own. `perform` acts only
// when the control thread also carries odd-perform, and only for the roles already live:
// phase 3 (MET-278) spawns intake and spec and sets Triage/Todo; later phases add the rest.
const controlLabel = 'odd-control-plane'
const performLabel = 'odd-perform'
const marker = '[odd]'
const liveRoles: ReadonlySet<Role> = new Set<Role>(['intake', 'spec'])
const slackPollMs = 5 * 60_000

export default async function (amp: PluginAPI) {
	const roleAgent = (role: Role, extendsMode: 'low' | 'medium' | 'high', label: string, extra: string, tools?: { exclude?: string[] }): Agent =>
		amp.createAgent({
			extends: extendsMode,
			instructions: [
				`You are the Factory ${role} role under outcome driven development (docs/odd/README.md).`,
				`Load the project skill \`${contracts[role].skill}\` first and follow it as your contract.`,
				`Your external stop condition is "${contracts[role].stop}". Never claim it; produce the artifact that makes it true.`,
				'Never write artifacts another role is supposed to check. Never edit Done means. Follow AGENTS.md.',
				extra,
			].join(' '),
			tools: { add: ['mcp__linear__*', 'slack_read', 'slack_write', 'create_thread', 'get_thread_status', 'wait_for_threads'], ...tools },
			display: { label, color: '#0f766e' },
		})

	const modes: { key: string; label: string; agent: Agent }[] = [
		{ key: 'intake', label: 'ODD Intake', agent: roleAgent('intake', 'low', 'ODD Intake', 'Turn a message or bare issue into a Linear issue in the team template, with type and area labels and a duplicate check.') },
		{ key: 'spec', label: 'ODD Spec', agent: roleAgent('spec', 'medium', 'ODD Spec', 'Write Isolation, Build, Done means and Evidence; one Evidence line per Done-means item; set priority and risk.') },
		{ key: 'reviewer', label: 'ODD Reviewer', agent: roleAgent('reviewer', 'high', 'ODD Reviewer', 'Rerun the Evidence commands yourself at the exact head SHA. Verdict is bound to that SHA.', { exclude: ['edit_file', 'create_file'] }) },
		{ key: 'verifier', label: 'ODD Verifier', agent: roleAgent('verifier', 'low', 'ODD Verifier', 'Check each Done-means item against the deployed system using the Evidence lines and the deploy receipt.', { exclude: ['edit_file', 'create_file'] }) },
	]
	const agents: Partial<Record<Role, Agent>> = Object.fromEntries(modes.map((m) => [m.key, m.agent]))
	const control = amp.createAgent({
		extends: 'low',
		instructions: `You are the Factory ODD control thread. You own the webhooks and the watchdog schedule. Do not build, review or deploy yourself; the plugin spawns roles. When asked, summarise derived state. Label this thread ${controlLabel} to arm the plugin.`,
		tools: { add: ['mcp__linear__*', 'get_thread_status', 'send_thread_message'] },
		display: { label: 'ODD Control', color: '#b45309' },
	})

	for (const { key, label, agent } of [...modes, { key: 'control', label: 'ODD Control', agent: control }]) {
		amp.registerAgentMode({
			key: `odd-${key}`,
			description: `${label}: the ${key} role of outcome driven development. Use only when the ODD control plane or Devon starts it.`,
			agent: agent.definition,
		})
	}

	// --- Ralph guard: one rule for every role thread (docs/odd/README.md §5.3) -----------------
	const chained = new Map<ThreadID, number>()
	amp.on('agent.end', async (event, ctx) => {
		const labels = await ctx.thread.labels()
		await arm(ctx, labels)
		const { role, issue } = parseThreadLabels(labels)
		if (!role || !issue || event.status !== 'done') return
		const count = event.message.includes(marker) ? (chained.get(event.thread.id) ?? 0) : 0
		const { stopMet, missing } = await externalStop(ctx, role, issue)
		const verdict = ralphGuard({ role, chained: count, stopMet, missing })
		if (verdict.action === 'stop') {
			chained.delete(event.thread.id)
			ctx.logger.log(marker, role, issue, 'stop', verdict.why)
			return
		}
		chained.set(event.thread.id, count + 1)
		return { action: 'continue', userMessage: `${marker} ${verdict.userMessage}`, maxContinuations: verdict.maxContinuations }
	})

	// --- Control plane: armed only in the labelled control thread inside an orb ---------------
	// The label is usually set after the thread's first session.start, so every turn boundary
	// re-checks it; `armed` keeps the webhooks and the one-time URL dialog from repeating.
	// `urls` are credentials: kept in memory, shown only through the confirm dialog, never returned.
	type HandledEvent = {
		at: string
		source: string
		issue: string | null
		stage: 'received' | 'ignored' | 'dry-run' | 'performed' | 'failed'
		status?: string
		action?: Action
		error?: string
	}
	type ArmState = {
		armed: boolean
		error?: string
		webhooks: string[]
		urls: string[]
		events: HandledEvent[]
		/** Slack intake poll: last run, last error, and the message timestamps handed to Intake. */
		slack: { polledAt?: string; error?: string; spawned: string[] }
		timer?: ReturnType<typeof setInterval>
	}
	const armState = new Map<ThreadID, ArmState>()
	const emptyState = (): ArmState => ({ armed: false, webhooks: [], urls: [], events: [], slack: { spawned: [] } })
	const record = (state: ArmState, event: HandledEvent) => {
		state.events.push(event)
		state.events.splice(0, Math.max(0, state.events.length - 20))
		return event
	}
	amp.on('session.start', async (_event, ctx) => arm(ctx, await ctx.thread.labels()))
	amp.on('agent.start', async (_event, ctx) => {
		await arm(ctx, await ctx.thread.labels())
		return {}
	})

	// Lets the control agent see why arming did or did not happen, and arm explicitly. Never
	// returns webhook URLs.
	amp.registerTool({
		name: 'odd_control_status',
		description:
			'ODD control plane state for this thread: labels, executor kind, whether webhooks are armed, last arming error, the last 20 handled events (webhooks and Slack intake polls), Slack poll state. Pass arm: true to arm now (control thread in an orb only). Pass poll_slack: true to poll #factory-intake now. Pass show_urls: true to show the webhook URLs to the human in a confirm dialog; the call blocks until they answer. URLs are never returned to the agent.',
		inputSchema: {
			type: 'object',
			properties: {
				arm: { type: 'boolean', description: 'Arm the control plane now if not armed' },
				poll_slack: { type: 'boolean', description: 'Poll #factory-intake now and hand new messages to Intake (dry run without the odd-perform label)' },
				show_urls: { type: 'boolean', description: 'Show the webhook URLs to the human in a dialog and wait for them to confirm' },
			},
		},
		async execute(input, ctx) {
			const labels = await ctx.thread.labels()
			if (input.arm === true) await arm(ctx, labels)
			const current = armState.get(ctx.thread.id)
			if (input.poll_slack === true && current?.armed) await pollSlackIntake(ctx, current)
			const { urls, timer: _timer, ...state } = current ?? emptyState()
			const dialog = input.show_urls === true && urls.length > 0 ? await showUrls(ctx, urls) : undefined
			return JSON.stringify({ thread: ctx.thread.id, labels, executor: amp.system.executor.kind, ...state, dialog })
		},
	})

	// What arming and the Slack poll need from a context; event, tool and webhook contexts all
	// provide it. Evaluating an issue also shells out to gh, which tool contexts cannot do.
	type ArmContext = Pick<WebhookHandlerContext, 'thread' | 'ui' | 'logger' | 'tools'>
	type EvalContext = ArmContext & Pick<WebhookHandlerContext, '$'>

	async function arm(ctx: ArmContext, labels: readonly string[]) {
		if (!labels.includes(controlLabel) || armState.has(ctx.thread.id)) return
		const state = emptyState()
		armState.set(ctx.thread.id, state)
		try {
			await armWebhooks(ctx, state)
			state.armed = true
			// Slack has no push path (its Events API needs a challenge reply a handler cannot send),
			// so #factory-intake is polled with the arming context's tools while the orb lives.
			state.timer = setInterval(() => void pollSlackIntake(ctx, state), slackPollMs)
			void pollSlackIntake(ctx, state)
		} catch (error: unknown) {
			state.error = String(error)
			ctx.logger.log(marker, 'arming failed', state.error)
			await ctx.ui.notify(`${marker} control plane arming failed: ${state.error}`)
		}
	}

	async function armWebhooks(ctx: ArmContext, state: ArmState) {
		if (amp.system.executor.kind !== 'remote') {
			throw new Error(`control plane needs an Amp-managed orb; executor is ${amp.system.executor.kind}`)
		}
		await amp.system.executor.keepAlive().catch((error: unknown) => ctx.logger.log(marker, 'keepAlive failed', String(error)))
		const seen = new Set<string>()
		const handle = (source: 'linear' | 'github' | 'slack') => async (event: WebhookEvent, hctx: WebhookHandlerContext) => {
			if (seen.has(event.id)) return
			seen.add(event.id)
			const identifier = issueFromEvent(source, new TextDecoder().decode(event.body))
			if (!identifier) {
				record(state, { at: event.receivedAt, source, issue: null, stage: 'ignored' })
				return
			}
			const entry = await evaluate(hctx, state, source, identifier, event.receivedAt)
			if (entry.stage === 'failed') throw new Error(entry.error)
		}
		for (const key of ['linear', 'github', 'slack'] as const) {
			const { url } = await amp.createWebhook({ key, headers: ['x-hub-signature-256', 'linear-signature', 'x-slack-signature'], handler: handle(key) })
			state.webhooks.push(key)
			state.urls.push(`${key}: ${url}`)
		}
		// Not awaited: the dialog waits for a human and must not hold the turn boundary that
		// armed it. odd_control_status({ show_urls: true }) shows it again on demand and waits.
		void showUrls(ctx, state.urls).catch((error: unknown) => ctx.logger.log(marker, 'webhook dialog failed', String(error)))
	}

	// One evaluation of one issue: derive, decide, act (or dry-run). A webhook that arrives while
	// the owning role thread is still running decides `wait`, and that thread's end raises no
	// event here (its agent.end runs in its own orb), so the issue is re-evaluated after a delay
	// until the owner is idle. One pending re-check per issue.
	const recheckMs = 90_000
	const rechecks = new Map<string, ReturnType<typeof setTimeout>>()
	// Linear sends several webhooks for one change and `find_thread` indexes a new thread with a
	// lag, so evaluations of one issue run one at a time and remember the threads they spawned
	// until the index returns them; otherwise two events seconds apart spawn two role threads.
	const queues = new Map<string, Promise<unknown>>()
	const spawned = new Map<string, string[]>()
	function evaluate(ctx: EvalContext, state: ArmState, source: string, identifier: string, at: string): Promise<HandledEvent> {
		const run = (queues.get(identifier) ?? Promise.resolve()).then(() => evaluateNow(ctx, state, source, identifier, at))
		queues.set(identifier, run.catch(() => undefined))
		return run
	}
	async function evaluateNow(ctx: EvalContext, state: ArmState, source: string, identifier: string, at: string): Promise<HandledEvent> {
		const entry = record(state, { at, source, issue: identifier, stage: 'received' })
		try {
			const { snapshot: issue, threads } = await snapshotFor(ctx, identifier, spawned.get(identifier) ?? [])
			const finished = finishedThreads(issue.status, threads)
			if (finished.length && (await ctx.thread.labels()).includes(performLabel)) await archiveThreads(ctx, finished)
			const action = nextAction(issue, await currentLoad(ctx))
			ctx.logger.log(marker, source, issue.identifier, issue.status, JSON.stringify(action))
			entry.status = issue.status
			entry.action = action
			if (action.kind === 'wait' && action.reason.endsWith('running') && !rechecks.has(identifier)) {
				rechecks.set(identifier, setTimeout(() => {
					rechecks.delete(identifier)
					void evaluate(ctx, state, 'recheck', identifier, new Date().toISOString())
				}, recheckMs))
			}
			if (!(await ctx.thread.labels()).includes(performLabel)) {
				ctx.logger.log(marker, 'dry run; add label', performLabel, 'to act')
				entry.stage = 'dry-run'
				return entry
			}
			await perform(ctx, issue, action)
			entry.stage = 'performed'
		} catch (error: unknown) {
			entry.stage = 'failed'
			entry.error = String(error)
			ctx.logger.log(marker, source, 'evaluation failed', entry.error)
		}
		return entry
	}

	// Every fresh top-level message in #factory-intake gets its own Intake orb thread, then the
	// intake reaction so the next poll skips it. Intake creates the Linear issue (or comments on
	// the duplicate); the Linear webhook takes over from there.
	async function pollSlackIntake(ctx: ArmContext, state: ArmState) {
		const at = new Date().toISOString()
		state.slack.polledAt = at
		try {
			const read = await callJson<{ messages?: SlackMessage[] }>(ctx.tools, 'slack_read', {
				operation: 'read_messages',
				channelName: intakeChannel,
				lookback: 'P2D',
				limit: 50,
				include: { resolveUsers: true },
			})
			const perform = (await ctx.thread.labels()).includes(performLabel)
			for (const message of pendingIntake(read.messages ?? []).filter(message => !state.slack.spawned.includes(message.ts))) {
				const action: Action = { kind: 'spawn', role: 'intake', executor: 'orb', reason: `slack ${message.ts}`, round: 1 }
				const entry = record(state, { at, source: 'slack-poll', issue: null, stage: perform ? 'performed' : 'dry-run', action })
				if (!perform) continue
				try {
					const load = await currentLoad(ctx)
					if (load.orbs >= capacity.orbs) {
						entry.stage = 'dry-run'
						entry.action = { kind: 'wait', reason: 'orb capacity (intake)' }
						break
					}
					const thread = await spawnThread(ctx.thread.id, 'intake', ['odd-role-intake', 'odd-round-1', slackSourceLabel(message.ts)], intakePrompt(message, marker))
					state.slack.spawned.push(message.ts)
					await ctx.tools.call('slack_read', { operation: 'add_reaction', channelName: intakeChannel, messageTs: message.ts, emoji: intakeEmoji })
					ctx.logger.log(marker, 'slack intake', message.ts, '->', thread)
				} catch (error: unknown) {
					entry.stage = 'failed'
					entry.error = String(error)
					ctx.logger.log(marker, 'slack intake failed', message.ts, entry.error)
				}
			}
			delete state.slack.error
			// A Slack-sourced intake thread has no issue label, so no issue evaluation archives it.
			if (perform) {
				const idle = (await threadsFor(ctx.tools, 'label:odd-role-intake archived:false'))
					.filter(thread => thread.labels.some(label => label.startsWith('odd-slack-')) && thread.state === 'idle')
				await archiveThreads(ctx, idle)
			}
		} catch (error: unknown) {
			state.slack.error = String(error)
			ctx.logger.log(marker, 'slack poll failed', state.slack.error)
		}
	}

	async function spawnThread(parentThreadID: ThreadID, role: Role, labels: string[], content: string): Promise<string> {
		const agent = agents[role]
		if (!agent) throw new Error(`no plugin agent for role ${role}`)
		const thread = await agent.createThread({ executor: 'orb', parentThreadID, visibility: 'workspace' })
		await thread.setLabels(labels)
		await thread.appendUserMessage({ type: 'user-message', content })
		return thread.id
	}

	// The URLs are credentials, shown only in the control thread for Devon to paste into Linear,
	// GitHub and Slack. Never log or post them anywhere else.
	async function showUrls(ctx: Pick<PluginEventContext<'agent.end'>, 'ui'>, urls: readonly string[]) {
		const confirmed = await ctx.ui.confirm({ title: 'ODD webhook endpoints', message: urls.join('\n'), confirmButtonText: 'Configured', requireHuman: true })
		return confirmed ? 'configured' : 'dismissed'
	}

	// Phases 3-6 fill in `perform` stage by stage: phase 3 spawns intake and spec and moves
	// issues between Triage and Todo; steer and page are wired; merge and deploy are deferred.
	// While the dispatcher still owns Todo and later, ODD performs only on issues in the
	// statuses it owns (Backlog, Triage); an issue the orchestrator created in Todo without an
	// Evidence section must not be pulled back into Triage.
	async function perform(ctx: ArmContext, issue: IssueSnapshot, action: Action) {
		if (issue.status !== 'Backlog' && issue.status !== 'Triage') {
			ctx.logger.log(marker, 'deferred to a later phase', issue.identifier, issue.status, action.kind)
			return
		}
		switch (action.kind) {
			case 'spawn': {
				if (!liveRoles.has(action.role)) {
					ctx.logger.log(marker, 'deferred to a later phase', issue.identifier, action.role)
					return
				}
				if (action.executor !== 'orb') {
					// Subscription engines and runner jobs are launched by the runner backstop (§6).
					ctx.logger.log(marker, 'launch request for runner', issue.identifier, action.role)
					return
				}
				const threadID = await spawnThread(
					ctx.thread.id,
					action.role,
					threadLabels(issue.identifier, action.role, action.round),
					`${marker} Outcome ${issue.identifier}. Role: ${action.role}. Reason: ${action.reason}. Load the \`${contracts[action.role].skill}\` skill and start.`,
				)
				spawned.set(issue.identifier, [...(spawned.get(issue.identifier) ?? []), threadID])
				return
			}
			case 'set-status':
				await callJson(ctx.tools, 'linear.save_issue', { id: issue.identifier, state: action.status })
				return
			case 'steer':
				await amp.threads.get(action.threadID as ThreadID).appendUserMessage({ type: 'user-message', content: `${marker} ${action.message}` }, { steer: true })
				return
			case 'page':
				// Watchdog is the one voice (§8). Phase 6 posts to Slack; until then the control thread shows it.
				await ctx.ui.notify(`${marker} PAGE ${action.reason}: ${action.detail}`)
				return
			default:
				ctx.logger.log(marker, 'deferred to a later phase', action.kind)
		}
	}
}

// --- Derivation: Linear through the thread's MCP tools, GitHub through gh, Amp through thread search.
// Tool calls run without a model (PluginTools.call); the pure combination lives in scripts/odd/snapshot.ts.

type Tools = WebhookHandlerContext['tools']

// `ctx.tools.call` returns the full CallToolResult for MCP tools: the payload is JSON in the
// first text block (or `structuredContent` when the server provides it). Built-in tools return
// their result directly; pass those through unchanged.
async function callJson<T>(tools: Tools, name: string, input: Record<string, unknown>): Promise<T> {
	const result = (await tools.call(name, input)) as { structuredContent?: unknown; content?: { type: string; text?: string }[] } | T
	if (typeof result !== 'object' || result === null) return result as T
	const envelope = result as { structuredContent?: unknown; content?: { type: string; text?: string }[] }
	if (envelope.structuredContent !== undefined) return envelope.structuredContent as T
	const textBlock = envelope.content?.find(block => block.type === 'text' && typeof block.text === 'string')
	if (!textBlock) return result as T
	return JSON.parse(textBlock.text as string) as T
}

async function snapshotFor(ctx: Pick<WebhookHandlerContext, 'tools' | '$' | 'logger'>, identifier: string, knownThreads: readonly string[]): Promise<{ snapshot: IssueSnapshot; threads: LiveThread[] }> {
	const [issue, comments, pr, threads] = await Promise.all([
		callJson<LinearIssue>(ctx.tools, 'linear.get_issue', { id: identifier }),
		callJson<{ comments?: { body: string }[] }>(ctx.tools, 'linear.list_comments', { issueId: identifier, limit: 50 }).then(result => result.comments ?? []),
		pullRequestFor(ctx, identifier),
		threadsFor(ctx.tools, `label:odd-issue-${identifier.toLowerCase()} archived:false`, knownThreads),
	])
	// Open blockers are not exposed by the Linear MCP; phase 4 (MET-279) adds them before builders spawn.
	return { snapshot: toSnapshot({ issue: { ...issue, comments }, pr, threads, openBlockers: [] }), threads }
}

// Finished role threads are archived so the thread list shows only live work; an archived
// thread keeps its labels, so a later `find_thread … archived:false` no longer counts it.
async function archiveThreads(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, threads: readonly LiveThread[]) {
	for (const thread of threads) {
		await callJson(ctx.tools, 'update_thread', { thread: thread.id, archived: true })
		ctx.logger.log(marker, 'archived finished thread', thread.id)
	}
}

async function pullRequestFor(ctx: Pick<WebhookHandlerContext, '$' | 'logger'>, identifier: string): Promise<GitHubPullRequest | undefined> {
	const result = await ctx.$`gh pr list --search ${identifier} --state all --json number,headRefOid,state,mergeCommit,statusCheckRollup --limit 5`
	if (result.exitCode !== 0) {
		ctx.logger.log(marker, 'gh pr list failed', result.stderr.trim())
		return undefined
	}
	const prs = JSON.parse(result.stdout) as GitHubPullRequest[]
	// Prefer the open PR; otherwise the merged one, so a merged issue derives `Deploying`.
	return prs.find(pr => pr.state === 'OPEN') ?? prs.find(pr => pr.state === 'MERGED')
}

// `known` are thread IDs this control plane spawned that the search index may not return yet.
async function threadsFor(tools: Tools, query: string, known: readonly string[] = []): Promise<LiveThread[]> {
	const found = await callJson<{ threads: { id: string }[] }>(tools, 'find_thread', { query, limit: 100 })
	const ids = new Set([...found.threads.map(({ id }) => id), ...known])
	const threads = await Promise.all([...ids].map(async id => {
		const status = await callJson<{ metadata: { labels: string[]; archived?: boolean }; agentState?: { state?: string } }>(tools, 'get_thread_status', { thread: id })
		return { id, labels: status.metadata.labels, state: status.agentState?.state ?? 'idle', archived: status.metadata.archived === true }
	}))
	return threads.filter(thread => !thread.archived).map(({ archived: _, ...thread }) => thread)
}

async function currentLoad(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>): Promise<Load> {
	const threads = (await Promise.all(roleLabelQueries.map(query => threadsFor(ctx.tools, query)))).flat()
	const load = loadFrom(threads)
	ctx.logger.log(marker, 'load', JSON.stringify(load), 'of', JSON.stringify(capacity))
	return load
}

// The Ralph guard's external checks: each is read from Linear or GitHub, never from the agent.
async function externalStop(ctx: Pick<WebhookHandlerContext, '$' | 'tools'>, role: Role, issue: string): Promise<{ stopMet: boolean; missing: string[] }> {
	if (role === 'intake' || role === 'spec') {
		const snapshot = await callJson<LinearIssue>(ctx.tools, 'linear.get_issue', { id: issue })
		const missing = role === 'intake'
			? issueTriaged(snapshot)
			: specComplete(snapshot.description ?? '') ? [] : ['Goal, Isolation, Build, Done means and Evidence sections, with one Evidence line per Done-means item']
		return { stopMet: missing.length === 0, missing }
	}
	if (role !== 'builder') return { stopMet: true, missing: [] }
	const pr = await ctx.$`gh pr list --search ${issue} --state open --json number,headRefOid,statusCheckRollup --limit 1`
	if (pr.exitCode !== 0 || pr.stdout.trim() === '[]') return { stopMet: false, missing: [`no open PR for ${issue}`] }
	const [{ statusCheckRollup = [] }] = JSON.parse(pr.stdout) as Array<{ statusCheckRollup?: Array<{ name?: string; conclusion?: string; state?: string }> }>
	const failing = statusCheckRollup.filter(check => (check.conclusion ?? check.state ?? '').toUpperCase() in { FAILURE: 1, ERROR: 1, CANCELLED: 1 }).map(check => check.name ?? 'check')
	const pending = statusCheckRollup.some(check => !check.conclusion && (check.state ?? '').toUpperCase() !== 'SUCCESS')
	if (failing.length) return { stopMet: false, missing: failing.map(name => `CI job ${name} failed on the PR head`) }
	return pending ? { stopMet: false, missing: ['CI still running on the PR head'] } : { stopMet: true, missing: [] }
}
