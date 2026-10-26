// @amp-agent-mode {"key":"odd-intake","label":"ODD Intake"}
// @amp-agent-mode {"key":"odd-spec","label":"ODD Spec"}
// @amp-agent-mode {"key":"odd-builder","label":"ODD Builder"}
// @amp-agent-mode {"key":"odd-reviewer","label":"ODD Reviewer"}
// @amp-agent-mode {"key":"odd-reviewer-xai","label":"ODD Reviewer (xai)"}
// @amp-agent-mode {"key":"odd-verifier","label":"ODD Verifier"}
// @amp-agent-mode {"key":"odd-deployer","label":"ODD Deployer"}
// @amp-agent-mode {"key":"odd-control","label":"ODD Control"}

import type { Agent, AgentThreadExecutor, PluginAPI, PluginEventContext, ThreadID, WebhookEvent, WebhookHandlerContext } from '@ampcode/plugin'
import {
	cancelledLine,
	capacity,
	contracts,
	deployReceiptLine,
	escalatedLabel,
	issueTriaged,
	heartbeatLine,
	heartbeatProject,
	nextAction,
	oddLabel,
	pageText,
	parseHeartbeat,
	parseThreadLabels,
	ralphGuard,
	specComplete,
	steerLine,
	threadLabels,
	verifyLine,
	waitAge,
	type Action,
	type DeployReceipt,
	type IssueSnapshot,
	type Load,
	type Role,
} from '../../scripts/odd/lifecycle.ts'
import { intakeChannel, intakeEmoji, intakePrompt, pendingIntake, slackSourceLabel, type SlackMessage } from '../../scripts/odd/intake.ts'
import { finishedThreads, issueFromEvent, loadFrom, prOwnsIssue, receiptLabel, roleLabelQueries, toSnapshot, verdictPattern, type GitHubPullRequest, type LinearIssue, type LiveThread } from '../../scripts/odd/snapshot.ts'
import { builderEngine, checkAccess, checkRouting, engineLabel, engineUsage, expectedEngine, labOf, parseRouting, pluginPins, reviewerEngines, routingRecord, selectReviewer, type Connection, type Engine, type Lab, type Routing } from '../../scripts/odd/engines.ts'
import { builderArgs, launch } from '../../scripts/odd/launch.ts'
import { alertsChannel, blindMs, capsAlertMs, digest, digestDue, digestHeading, episodeLine, incidentPageDue, incidentText, incidents, overCaps, overdueKeys, overdueLine, overduePage, parseEpisode, resolutionText, restoreStatus, sanitizeError, slackMessages, staleThreads, sweepMs, unknownAge, type DigestInput, type DigestWait, type Episode, type Plane } from '../../scripts/odd/watchdog.ts'

export const description =
	'Factory ODD control plane: Linear, GitHub and Slack webhooks drive a deterministic outcome lifecycle; role agents run in orbs; Ralph loops are bounded by external checks. See docs/odd/README.md.'

// The plugin is armed only in the control thread (label odd-control-plane). Everywhere else it
// registers the role modes and the Ralph guard and does nothing on its own. `perform` acts only
// when the control thread also carries odd-perform, and only for the roles already live:
// phase 3 (MET-278) spawns intake and spec and sets Triage/Todo; phase 4 (MET-279) adds the
// builder, the reviewer and the deterministic merge for issues labelled `odd`; phase 6
// (MET-281) adds the verifier and the Watchdog sweep.
const controlLabel = 'odd-control-plane'
const performLabel = 'odd-perform'
const marker = '[odd]'
const liveRoles: ReadonlySet<Role> = new Set<Role>(['intake', 'spec', 'builder', 'reviewer', 'verifier'])
const slackPollMs = 5 * 60_000
/** Runner ID of the host the deploy job runs on; the red-deploy log reader runs there. */
const deployRunner = 'factory-gpu'

export default async function (amp: PluginAPI) {
	// Every agent pins its model and effort (scripts/odd/engines.ts); none inherits a mode default.
	const roleAgent = (role: Role, extendsMode: 'low' | 'medium' | 'high', label: string, extra: string, pin: Engine, tools?: { exclude?: string[] }): Agent =>
		amp.createAgent({
			extends: extendsMode,
			model: pin.model,
			reasoningEffort: pin.effort,
			instructions: [
				`You are the Factory ${role} role under outcome driven development (docs/odd/README.md).`,
				`Load the project skill \`${contracts[role].skill}\` first and follow it as your contract.`,
				`Your external stop condition is "${contracts[role].stop}". Never claim it; produce the artifact that makes it true.`,
				'Never write artifacts another role is supposed to check. Never edit Done means. Follow AGENTS.md.',
				extra,
			].join(' '),
			// update_thread lets a role label its own thread (the reviewer's verdict is a label).
			tools: { add: ['mcp__linear__*', 'slack_read', 'slack_write', 'create_thread', 'get_thread_status', 'wait_for_threads', 'update_thread'], ...tools },
			display: { label, color: '#0f766e' },
		})

	const reviewerExtra = 'Rerun the Evidence commands yourself at the exact head SHA. Verdict is bound to that SHA: a PR comment plus the odd-verdict thread label.'
	const readOnly = { exclude: ['edit_file', 'create_file'] }
	// One reviewer agent per lab; the control plane picks one outside the Builder's lab (selectReviewer).
	const reviewerAgents = new Map<Lab, Agent>(reviewerEngines.map(engine => [engine.lab, roleAgent('reviewer', 'high', 'ODD Reviewer', reviewerExtra, engine, readOnly)]))
	const modes: { key: string; label: string; agent: Agent }[] = [
		{ key: 'intake', label: 'ODD Intake', agent: roleAgent('intake', 'low', 'ODD Intake', 'Turn a message or bare issue into a Linear issue in the team template, with type and area labels and a duplicate check.', pluginPins.intake) },
		{ key: 'spec', label: 'ODD Spec', agent: roleAgent('spec', 'medium', 'ODD Spec', 'Write Isolation, Build, Done means and Evidence; one Evidence line per Done-means item; set priority and risk.', pluginPins.spec) },
		// Manual use only: the control plane launches Claude Code builders through the CLI (launchBuilder).
		{ key: 'builder', label: 'ODD Builder', agent: roleAgent('builder', 'medium', 'ODD Builder', 'Implement the smallest correct change on your own branch, open the PR with the Evidence output in its body, and keep the same thread and branch across review rounds.', pluginPins.builder) },
		{ key: 'reviewer', label: 'ODD Reviewer', agent: reviewerAgents.get(reviewerEngines[0].lab)! },
		{ key: 'verifier', label: 'ODD Verifier', agent: roleAgent('verifier', 'low', 'ODD Verifier', 'Check each Done-means item against the deployed system using the Evidence lines and the deploy receipt.', pluginPins.verifier, readOnly) },
		{ key: 'deployer', label: 'ODD Deployer', agent: roleAgent('deployer', 'low', 'ODD Deployer', 'Read the factory-deploy journal and ledger for the red receipt you were given and attach the installer and journal excerpts to the named issue. Never run installers, rollbacks, sudo or systemctl.', pluginPins.deployer, readOnly) },
	]
	const agents: Partial<Record<Role, Agent>> = Object.fromEntries(modes.map((m) => [m.key, m.agent]))
	const control = amp.createAgent({
		extends: 'low',
		model: pluginPins.control.model,
		reasoningEffort: pluginPins.control.effort,
		instructions: `You are the Factory ODD control thread. You own the webhooks and the watchdog schedule. Do not build, review or deploy yourself; the plugin spawns roles. When asked, summarise derived state. Label this thread ${controlLabel} to arm the plugin.`,
		tools: { add: ['mcp__linear__*', 'get_thread_status', 'send_thread_message'] },
		display: { label: 'ODD Control', color: '#b45309' },
	})

	// Orbs run only registered agent definitions, so every other reviewer engine gets its own mode.
	const reviewerModes = reviewerEngines.slice(1).map(engine => ({ key: `reviewer-${engine.lab}`, label: `ODD Reviewer (${engine.lab})`, agent: reviewerAgents.get(engine.lab)! }))
	for (const { key, label, agent } of [...modes, ...reviewerModes, { key: 'control', label: 'ODD Control', agent: control }]) {
		amp.registerAgentMode({
			key: `odd-${key}`,
			label,
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
		const { stopMet, missing } = await externalStop(ctx, role, issue, labels)
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
		/** The wait's age against its budget (`ci 12 min`), or `unknown` when no durable start time exists. */
		wait?: string
	}
	type ArmState = {
		armed: boolean
		error?: string
		webhooks: string[]
		urls: string[]
		events: HandledEvent[]
		/** Slack intake poll: last run, last error, and the message timestamps handed to Intake. */
		slack: { polledAt?: string; error?: string; spawned: string[] }
		/** Watchdog sweep (scripts/odd/watchdog.ts): last run, issues swept, episodes in progress, digest day, cancellations today. */
		watchdog: { sweptAt?: string; error?: string; issues?: number; overSince?: string; alerted?: boolean; blindSince?: string; paged?: boolean; digestDay?: string; heartbeatId?: string; cancelled: string[]; waits: Record<string, DigestWait & { list: 'risk' | 'failedVerification' | 'unknownAge' }>; overdue: string[] }
		/** Failing actions by `<issue> <episode key>` (scripts/odd/watchdog.ts Episode), and the build slots the incidents are judged against. */
		episodes: Record<string, Episode>
		plane: Plane
		/** Arm-time check that each pinned model is served by its subscription (checkPins): when it ran and what failed. */
		pins: { checkedAt?: string; problems?: string[] }
		timers: ReturnType<typeof setInterval>[]
	}
	const armState = new Map<ThreadID, ArmState>()
	const emptyState = (): ArmState => ({ armed: false, webhooks: [], urls: [], events: [], slack: { spawned: [] }, watchdog: { cancelled: [], waits: {}, overdue: [] }, episodes: {}, plane: { load: { orbs: 0, runnerSlots: 0, buildIssues: 0 }, building: [], waiting: [] }, pins: {}, timers: [] })
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
			'ODD control plane state for this thread: labels, executor kind, whether webhooks are armed, last arming error, the last 20 handled events (webhooks, Slack intake polls, Watchdog sweeps), Slack poll and Watchdog state. Pass arm: true to arm now (control thread in an orb only). Pass poll_slack: true to poll #factory-intake now. Pass sweep: true to run the Watchdog sweep now. Pass show_urls: true to show the webhook URLs to the human in a confirm dialog; the call blocks until they answer. URLs are never returned to the agent.',
		inputSchema: {
			type: 'object',
			properties: {
				arm: { type: 'boolean', description: 'Arm the control plane now if not armed' },
				poll_slack: { type: 'boolean', description: 'Poll #factory-intake now and hand new messages to Intake (dry run without the odd-perform label)' },
				sweep: { type: 'boolean', description: 'Run the Watchdog sweep now: re-evaluate every live or ODD-owned issue' },
				show_urls: { type: 'boolean', description: 'Show the webhook URLs to the human in a dialog and wait for them to confirm' },
			},
		},
		async execute(input, ctx) {
			const labels = await ctx.thread.labels()
			if (input.arm === true) await arm(ctx, labels, true)
			const current = armState.get(ctx.thread.id)
			if (input.poll_slack === true && current?.armed) await pollSlackIntake(ctx, current)
			if (input.sweep === true && current?.armed) await sweep({ ...ctx, $: amp.$ }, current)
			const { urls, timers: _timers, ...state } = current ?? emptyState()
			const dialog = input.show_urls === true && urls.length > 0 ? await showUrls(ctx, urls) : undefined
			return JSON.stringify({ thread: ctx.thread.id, labels, executor: amp.system.executor.kind, ...state, dialog })
		},
	})

	// What arming and the Slack poll need from a context; event, tool and webhook contexts all
	// provide it. Evaluating an issue also shells out to gh; tool contexts have no `$`, so the
	// sweep they start uses the plugin-level runner.
	type ArmContext = Pick<WebhookHandlerContext, 'thread' | 'ui' | 'logger' | 'tools'>
	type EvalContext = ArmContext & Pick<WebhookHandlerContext, '$'>

	// A failed arm stays registered so odd_control_status keeps its error and turn boundaries do
	// not renotify; only an explicit `arm: true` (`retry`) replaces it with a fresh attempt.
	async function arm(ctx: ArmContext & Partial<Pick<WebhookHandlerContext, '$'>>, labels: readonly string[], retry = false) {
		const previous = armState.get(ctx.thread.id)
		if (!labels.includes(controlLabel) || (previous && !(retry && previous.error))) return
		const state = emptyState()
		armState.set(ctx.thread.id, state)
		try {
			await armWebhooks(ctx, state)
			state.armed = true
			// Slack has no push path (its Events API needs a challenge reply a handler cannot send),
			// so #factory-intake is polled with the arming context's tools while the orb lives.
			// The Watchdog sweep runs on the same clock: the plugin API has no schedule primitive.
			const evalCtx: EvalContext = { ...ctx, $: ctx.$ ?? amp.$ }
			state.timers.push(setInterval(() => void pollSlackIntake(ctx, state), slackPollMs), setInterval(() => void sweep(evalCtx, state), sweepMs))
			void pollSlackIntake(ctx, state)
			void sweep(evalCtx, state)
			void checkPins(evalCtx, state)
		} catch (error: unknown) {
			for (const timer of state.timers.splice(0)) clearInterval(timer)
			state.armed = false
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
			if (entry.stage === 'failed') {
				// A redelivery of a failed event is evaluated again.
				seen.delete(event.id)
				throw new Error(entry.error)
			}
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

	// Arm-time routing check (§6): each pinned plugin model runs one small check-access inference
	// against the control thread and must be served by its subscription. Claude Code is served
	// inside the builder's orb, not through Amp's routing (check-access reports Amp's Anthropic
	// upstream for it), so the builder needs an active Claude Subscription connection here and is
	// checked from its thread usage when it is archived (recordRouting). A failure pages; output
	// beyond the route (headers, IDs) is never kept.
	async function checkPins(ctx: EvalContext, state: ArmState) {
		const problems: string[] = []
		try {
			const engines = [...reviewerEngines, ...Object.values(pluginPins)].filter((engine, i, all) => all.findIndex(other => other.model === engine.model) === i)
			for (const engine of engines) {
				const result = await ctx.$`amp config model-providers check-access --provider-model ${engine.model} --reasoning-effort ${engine.effort} --thread ${ctx.thread.id}`
				let output: unknown
				try { output = JSON.parse(result.stdout) } catch { output = undefined }
				problems.push(...(result.exitCode === 0 ? checkAccess(engine, output).problems : [`${engine.model}: check-access exited ${result.exitCode}`]))
			}
			if (!(await connections(ctx)).some(connection => connection.active && connection.type === builderEngine.subscription.type)) {
				problems.push(`${builderEngine.model}: no active ${builderEngine.subscription.label} connection`)
			}
		} catch (error: unknown) {
			problems.push(`pin check failed: ${String(error)}`)
		}
		state.pins = { checkedAt: new Date().toISOString(), problems }
		if (!problems.length) return
		ctx.logger.log(marker, 'pin check', problems.join('; '))
		if ((await ctx.thread.labels()).includes(performLabel)) await pageMismatch(ctx, '-', `pinned models at arm: ${problems.join('; ')}`)
	}

	// One evaluation of one issue: derive, decide, act (or dry-run). A role thread's end raises
	// no event here (its agent.end runs in its own orb), and a reviewer's verdict changes neither
	// Linear nor the PR head, so after a spawn, and while the owner is still running, the issue
	// is re-evaluated after a delay until the owner is idle. A failed evaluation may change
	// nothing that raises another event (a Bug lookup failing before the status change), so it is
	// re-evaluated too, with backoff, up to `failureRechecks` times. One pending re-check per issue.
	const recheckMs = 90_000
	const failureRechecks = 5
	const rechecks = new Map<string, ReturnType<typeof setTimeout>>()
	const failures = new Map<string, number>()
	const recheck = (ctx: EvalContext, state: ArmState, identifier: string, delayMs: number) => {
		if (rechecks.has(identifier)) return
		rechecks.set(identifier, setTimeout(() => {
			rechecks.delete(identifier)
			void evaluate(ctx, state, 'recheck', identifier, new Date().toISOString())
		}, delayMs))
	}
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
		// Episode keys this evaluation failed or was refused on; every other open episode of the issue has recovered.
		const touched = new Set<string>()
		let performing = false
		let issue: IssueSnapshot | undefined
		try {
			const derived = await snapshotFor(ctx, identifier, spawned.get(identifier) ?? [])
			const { threads, comments } = derived
			issue = derived.snapshot
			loadEpisodes(state, issue.identifier, comments)
			performing = (await ctx.thread.labels()).includes(performLabel)
			const finished = finishedThreads(issue.status, threads)
			if (finished.length && performing) await archiveThreads(ctx, finished)
			const { load, usage, threads: live } = await currentLoad(ctx)
			state.plane = { load, building: [...new Set(live.flatMap(thread => { const labels = parseThreadLabels(thread.labels); return labels.role === 'builder' && labels.issue ? [labels.issue] : [] }))].sort(), waiting: state.plane.waiting }
			const action = nextAction(issue, load)
			ctx.logger.log(marker, source, issue.identifier, issue.status, JSON.stringify(action))
			entry.status = issue.status
			entry.action = action
			noteWait(ctx, state, entry, issue.identifier, action)
			const ownerBusy = action.kind === 'spawn' || (action.kind === 'wait' && action.reason.endsWith('running'))
			if (ownerBusy) recheck(ctx, state, identifier, recheckMs)
			if (!performing) {
				ctx.logger.log(marker, 'dry run; add label', performLabel, 'to act')
				entry.stage = 'dry-run'
				return entry
			}
			const stale = action.kind === 'wait' && action.stuck ? staleThreads(action, threads, new Date(), issue.deployReceipt?.sha) : []
			if (action.kind === 'wait' && action.stuck && stale.length) {
				await cancelStale(ctx, state, issue, action.stuck, stale)
				entry.stage = 'performed'
				recheck(ctx, state, identifier, 0)
			} else {
				entry.stage = (await perform(ctx, state, issue, action, threads, usage, touched)) ? 'performed' : 'ignored'
			}
			if (action.kind === 'wait') await alertOverdue(ctx, state, issue, action, comments)
			await resolveEpisodes(ctx, state, issue.identifier, touched)
			failures.delete(identifier)
		} catch (error: unknown) {
			entry.stage = 'failed'
			entry.error = String(error)
			ctx.logger.log(marker, source, 'evaluation failed', entry.error)
			const count = (failures.get(identifier) ?? 0) + 1
			failures.set(identifier, count)
			const episode = await recordFailure(ctx, state, identifier, failureKey(issue, entry.action), entry.error)
			if (count <= failureRechecks) recheck(ctx, state, identifier, recheckMs * 2 ** (count - 1))
			else {
				// Rechecks end here, so the episode is due now: the incident page goes out (or is retried by every sweep), never only this log line.
				episode.exhausted = true
				ctx.logger.log(marker, 'recheck budget spent; incident due', identifier, count)
			}
		}
		if (performing) await raiseIncidents(ctx, state)
		return entry
	}

	// Human waits and waits of unknown age go to the digest; the entry shows every wait's age.
	function noteWait(ctx: EvalContext, state: ArmState, entry: HandledEvent, identifier: string, action: Action) {
		const atCapacity = action.kind === 'wait' && action.reason.startsWith('build capacity')
		state.plane.waiting = [...state.plane.waiting.filter(id => id !== identifier), ...(atCapacity ? [identifier] : [])].sort()
		delete state.watchdog.waits[identifier]
		if (action.kind !== 'wait' || !action.wait) return
		const age = waitAge(action.wait, Date.now())
		entry.wait = age.state === 'within' || age.state === 'over' ? `${action.wait.kind} ${Math.floor(age.ageMs / 60_000)} min` : `${action.wait.kind} ${age.state}`
		if (age.state === 'human') state.watchdog.waits[identifier] = { list: action.wait.kind === 'risk' ? 'risk' : 'failedVerification', identifier, reason: action.reason }
		if (age.state === 'unknown') {
			state.watchdog.waits[identifier] = { list: 'unknownAge', ...unknownAge(identifier, action.reason, action.wait) }
			ctx.logger.log(marker, 'wait age unknown', identifier, action.wait.key)
		}
	}

	// A machine wait past its budget pages once per episode. The `odd-overdue` comment is the
	// durable record and is written only after Slack confirms; a failed delivery is retried by
	// the next evaluation.
	async function alertOverdue(ctx: EvalContext, state: ArmState, issue: IssueSnapshot, action: Extract<Action, { kind: 'wait' }>, comments: readonly { body: string }[]) {
		const text = overduePage(issue.identifier, action, Date.now(), issue.pr)
		if (!text || !action.wait) return
		const id = `${issue.identifier} ${action.wait.key}`
		if (state.watchdog.overdue.includes(id) || overdueKeys(comments).has(action.wait.key)) return
		if (!(await deliver(ctx, `${marker} ${text}`))) return
		state.watchdog.overdue.push(id)
		await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: overdueLine(action.wait.key) })
	}

	// --- Failure episodes (scripts/odd/watchdog.ts). The first failure lives in memory; from the
	// second attempt on the episode is an `odd-failure` comment updated in place, so its first
	// failure, attempts and delivered alert survive sweeps and plugin reloads. A one-off failure
	// leaves no comment.
	function failureKey(issue: IssueSnapshot | undefined, action: Action | undefined): { stage: string; key: string } {
		const head = issue?.pr?.headSha.slice(0, 12)
		if (!action) return { stage: 'evaluate', key: 'evaluate' }
		if (action.kind === 'spawn') return { stage: `spawn-${action.role}`, key: `spawn-${action.role}-r${action.round}${head ? `-${head}` : ''}` }
		if (action.kind === 'steer') return { stage: 'steer', key: `steer-${action.key}` }
		if (action.kind === 'merge') return { stage: 'merge', key: `merge-${action.sha.slice(0, 12)}` }
		const stage = action.kind === 'wait' ? 'cancel' : action.kind
		return { stage, key: `${stage}-${head ?? issue?.status.toLowerCase().replace(/\s+/g, '-') ?? 'none'}` }
	}

	function loadEpisodes(state: ArmState, identifier: string, comments: readonly { id?: string; body: string }[]) {
		for (const comment of comments) {
			const durable = parseEpisode(identifier, comment)
			// Resolved episodes matter only while their resolution notice is owed.
			if (!durable || (durable.state === 'resolved' && (durable.alert === 'pending' || durable.alert === 'closed'))) continue
			const id = `${identifier} ${durable.key}`
			const memory = state.episodes[id]
			if (!memory || (memory.commentId === durable.commentId ? durable.attempts > memory.attempts : !memory.commentId)) {
				state.episodes[id] = { ...durable, attempts: Math.max(durable.attempts, memory?.attempts ?? 0), ...(memory?.exhausted ? { exhausted: true } : {}) }
			}
		}
	}

	async function persistEpisode(ctx: EvalContext, episode: Episode) {
		try {
			const saved = await callJson<{ id?: string }>(ctx.tools, 'linear.save_comment', episode.commentId ? { id: episode.commentId, body: episodeLine(episode) } : { issueId: episode.issue, body: episodeLine(episode) })
			if (saved?.id) episode.commentId = saved.id
		} catch (error: unknown) {
			ctx.logger.log(marker, 'failure episode not recorded', episode.issue, episode.key, String(error))
		}
	}

	async function recordFailure(ctx: EvalContext, state: ArmState, identifier: string, { stage, key }: { stage: string; key: string }, error: string): Promise<Episode> {
		const id = `${identifier} ${key}`
		const previous = state.episodes[id]
		const episode: Episode = previous
			? { ...previous, state: 'open', attempts: previous.attempts + 1 }
			: { issue: identifier, key, stage, first: new Date().toISOString(), attempts: 1, state: 'open', alert: 'pending', error: sanitizeError(error) }
		state.episodes[id] = episode
		if (episode.attempts >= 2 && stage !== 'evaluate') await persistEpisode(ctx, episode)
		return episode
	}

	// A successful evaluation is progress for every open episode it did not fail on again. An
	// episode no page went out for is closed; one that paged waits for its incident's resolution.
	async function resolveEpisodes(ctx: EvalContext, state: ArmState, identifier: string, touched: ReadonlySet<string>) {
		for (const [id, episode] of Object.entries(state.episodes)) {
			if (episode.issue !== identifier || episode.state !== 'open' || touched.has(episode.key)) continue
			episode.state = 'resolved'
			if (episode.alert === 'pending') {
				episode.alert = 'closed'
				delete state.episodes[id]
			}
			if (episode.commentId) await persistEpisode(ctx, episode)
		}
	}

	// One incident per shared blocker (watchdog.incidents): its page goes out once through the
	// page path and is marked delivered only after Slack confirms, so a failed delivery or a
	// reload leaves it pending for the next evaluation or sweep. Recovery sends one resolution and
	// closes the episodes; a later failure opens a new episode and a new incident.
	let alerting: Promise<void> = Promise.resolve()
	function raiseIncidents(ctx: EvalContext, state: ArmState): Promise<void> {
		alerting = alerting.then(async () => {
			const now = Date.now()
			for (const incident of incidents(Object.values(state.episodes), state.plane, now)) {
				if (incidentPageDue(incident)) {
					if (!(await deliver(ctx, `${marker} ${incidentText(incident, state.plane, now)}`))) continue
					for (const episode of incident.episodes.filter(candidate => candidate.state === 'open')) {
						episode.alert = incident.reason
						if (episode.commentId || episode.attempts >= 2) await persistEpisode(ctx, episode)
					}
				} else if (incident.resolved) {
					if (incident.delivered && !(await deliver(ctx, `${marker} ${resolutionText(incident, now)}`))) continue
					for (const episode of incident.episodes) {
						episode.alert = 'closed'
						delete state.episodes[`${episode.issue} ${episode.key}`]
						if (episode.commentId) await persistEpisode(ctx, episode)
					}
				}
			}
		}).catch((error: unknown) => ctx.logger.log(marker, 'incident alerting failed', String(error)))
		return alerting
	}

	// The Watchdog's cancel (§8): an idle thread the lifecycle waits on past `staleMs` is archived
	// and the cancellation is recorded on the issue, so `spawn()` counts the next round from it. A
	// builder that never opened a PR hands the issue back to Todo for a fresh builder.
	// The comment is written before the thread is archived: an archived thread leaves the
	// snapshot, so a cancellation that failed to record would hand the role a fresh budget.
	async function cancelStale(ctx: EvalContext, state: ArmState, issue: IssueSnapshot, role: Role, stale: readonly LiveThread[]) {
		for (const thread of stale) {
			const line = cancelledLine(role, thread.id, parseThreadLabels(thread.labels).round)
			await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: line })
			state.watchdog.cancelled.push(`${issue.identifier} ${line}`)
			ctx.logger.log(marker, 'watchdog cancelled', issue.identifier, thread.id)
		}
		await archiveThreads(ctx, stale)
		const status = restoreStatus(role, issue.status, issue.pr !== undefined)
		if (status) await callJson(ctx.tools, 'linear.save_issue', { id: issue.identifier, state: status })
	}

	// The Watchdog (§4, §8) as deterministic code. Every `sweepMs` each issue with a live role
	// thread or in an ODD-owned status is re-evaluated, so a chain left dormant by a cleared
	// escalation, a refused merge or a missed webhook resumes without an event. Then the
	// episodes: caps exceeded for `capsAlertMs` alert once, every evaluation failing for `blindMs`
	// pages once, and the digest posts once per day after `digestHour` on the host clock.
	const sweeping = new WeakSet<ArmState>()
	async function sweep(ctx: EvalContext, state: ArmState) {
		if (sweeping.has(state)) return
		sweeping.add(state)
		const now = new Date()
		const at = now.toISOString()
		const { watchdog } = state
		const entry = record(state, { at, source: 'watchdog', issue: null, stage: 'dry-run' })
		watchdog.sweptAt = at
		// The labels read is inside the try: a rejection fails this sweep and still releases `sweeping`.
		let performing = false
		try {
			performing = (await ctx.thread.labels()).includes(performLabel)
			if (performing) entry.stage = 'performed'
			const threads = (await Promise.all(roleLabelQueries.map(query => threadsFor(ctx.tools, query)))).flat()
			const identifiers = new Set<string>()
			for (const thread of threads) {
				const { issue } = parseThreadLabels(thread.labels)
				if (issue) identifiers.add(issue.toUpperCase())
			}
			const fromThreads = new Set(identifiers)
			// Backlog is on demand (Devon moves an idea to Triage), so the sweep never enumerates it.
			const owned = [...await issueIds(ctx.tools, { state: 'Triage' })]
			for (const status of ['Todo', 'In Progress', 'Deploying']) owned.push(...await issueIds(ctx.tools, { state: status, label: oddLabel }))
			for (const id of owned) identifiers.add(id)
			watchdog.issues = identifiers.size
			let failed = 0
			const unresolved: string[] = []
			for (const identifier of identifiers) {
				// Only a failed derivation is blindness; an action that fails (no reviewer can spawn) is an incident, not a blind plane.
				const evaluated = await evaluate(ctx, state, 'watchdog', identifier, at)
				if (evaluated.stage === 'failed' && !evaluated.action) failed += 1
				if (fromThreads.has(identifier) && (!evaluated.status || ['Triage', 'Todo', 'In Progress', 'Deploying'].includes(evaluated.status))) unresolved.push(identifier)
			}
			if (identifiers.size && failed === identifiers.size) throw new Error(`all ${failed} evaluations failed`)
			// Live role threads on open issues while Linear lists no ODD-owned issue: the enumeration is not trusted (MET-344).
			if (!owned.length && unresolved.length) throw new Error(`issue enumeration returned no issues while live role threads hold ${unresolved.join(', ')}`)
			// Episodes also come due by age alone (five minutes), and a page Slack refused is retried here.
			if (performing) await raiseIncidents(ctx, state)
			const load = loadFrom(threads)
			if (!overCaps(load)) {
				delete watchdog.overSince
				watchdog.alerted = false
			} else {
				watchdog.overSince ??= at
				if (performing && !watchdog.alerted && now.getTime() - Date.parse(watchdog.overSince) >= capsAlertMs) {
					await ctx.tools.call('slack_write', { channelName: alertsChannel, text: `${marker} soft caps exceeded since ${watchdog.overSince}: orbs ${load.orbs}/${capacity.orbs}, runner slots ${load.runnerSlots}/${capacity.runnerSlots}, build issues ${load.buildIssues}/${capacity.buildIssues}.` })
					watchdog.alerted = true
				}
			}
			// `digestDay` is in memory and a plugin reload forgets it, so the channel itself is the
			// durable record: a digest already posted for the day is not posted again.
			const day = digestDue(watchdog.digestDay, now)
			if (day && performing) {
				if (!(await digestPosted(ctx.tools, day))) {
					for (const text of slackMessages(digest(await digestInput(ctx, day, now, load, watchdog.cancelled, Object.values(watchdog.waits))))) await ctx.tools.call('slack_write', { channelName: alertsChannel, text })
				}
				watchdog.digestDay = day
				watchdog.cancelled = []
			}
			// The heartbeat is the poller's only view of this sweep (docs/odd/README.md §9). A failed
			// sweep writes nothing, so the row aging past 20 minutes is the silence signal. Dry-run
			// writes nothing either: a plane that is not performing must not look alive.
			// Any failed derivation withholds it too (MET-344): the failing issue pages through its own
			// incident, the poller sees the silence, and a blind episode in progress is not ended. A
			// failed action (a refused merge, a spawn) is an incident only and keeps the heartbeat.
			if (failed) {
				watchdog.error = `${failed} of ${identifiers.size} evaluations failed`
				entry.stage = 'failed'
				entry.error = watchdog.error
				ctx.logger.log(marker, 'sweep degraded; no heartbeat', watchdog.error)
				return
			}
			if (performing) await writeHeartbeat(ctx, state, at)
			// A blind episode ends only when a whole sweep, digest and heartbeat included, succeeds.
			delete watchdog.error
			delete watchdog.blindSince
			watchdog.paged = false
		} catch (error: unknown) {
			watchdog.error = String(error)
			entry.stage = 'failed'
			entry.error = watchdog.error
			ctx.logger.log(marker, 'sweep failed', watchdog.error)
			watchdog.blindSince ??= at
			if (performing && !watchdog.paged && now.getTime() - Date.parse(watchdog.blindSince) >= blindMs) {
				const text = pageText('-', { kind: 'page', reason: 'control-plane-blind', detail: `every sweep since ${watchdog.blindSince} failed: ${watchdog.error}` })
				await ctx.tools.call('slack_write', { text: `${marker} ${text}` }).then(() => { watchdog.paged = true }, (slackError: unknown) => ctx.logger.log(marker, 'blind page failed', String(slackError)))
			}
		} finally {
			sweeping.delete(state)
		}
	}

	// One Software Factory project status update, rewritten in place. The id is forgotten on a
	// plugin reload, so the first write after a reload finds the row by its `odd-heartbeat` line.
	async function writeHeartbeat(ctx: EvalContext, state: ArmState, at: string) {
		const body = heartbeatLine(at)
		if (!state.watchdog.heartbeatId) {
			let cursor: string | undefined
			do {
				const page = await callJson<unknown>(ctx.tools, 'linear.get_status_updates', { type: 'project', project: heartbeatProject, orderBy: 'updatedAt', limit: 50, ...(cursor ? { cursor } : {}) })
				// A failed lookup must not look like no row: it would add a second heartbeat row. Every row has its id and body.
				state.watchdog.heartbeatId = listOf<{ id: string; body: string }>(page, 'statusUpdates', 'linear.get_status_updates', row => named(row.id) && typeof row.body === 'string').find(update => parseHeartbeat(update.body))?.id
				cursor = nextPage(page, 'linear.get_status_updates')
			} while (!state.watchdog.heartbeatId && cursor)
		}
		const saved = await callJson<{ id?: string }>(ctx.tools, 'linear.save_status_update', { type: 'project', project: heartbeatProject, health: 'onTrack', body, ...(state.watchdog.heartbeatId ? { id: state.watchdog.heartbeatId } : {}) })
		if (saved.id) state.watchdog.heartbeatId = saved.id
	}

	// Slack filters each page after the limit, so every page of the last day is read.
	async function digestPosted(tools: Tools, day: string): Promise<boolean> {
		let cursor: string | undefined
		do {
			const page = await callJson<{ messages?: unknown[]; nextCursor?: string }>(tools, 'slack_read', { operation: 'read_messages', channelName: alertsChannel, lookback: 'P1D', limit: 100, filter: { containsAll: [digestHeading(day)] }, ...(cursor ? { cursor } : {}) })
			if (page.messages?.length) return true
			cursor = page.nextCursor
		} while (cursor)
		return false
	}

	// Every page: the sweep must see every issue in the status, not the first 100.
	async function issueIds(tools: Tools, filter: { state: string; label?: string }): Promise<string[]> {
		const ids: string[] = []
		let cursor: string | undefined
		do {
			const page = await callJson<unknown>(tools, 'linear.list_issues', { team: 'Metacomet', ...filter, limit: 100, fields: ['id'], ...(cursor ? { cursor } : {}) })
			for (const issue of listOf<{ id: string }>(page, 'issues', 'linear.list_issues', row => named(row.id))) ids.push(issue.id)
			cursor = nextPage(page, 'linear.list_issues')
		} while (cursor)
		return ids
	}

	// Yesterday's facts for the digest: identifiers, titles and SHAs only (digest() formats them).
	async function digestInput(ctx: EvalContext, day: string, now: Date, load: Load, cancelled: readonly string[], waits: readonly (DigestWait & { list: string })[]): Promise<DigestInput> {
		const listed = (list: string) => waits.filter(wait => wait.list === list).map(({ identifier, reason }) => ({ identifier, reason }))
		const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString()
		const merged = await ctx.$`gh pr list --state merged --search ${`merged:>=${since.slice(0, 10)}`} --json number,title,headRefOid,mergeCommit,mergedAt --limit 50`
		if (merged.exitCode !== 0) throw new Error(`gh pr list for the digest failed: ${merged.stderr.trim()}`)
		type Issue = { id?: string; title?: string; completedAt?: string; createdAt?: string }
		const issues = async (filter: Record<string, unknown>, fields: string[]) =>
			(await callJson<{ issues?: Issue[] }>(ctx.tools, 'linear.list_issues', { team: 'Metacomet', ...filter, limit: 100, fields })).issues ?? []
		const named = (list: Issue[]) => list.flatMap(issue => (issue.id ? [{ identifier: issue.id, title: issue.title ?? '' }] : []))
		const [done, bugs, escalated] = await Promise.all([
			issues({ state: 'Done' }, ['id', 'title', 'completedAt']).then(list => list.filter(issue => (issue.completedAt ?? '') >= since)),
			issues({ label: 'Bug', createdAt: '-P1D' }, ['id', 'title', 'createdAt']).then(list => list.filter(issue => (issue.createdAt ?? '') >= since)),
			issues({ label: escalatedLabel }, ['id', 'title']),
		])
		return {
			day,
			merged: (JSON.parse(merged.stdout) as { number: number; title: string; headRefOid: string; mergeCommit?: { oid?: string }; mergedAt?: string }[])
				.filter(pr => (pr.mergedAt ?? '') >= since)
				.map(pr => ({ number: pr.number, title: pr.title, headSha: pr.headRefOid, mergeSha: pr.mergeCommit?.oid ?? 'unknown' })),
			done: named(done),
			bugs: named(bugs),
			escalated: named(escalated),
			load,
			cancelled,
			risk: listed('risk'),
			failedVerification: listed('failedVerification'),
			unknownAge: listed('unknownAge'),
		}
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
					const { load } = await currentLoad(ctx)
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
				await archiveThreads({ ...ctx, $: amp.$ }, idle)
			}
		} catch (error: unknown) {
			state.slack.error = String(error)
			ctx.logger.log(marker, 'slack poll failed', state.slack.error)
		}
	}

	// Plugin agents run every role but the builder; `engine` is the reviewer's lab choice, else the role's pin.
	async function spawnThread(parentThreadID: ThreadID, role: Role, labels: string[], content: string, executor: AgentThreadExecutor = 'orb', engine?: Engine): Promise<string> {
		const pin = engine ?? pluginPins[role as keyof typeof pluginPins]
		const agent = role === 'builder' ? undefined : role === 'reviewer' ? reviewerAgents.get(pin?.lab as Lab) : agents[role]
		if (!agent || !pin) throw new Error(`no plugin agent for role ${role}${engine ? ` on ${engine.lab}` : ''}`)
		const thread = await agent.createThread({ executor, parentThreadID, visibility: 'workspace' })
		await thread.setLabels([engineLabel(pin.lab), ...labels])
		await thread.appendUserMessage({ type: 'user-message', content })
		return thread.id
	}

	// The builder is Claude Code on an orb (§6): `amp -ox` through the CLI, labelled at creation and
	// again once its session_id is read, recorded, and only then the local launcher is ended. A
	// failure is posted on the issue once per error and thrown; no plugin agent or other engine
	// stands in for it.
	const launchFailures = new Set<string>()
	async function launchBuilder(ctx: EvalContext, issue: IssueSnapshot, labels: string[], content: string, round: number): Promise<string> {
		const expected = [...labels, engineLabel(builderEngine.lab)]
		try {
			return await launch(builderArgs(content, labels, `${issue.identifier} builder round ${round}`), async id => {
				const child = amp.threads.get(id as ThreadID)
				const present = await child.labels()
				if (expected.some(label => !present.includes(label))) await child.addLabels(expected)
				spawned.set(issue.identifier, [...(spawned.get(issue.identifier) ?? []), id])
				ctx.logger.log(marker, 'builder launched', issue.identifier, id, builderEngine.model)
			})
		} catch (error: unknown) {
			const line = `odd-launch-failed role=builder engine=${builderEngine.lab} model=${builderEngine.model}\n\n${String(error).slice(0, 400)}`
			if (!launchFailures.has(`${issue.identifier}:${line}`)) {
				launchFailures.add(`${issue.identifier}:${line}`)
				await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: line })
			}
			throw error
		}
	}

	// The URLs are credentials, shown only in the control thread for Devon to paste into Linear,
	// GitHub and Slack. Never log or post them anywhere else.
	async function showUrls(ctx: Pick<PluginEventContext<'agent.end'>, 'ui'>, urls: readonly string[]) {
		const confirmed = await ctx.ui.confirm({ title: 'ODD webhook endpoints', message: urls.join('\n'), confirmButtonText: 'Configured', requireHuman: true })
		return confirmed ? 'configured' : 'dismissed'
	}

	// Phases 3-6 fill in `perform` stage by stage: phase 3 spawns intake and spec and moves
	// issues between Triage and Todo; phase 4 builds, reviews and merges; deploy is deferred.
	// ODD owns Triage for every issue (Backlog waits for Devon). From Todo on, the dispatcher still owns an
	// issue unless it carries the `odd` label (§6), so an issue the orchestrator created in Todo
	// without an Evidence section is neither pulled back into Triage nor built twice.
	// A steer is delivered once per key (its cause and head SHA): the `odd-steer` comment written
	// after delivery makes the lifecycle wait on the builder's answer instead, across reloads. A
	// failed delivery writes nothing and is retried; a delivered steer whose comment failed is
	// only recorded on the retry (`steered`).
	const steered = new Set<string>()
	/** Returns false when nothing was done because the action is not this control plane's to take. `touched` collects episode keys refused without an exception. */
	async function perform(ctx: EvalContext, state: ArmState, issue: IssueSnapshot, action: Action, threads: readonly LiveThread[], usage: Partial<Record<Lab, number>> = {}, touched = new Set<string>()): Promise<boolean> {
		const owned = issue.status === 'Triage' || issue.labels.includes(oddLabel)
		if (!owned) {
			ctx.logger.log(marker, 'deferred: dispatcher owns', issue.identifier, issue.status, action.kind)
			return false
		}
		switch (action.kind) {
			case 'spawn': {
				if (!liveRoles.has(action.role)) {
					ctx.logger.log(marker, 'deferred to a later phase', issue.identifier, action.role)
					return false
				}
				if (action.executor !== 'orb') {
					// Subscription engines and runner jobs are launched by the runner backstop (§6).
					ctx.logger.log(marker, 'launch request for runner', issue.identifier, action.role)
					return false
				}
				// A verifier is labelled with the receipt it verifies, so the next release's receipt starts a fresh budget.
				const receipt = action.role === 'verifier' && issue.deployReceipt ? [receiptLabel(issue.deployReceipt.sha)] : []
				const labels = [...threadLabels(issue.identifier, action.role, action.round), ...receipt]
				const content = `${marker} Outcome ${issue.identifier}. Role: ${action.role}. Reason: ${action.reason}.${spawnTarget(issue, action.role)} Load the \`${contracts[action.role].skill}\` skill and start.`
				if (action.role === 'builder') {
					await launchBuilder(ctx, issue, labels, content, action.round)
				} else {
					// Cross-lab review: never the lab the issue's builder thread runs on.
					let engine: Engine | undefined
					if (action.role === 'reviewer') {
						const builderLab = labOf(threads.find(thread => parseThreadLabels(thread.labels).role === 'builder')?.labels ?? [])
						engine = selectReviewer(builderLab, usage)
						if (!engine) throw new Error(`no reviewer engine outside the builder's lab ${builderLab ?? builderEngine.lab}`)
					}
					const threadID = await spawnThread(ctx.thread.id, action.role, labels, content, 'orb', engine)
					spawned.set(issue.identifier, [...(spawned.get(issue.identifier) ?? []), threadID])
				}
				// Todo -> In Progress is the builder's claim; the status change is the handoff artifact (§7).
				if (action.role === 'builder' && issue.status === 'Todo') await callJson(ctx.tools, 'linear.save_issue', { id: issue.identifier, state: 'In Progress' })
				return true
			}
			case 'set-status':
				await setStatus(ctx, issue, action, spawnDeployer(ctx))
				return true
			case 'steer': {
				const key = `${issue.identifier} ${action.key}`
				if (!steered.has(key)) {
					await amp.threads.get(action.threadID as ThreadID).appendUserMessage({ type: 'user-message', content: `${marker} ${action.message}` }, { steer: true })
					steered.add(key)
				}
				await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: steerLine(action.key, action.threadID) })
				return true
			}
			case 'merge': {
				const refusal = await merge(ctx, state, issue, action.pr, action.sha)
				if (refusal) {
					const failure = failureKey(issue, action)
					touched.add(failure.key)
					await recordFailure(ctx, state, issue.identifier, failure, `merge refused at ${action.sha}: ${refusal}`)
				}
				return true
			}
			case 'page':
				await page(ctx, issue, action, spawnDeployer(ctx), threads)
				return true
			default:
				ctx.logger.log(marker, 'deferred to a later phase', action.kind)
				return false
		}
	}

	// What a spawned role must act on beyond the issue: the reviewer's head, the verifier's receipt.
	function spawnTarget(issue: IssueSnapshot, role: Role): string {
		if (role === 'reviewer' && issue.pr) return ` Review PR #${issue.pr.number} at head ${issue.pr.headSha}.`
		if (role === 'verifier' && issue.deployReceipt) {
			const { sha } = issue.deployReceipt
			return ` Receipt: \`${deployReceiptLine(issue.deployReceipt)}\`. Check every Done-means item against the deployed system and comment \`${verifyLine({ sha, result: 'pass' })}\` (or \`result=fail bug=<MET-n>\` after filing the Bug in Triage) on ${issue.identifier}.`
		}
		return ''
	}

	// The Shipper (§4) is this function: the dispatcher's merge gate at the exact head, then a
	// head-pinned squash merge. Self-deploying paths pass because ODD merges them too (§1). A
	// page puts the PR back to draft, and the gate refuses drafts, so a ready verdict un-drafts it
	// first. A refusal is posted once per head so the builder sees it; GitHub's merge state lags
	// CI by a minute or so (MET-280's PR #182), so the issue is re-checked instead of waiting for
	// a webhook that nothing will send.
	const refused = new Set<string>()
	// Every refusal and failed merge at one head counts toward that head's failure episode, which pages at the third attempt.
	async function merge(ctx: EvalContext, state: ArmState, issue: IssueSnapshot, pr: number, sha: string): Promise<string | undefined> {
		const draft = await ctx.$`gh pr view ${String(pr)} --json isDraft --jq .isDraft`
		if (draft.exitCode === 0 && draft.stdout.trim() === 'true') {
			const ready = await ctx.$`gh pr ready ${String(pr)}`
			if (ready.exitCode !== 0) throw new Error(`gh pr ready ${pr} failed: ${ready.stderr.trim()}`)
			ctx.logger.log(marker, 'un-drafted', issue.identifier, pr)
		}
		const root = (await ctx.$`git rev-parse --show-toplevel`).stdout.trim()
		const check = await ctx.$`node ${`${root}/scripts/dispatch/qa.ts`} check ${String(pr)} ${sha} --self-deploying-ok`
		if (check.exitCode !== 0) {
			const cause = check.stderr.trim() || check.stdout.trim()
			ctx.logger.log(marker, 'merge refused', issue.identifier, pr, sha, cause)
			if (!refused.has(sha)) {
				refused.add(sha)
				await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: `odd-merge-refused pr=${pr} head=${sha}\n\n${cause}` })
			}
			recheck(ctx, state, issue.identifier, recheckMs)
			return cause
		}
		const merged = await ctx.$`gh pr merge ${String(pr)} --squash --match-head-commit ${sha}`
		if (merged.exitCode !== 0) throw new Error(`gh pr merge ${pr} at ${sha} failed: ${merged.stderr.trim()}`)
		const view = await ctx.$`gh pr view ${String(pr)} --json mergeCommit --jq .mergeCommit.oid`
		const mergeSha = view.exitCode === 0 ? view.stdout.trim() : 'unknown'
		await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: `odd-merge pr=${pr} head=${sha} merge=${mergeSha} release=none` })
		ctx.logger.log(marker, 'merged', issue.identifier, pr, sha, mergeSha)
		return undefined
	}

	// The red-deploy log reader (§4 Deployer, Build 6): an Amp low thread on the deploy host.
	const spawnDeployer = (ctx: EvalContext) => (labels: string[], content: string) =>
		spawnThread(ctx.thread.id, 'deployer', labels, content, { type: 'runner', id: deployRunner })
}

type Spawn = (labels: string[], content: string) => Promise<string>

// The status is the transition that hands the issue on, so it is written last: the Bug and the
// log reader are both deduplicated, and a failure in either leaves the issue in Deploying for the
// next evaluation to retry. Moving it to Todo first would hand it to a builder with neither.
export async function setStatus(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, issue: IssueSnapshot, action: Extract<Action, { kind: 'set-status' }>, spawn: Spawn) {
	const bug = action.followUp ? await followUp(ctx, issue, action.followUp) : undefined
	if (action.diagnose) await diagnose(ctx, issue, action.diagnose, bug, spawn)
	await callJson(ctx.tools, 'linear.save_issue', { id: issue.identifier, state: action.status })
}

// Escalation (§8): the issue stays In Progress with the `escalated` label (the lifecycle waits
// on it), the PR goes back to draft so nothing merges it, and Devon gets one Slack DM in the one
// page format (pageText). `slack_write` without a recipient DMs the thread owner. The label is
// written last, so a failed step is retried by the next evaluation, and a page while the label
// is present is a no-op (MET-304 paged twice). A failed rollback starts its log reader first; a
// page is never held back by that spawn, so its failure goes into the page instead. Reviewer
// threads holding `changes` verdicts for older heads are archived, so the round count restarts
// when Devon clears the label.
export async function page(ctx: Pick<WebhookHandlerContext, 'tools' | '$' | 'logger'>, issue: IssueSnapshot, action: Extract<Action, { kind: 'page' }>, spawn?: Spawn, threads: readonly LiveThread[] = []) {
	if (issue.labels.includes(escalatedLabel)) {
		ctx.logger.log(marker, 'already paged', issue.identifier, action.reason)
		return
	}
	let detail = action.detail
	if (action.diagnose && spawn) {
		try {
			await diagnose(ctx, issue, action.diagnose, undefined, spawn)
		} catch (error: unknown) {
			detail += ` (log reader not started: ${String(error)}; read journalctl -u factory-deploy on ${action.diagnose.host})`
		}
	}
	if (action.pr !== undefined) {
		const draft = await ctx.$`gh pr ready ${String(action.pr)} --undo`
		if (draft.exitCode !== 0) ctx.logger.log(marker, 'draft failed', action.pr, draft.stderr.trim())
	}
	await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: `odd-escalated reason=${action.reason}\n\n${detail}` })
	await ctx.tools.call('slack_write', { text: `${marker} ${pageText(issue.identifier, { ...action, detail })} Remove the \`${escalatedLabel}\` label to resume.` })
	const head = issue.pr?.headSha.slice(0, 12)
	const spent = threads.filter(thread => thread.labels.some(label => {
		const match = verdictPattern.exec(label)
		return match?.[1] === 'changes' && match[2] !== head
	}))
	await archiveThreads(ctx, spent)
	await callJson(ctx.tools, 'linear.save_issue', { id: issue.identifier, addLabels: [escalatedLabel] })
	ctx.logger.log(marker, 'paged', issue.identifier, action.reason)
}

// A rolled-back release returns its issues to Todo and files one Bug in Triage per failed
// release (the title carries the SHA; a second issue of the same release reuses it). Returns the Bug.
export async function followUp(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, issue: IssueSnapshot, followUp: { title: string; body: string }): Promise<string | undefined> {
	// A malformed row is a failed lookup, never "no Bug yet": that would file a duplicate.
	const existing = listOf<{ id: string; title: string }>(await callJson(ctx.tools, 'linear.list_issues', { team: 'Metacomet', query: followUp.title, limit: 10 }), 'issues', 'linear.list_issues', row => named(row.id) && typeof row.title === 'string')
	const match = existing.find(candidate => candidate.title === followUp.title)
	if (match?.id) {
		await callJson(ctx.tools, 'linear.save_issue', { id: match.id, relatedTo: [issue.identifier] })
		ctx.logger.log(marker, 'follow-up exists', issue.identifier, match.id)
		return match.id
	}
	const created = await callJson<{ id?: string; identifier?: string }>(ctx.tools, 'linear.save_issue', { team: 'Metacomet', title: followUp.title, description: followUp.body, labels: ['Bug', 'area:agents'], state: 'Triage', relatedTo: [issue.identifier] })
	ctx.logger.log(marker, 'follow-up filed', issue.identifier, created.identifier ?? created.id ?? '')
	return created.identifier ?? created.id
}

// One log-reading Deployer per red release (label odd-deploy-<sha12>, searched without an
// archived:false filter, plus this process's memory while the search index lags). It attaches the installer and
// journal excerpts to the Bug, or to the issue when the rollback failed and no Bug exists.
const diagnosed = new Set<string>()
export async function diagnose(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, issue: IssueSnapshot, receipt: DeployReceipt, bug: string | undefined, spawn: Spawn) {
	const label = `odd-deploy-${receipt.sha.slice(0, 12)}`
	const found = listOf(await callJson(ctx.tools, 'find_thread', { query: `label:${label}`, limit: 1 }), 'threads', 'find_thread', row => named(row.id))
	if (diagnosed.has(label) || found.length) {
		ctx.logger.log(marker, 'deploy log reader exists', issue.identifier, label)
		return
	}
	diagnosed.add(label)
	const target = bug ?? issue.identifier
	let thread: string
	try {
		thread = await spawn([...threadLabels(issue.identifier, 'deployer', 1), label], [
			`${marker} Outcome ${issue.identifier}. Role: deployer. Reason: red deploy.`,
			`Receipt: \`${deployReceiptLine(receipt)}\`.`,
			`Attach the installer and journal excerpts (\`journalctl -u factory-deploy\`, the ledger) for this release to ${target}${bug ? ` (Bug follow-up of ${issue.identifier})` : ' (the rollback failed; Devon is paged)'}.`,
			`Load the \`${contracts.deployer.skill}\` skill and start.`,
		].join(' '))
	} catch (error: unknown) {
		diagnosed.delete(label)
		throw error
	}
	ctx.logger.log(marker, 'deploy log reader', issue.identifier, label, '->', thread)
}

// --- Derivation: Linear through the thread's MCP tools, GitHub through gh, Amp through thread search.
// Tool calls run without a model (PluginTools.call); the pure combination lives in scripts/odd/snapshot.ts.

type Tools = WebhookHandlerContext['tools']

// `ctx.tools.call` returns the full CallToolResult for MCP tools: the payload is JSON in the
// first text block (or `structuredContent` when the server provides it). Built-in tools return
// their result directly; pass those through unchanged.
// An `isError` envelope is a failed read even when its text parses as JSON (MET-344).
async function callJson<T>(tools: Tools, name: string, input: Record<string, unknown>): Promise<T> {
	const result = (await tools.call(name, input)) as { structuredContent?: unknown; content?: { type: string; text?: string }[] } | T
	if (typeof result !== 'object' || result === null) return result as T
	const envelope = result as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] }
	if (envelope.isError === true) throw new Error(`${name} returned an error: ${envelope.content?.find(block => block.type === 'text')?.text?.slice(0, 200) ?? 'no detail'}`)
	if (envelope.structuredContent !== undefined) return envelope.structuredContent as T
	const textBlock = envelope.content?.find(block => block.type === 'text' && typeof block.text === 'string')
	if (!textBlock) return result as T
	return JSON.parse(textBlock.text as string) as T
}

// Read-boundary shapes (MET-344): a field the lifecycle reads is present with its type, and an
// identifier or status is never blank. Empty lists and empty bodies stay valid.
type Row = Record<string, unknown>
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)
const named = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const optional = (row: Row, key: string, type: 'string' | 'boolean') => row[key] === undefined || row[key] === null || typeof row[key] === type
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value))

/** The cursor of a Linear page: `hasNextPage` is a boolean, and a next page has a cursor. Ending without one would drop the rest. */
function nextPage(page: unknown, name: string): string | undefined {
	if (!isRow(page) || typeof page.hasNextPage !== 'boolean') throw new Error(`${name} returned no hasNextPage`)
	if (!page.hasNextPage) return undefined
	if (!named(page.cursor)) throw new Error(`${name} reported a next page without a cursor`)
	return page.cursor
}

/**
 * The fields the lifecycle reads from a `statusCheckRollup` record (ciState, externalStop): a
 * CheckRun has a name and a string or null conclusion, and without a conclusion it is pending
 * with a status; a StatusContext has a context and a state. An empty rollup is valid.
 */
const checkRecord = (row: unknown): boolean => {
	if (!isRow(row)) return false
	if (row.__typename === 'StatusContext' || 'context' in row) return named(row.context) && named(row.state)
	if (!named(row.name) || !(row.conclusion === null || row.conclusion === undefined || typeof row.conclusion === 'string') || !optional(row, 'status', 'string')) return false
	return named(row.conclusion) || named(row.status)
}

/** The `key` collection of a read; a missing or malformed one, or one bad row, is a failed read, never an empty list. */
function listOf<T>(payload: unknown, key: string, name: string, valid: (row: Row) => boolean = () => true): T[] {
	const list = (payload as Record<string, unknown> | null | undefined)?.[key]
	if (!Array.isArray(list)) throw new Error(`${name} returned no ${key} list`)
	const bad = list.findIndex(row => !isRow(row) || !valid(row))
	if (bad >= 0) throw new Error(`${name} returned a malformed ${key} row at ${bad}`)
	return list as T[]
}

/** An issue read without its identifier, status or labels is a failed read, not a Backlog issue. */
async function getIssue(tools: Tools, input: Record<string, unknown>): Promise<LinearIssue> {
	const issue = await callJson<unknown>(tools, 'linear.get_issue', input)
	// Requested relations must be present: an absent blocker list would lift the dependency gate.
	const requested = input.includeRelations === true
	const relations = isRow(issue) ? issue.relations : undefined
	const blockedBy = isRow(relations) ? relations.blockedBy : undefined
	const relationsValid = relations === undefined || relations === null
		? !requested
		: isRow(relations) && (blockedBy === undefined || blockedBy === null ? !requested : Array.isArray(blockedBy) && blockedBy.every(row => isRow(row) && named(row.id)))
	if (!isRow(issue) || !named(issue.id) || !named(issue.status) || !strings(issue.labels) || !optional(issue, 'description', 'string') || !relationsValid) {
		throw new Error(`linear.get_issue ${String(input.id)} returned a malformed issue`)
	}
	return issue as unknown as LinearIssue
}

const listComments = async (tools: Tools, issueId: string): Promise<Comment[]> =>
	listOf<Comment>(await callJson(tools, 'linear.list_comments', { issueId, limit: 50 }), 'comments', 'linear.list_comments', row => typeof row.body === 'string' && optional(row, 'id', 'string') && optional(row, 'createdAt', 'string'))

type Comment = { id?: string; body: string; createdAt?: string }

async function snapshotFor(ctx: Pick<WebhookHandlerContext, 'tools' | '$' | 'logger'>, identifier: string, knownThreads: readonly string[]): Promise<{ snapshot: IssueSnapshot; threads: LiveThread[]; comments: Comment[] }> {
	const [issue, comments, pr, threads] = await Promise.all([
		getIssue(ctx.tools, { id: identifier, includeRelations: true }),
		listComments(ctx.tools, identifier),
		pullRequestFor(ctx, identifier),
		threadsFor(ctx.tools, `label:odd-issue-${identifier.toLowerCase()} archived:false`, knownThreads),
	])
	// `blockedBy` lists the relation's issues without their status; a blocker is open until closed.
	const blockers = await Promise.all((issue.relations?.blockedBy ?? []).map(({ id }) => getIssue(ctx.tools, { id })))
	const openBlockers = blockers.filter(blocker => !['Done', 'Canceled', 'Duplicate'].includes(blocker.status)).map(blocker => blocker.id)
	return { snapshot: toSnapshot({ issue: { ...issue, comments }, pr, threads, openBlockers }), threads, comments }
}

// Finished role threads are archived so the thread list shows only live work; an archived
// thread keeps its labels, so a later `find_thread … archived:false` no longer counts it, and its
// orb pauses. Each thread's actual routing is recorded first: a failed record keeps the thread
// for the next evaluation, like a Watchdog cancellation.
async function archiveThreads(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger' | '$'>, threads: readonly LiveThread[]) {
	for (const thread of threads) {
		await recordRouting(ctx, thread)
		await callJson(ctx.tools, 'update_thread', { thread: thread.id, archived: true })
		ctx.logger.log(marker, 'archived finished thread', thread.id)
	}
}

type ShellContext = Pick<WebhookHandlerContext, 'tools' | 'logger' | '$'>

/** Non-secret connection data (`amp config model-providers list --json`): ID, type, name, active. */
async function connections(ctx: Pick<WebhookHandlerContext, '$'>): Promise<(Connection & { active?: boolean })[]> {
	const result = await ctx.$`amp config model-providers list --json`
	if (result.exitCode !== 0) throw new Error(`amp config model-providers list exited ${result.exitCode}`)
	return (JSON.parse(result.stdout) as { id: string; type: string; name?: string; active?: boolean }[]).map(({ id, type, name, active }) => ({ id, type, name: name ?? '', active }))
}

/** The page transport (a Slack DM to the thread owner). True only when Slack confirmed the post; a failure is logged and left for the caller to retry. */
async function deliver(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, text: string): Promise<boolean> {
	try {
		const result = (await ctx.tools.call('slack_write', { text })) as { isError?: boolean } | undefined
		if (result?.isError) throw new Error('slack_write reported an error')
		return true
	} catch (error: unknown) {
		ctx.logger.log(marker, 'page delivery failed', String(error))
		return false
	}
}

/** One page (pageText) per mismatch; best effort, so a Slack failure never holds an archive. */
async function pageMismatch(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, issue: string, detail: string) {
	const text = `${marker} ${pageText(issue, { kind: 'page', reason: 'subscription-mismatch', detail })}`
	await ctx.tools.call('slack_write', { text }).catch((error: unknown) => ctx.logger.log(marker, 'mismatch page failed', String(error)))
}

// After a role thread ends (its stage passed, or the Watchdog cancelled it): read the thread's
// Model Routing from `amp threads usage --details`, post the sanitized record on its issue
// (models, purposes, connection names; no costs, IDs or links), and page when it was not served
// by the engine its labels name. Threads without an `odd-engine-*` label predate the pins.
const routed = new Set<string>()
async function recordRouting(ctx: ShellContext, thread: LiveThread) {
	const { role, issue } = parseThreadLabels(thread.labels)
	const engine = role ? expectedEngine(role, labOf(thread.labels)) : undefined
	if (!role || !engine) {
		ctx.logger.log(marker, 'no engine pin to check', thread.id)
		return
	}
	const usage = await ctx.$`amp threads usage ${thread.id} --details`
	const routes = usage.exitCode === 0 ? parseRouting(usage.stdout, await connections(ctx)) : []
	const routing: Routing = usage.exitCode === 0 ? checkRouting(engine, routes) : { result: 'missing', problems: [`amp threads usage exited ${usage.exitCode}`] }
	if (issue) await callJson(ctx.tools, 'linear.save_comment', { issueId: issue, body: routingRecord(thread.id, role, engine, routes, routing) })
	if (routing.result !== 'match' && !routed.has(thread.id)) {
		routed.add(thread.id)
		await pageMismatch(ctx, issue ?? '-', `${role} thread ${thread.id} (${engine.model}): ${routing.problems.join('; ')}`)
	}
}

// A PR counts only if it owns the issue by branch name or `closes`/`contributes` line
// (prOwnsIssue). Open PRs are listed directly, because GitHub's search index lags a just-opened
// PR by minutes (MET-279 was moved to Deploying off an older merged PR while #180 was open);
// merged ones were indexed while open, so the quoted search (an unquoted `MET-301` also matches
// `301`) is a safe prefilter for them.
// Ownership is listed with flat fields only and the owning PR alone is read in full: nested
// commits on a 100-PR page ask GitHub for 1,000,000 nodes, over its 500,000 bound (MET-344).
// A failed or malformed read, or a list that fills its limit, throws: it is never "no PR".
// gh reads only a PR's first 100 commits, so the head time is read from the head commit itself.
const prListFields = 'number,headRefName,body'
const prListLimit = 1000
const prFields = 'number,headRefName,headRefOid,state,mergeCommit,mergedAt,mergeable,statusCheckRollup,body'

function ghJson(result: { exitCode: number; stdout: string; stderr: string }, command: string): unknown {
	if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`)
	return JSON.parse(result.stdout)
}

async function ownedPullRequest(ctx: Pick<WebhookHandlerContext, '$'>, identifier: string, state: 'merged' | 'open'): Promise<GitHubPullRequest | undefined> {
	const command = `gh pr list --state ${state}`
	const listed = ghJson(state === 'open'
		? await ctx.$`gh pr list --state open --json ${prListFields} --limit ${String(prListLimit)}`
		: await ctx.$`gh pr list --search ${`"${identifier}"`} --state merged --json ${prListFields} --limit ${String(prListLimit)}`, command)
	if (!Array.isArray(listed) || listed.some(pr => typeof pr?.number !== 'number' || typeof pr.headRefName !== 'string' || typeof pr.body !== 'string')) throw new Error(`${command} returned a malformed PR list`)
	if (listed.length >= prListLimit) throw new Error(`${command} filled its ${prListLimit} limit; PRs past it are unread`)
	const owned = (listed as GitHubPullRequest[]).find(pr => prOwnsIssue(pr, identifier))
	if (!owned) return undefined
	const pr = ghJson(await ctx.$`gh pr view ${String(owned.number)} --json ${prFields}`, `gh pr view ${owned.number}`) as GitHubPullRequest | null
	const sha = (value: unknown) => /^[0-9a-f]{40}$/.test(String(value))
	// A merged PR's merge time is the durable start of its receipt wait, so it must be a usable timestamp.
	const merged = state === 'merged' ? isRow(pr?.mergeCommit) && sha(pr.mergeCommit.oid) && timestamp(pr.mergedAt) : pr?.mergedAt === null || pr?.mergedAt === undefined || timestamp(pr.mergedAt)
	if (!isRow(pr) || pr.number !== owned.number || pr.state !== state.toUpperCase() || !sha(pr.headRefOid) || typeof pr.headRefName !== 'string' || typeof pr.body !== 'string' || !optional(pr, 'mergeable', 'string')
		|| !merged || !Array.isArray(pr.statusCheckRollup) || !pr.statusCheckRollup.every(checkRecord) || !prOwnsIssue(pr, identifier)) {
		throw new Error(`gh pr view ${owned.number} returned malformed or changed details for ${state} ${identifier}`)
	}
	const head = await ctx.$`gh api ${`repos/{owner}/{repo}/commits/${pr.headRefOid}`} --jq .commit.committer.date`
	if (head.exitCode !== 0) throw new Error(`gh api head commit ${pr.headRefOid} failed: ${head.stderr.trim()}`)
	const committedDate = head.stdout.trim()
	if (!timestamp(committedDate)) throw new Error(`gh api head commit ${pr.headRefOid} returned no commit time`)
	return { ...pr, commits: [{ oid: pr.headRefOid, committedDate }] }
}

async function pullRequestFor(ctx: Pick<WebhookHandlerContext, '$'>, identifier: string): Promise<GitHubPullRequest | undefined> {
	// Prefer the open PR; otherwise the merged one, so a merged issue derives `Deploying`.
	return (await ownedPullRequest(ctx, identifier, 'open')) ?? (await ownedPullRequest(ctx, identifier, 'merged'))
}

// `known` are thread IDs this control plane spawned that the search index may not return yet.
// Thread search pages at 100; every page is read so load and the sweep see every live thread.
async function threadsFor(tools: Tools, query: string, known: readonly string[] = []): Promise<LiveThread[]> {
	const found: { id: string; updatedAt?: string }[] = []
	let cursor: string | undefined
	do {
		const page = await callJson<{ nextCursor?: string }>(tools, 'find_thread', { query, limit: 100, ...(cursor ? { cursor } : {}) })
		if (!optional(page as Row, 'nextCursor', 'string')) throw new Error('find_thread returned a malformed nextCursor')
		const threads = listOf<{ id: string; updatedAt?: string }>(page, 'threads', 'find_thread', row => named(row.id) && optional(row, 'updatedAt', 'string'))
		found.push(...threads)
		cursor = threads.length ? page.nextCursor : undefined
	} while (cursor)
	const updated = new Map(found.map(({ id, updatedAt }) => [id, updatedAt]))
	const ids = new Set([...found.map(({ id }) => id), ...known])
	const threads = await Promise.all([...ids].map(async id => {
		const status = await callJson<{ metadata: { labels: string[]; archived?: boolean }; agentState?: { state?: string } }>(tools, 'get_thread_status', { thread: id })
		// An unknown execution state is not idleness: it would let the Watchdog cancel a running thread.
		if (!strings(status?.metadata?.labels) || !named(status.agentState?.state) || !optional(status.metadata, 'archived', 'boolean')) throw new Error(`get_thread_status ${id} returned no labels or agent state`)
		return { id, labels: status.metadata.labels, state: status.agentState.state, archived: status.metadata.archived === true, updatedAt: updated.get(id) }
	}))
	return threads.filter(thread => !thread.archived).map(({ archived: _, ...thread }) => thread)
}

/** Caps from live role threads, and the live role threads per lab that weight reviewer selection. */
async function currentLoad(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>): Promise<{ load: Load; usage: Partial<Record<Lab, number>>; threads: LiveThread[] }> {
	const threads = (await Promise.all(roleLabelQueries.map(query => threadsFor(ctx.tools, query)))).flat()
	const load = loadFrom(threads)
	ctx.logger.log(marker, 'load', JSON.stringify(load), 'of', JSON.stringify(capacity))
	return { load, usage: engineUsage(threads), threads }
}

// The Ralph guard's external checks: each is read from Linear or GitHub, never from the agent.
async function externalStop(ctx: Pick<WebhookHandlerContext, '$' | 'tools' | 'logger'>, role: Role, issue: string, labels: readonly string[]): Promise<{ stopMet: boolean; missing: string[] }> {
	if (role === 'intake' || role === 'spec') {
		const snapshot = await getIssue(ctx.tools, { id: issue })
		const missing = role === 'intake'
			? issueTriaged(snapshot)
			: specComplete(snapshot.description ?? '') ? [] : ['Goal, Isolation, Build, Done means and Evidence sections, with one Evidence line per Done-means item']
		return { stopMet: missing.length === 0, missing }
	}
	if (role === 'verifier') {
		// The verdict is the `odd-verify` comment for the latest receipt's SHA (snapshot.toSnapshot).
		const [snapshot, comments] = await Promise.all([
			getIssue(ctx.tools, { id: issue }),
			listComments(ctx.tools, issue),
		])
		const { deployReceipt, verify } = toSnapshot({ issue: { ...snapshot, comments } })
		if (!deployReceipt) return { stopMet: false, missing: [`no odd-deploy receipt on ${issue}`] }
		return verify?.sha === deployReceipt.sha
			? { stopMet: true, missing: [] }
			: { stopMet: false, missing: [`comment \`${verifyLine({ sha: deployReceipt.sha, result: 'pass' })}\` (or result=fail bug=<MET-n>) on ${issue}`] }
	}
	if (role !== 'builder' && role !== 'reviewer') return { stopMet: true, missing: [] }
	// A failed PR read throws: the guard neither continues the thread nor claims the PR is missing.
	const open = await ownedPullRequest(ctx, issue, 'open')
	if (!open) {
		// A PR merged before the guard ran (MET-279's #179) is delivered work, not a missing PR.
		const merged = await ownedPullRequest(ctx, issue, 'merged')
		return merged ? { stopMet: true, missing: [] } : { stopMet: false, missing: [`no open PR for ${issue}`] }
	}
	const { headRefOid, statusCheckRollup = [] } = open
	if (role === 'reviewer') {
		// The verdict is the reviewer thread's own label for the current head (snapshot.verdictFor).
		const head = headRefOid.slice(0, 12)
		const posted = labels.some(label => label === `odd-verdict-ready-${head}` || label === `odd-verdict-changes-${head}`)
		return posted ? { stopMet: true, missing: [] } : { stopMet: false, missing: [`thread label odd-verdict-<ready|changes>-${head} for PR head ${headRefOid}`] }
	}
	const failing = statusCheckRollup.filter(check => (check.conclusion ?? check.state ?? '').toUpperCase() in { FAILURE: 1, ERROR: 1, CANCELLED: 1 }).map(check => check.name ?? 'check')
	const pending = statusCheckRollup.some(check => !check.conclusion && (check.state ?? '').toUpperCase() !== 'SUCCESS')
	if (failing.length) return { stopMet: false, missing: failing.map(name => `CI job ${name} failed on the PR head`) }
	return pending ? { stopMet: false, missing: ['CI still running on the PR head'] } : { stopMet: true, missing: [] }
}
