// @amp-agent-mode {"key":"odd-intake","label":"ODD Intake"}
// @amp-agent-mode {"key":"odd-spec","label":"ODD Spec"}
// @amp-agent-mode {"key":"odd-builder","label":"ODD Builder"}
// @amp-agent-mode {"key":"odd-reviewer","label":"ODD Reviewer"}
// @amp-agent-mode {"key":"odd-reviewer-xai","label":"ODD Reviewer (xai)"}
// @amp-agent-mode {"key":"odd-verifier","label":"ODD Verifier"}
// @amp-agent-mode {"key":"odd-deployer","label":"ODD Deployer"}
// @amp-agent-mode {"key":"odd-control","label":"ODD Control"}

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Agent, AgentThreadExecutor, PluginAPI, PluginEventContext, ThreadID, WebhookEvent, WebhookHandlerContext } from '@ampcode/plugin'
import {
	budgetLine,
	cancelledLine,
	capacity,
	capacityWait,
	contracts,
	deployReceiptLine,
	escalatedLabel,
	escalationLine,
	issueTriaged,
	heartbeatLine,
	heartbeatProject,
	nextAction,
	oddLabel,
	parseDeployReceipt,
	pageText,
	parseHeartbeat,
	parseThreadLabels,
	ralphGuard,
	resumeLine,
	spawnKey,
	spawnLine,
	specComplete,
	steerLine,
	threadLabels,
	verifyLine,
	waitAge,
	type Action,
	type DeployReceipt,
	type EscalationStep,
	type IssueSnapshot,
	type Load,
	type Role,
	type SpawnRecord,
} from '../../scripts/odd/lifecycle.ts'
import { intakeChannel, intakeEmoji, intakePrompt, pendingIntake, slackSourceLabel, type SlackMessage } from '../../scripts/odd/intake.ts'
import { admittedLoad, diagnosedLabel, failedReceiptAt, finishedThreads, issueFromEvent, linearUnresolved, loadFrom, prEligible, prOwnsIssue, readerLabel, receiptLabel, reconciles, roleLabelQueries, spawnRecords, toSnapshot, verdictPattern, type GitHubPullRequest, type LinearIssue, type LiveThread, type Reservation } from '../../scripts/odd/snapshot.ts'
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

// --- Webhook authenticity (docs/odd/README.md §9). Amp hands the handler the exact request
// bytes and the requested headers but authenticates nothing upstream, so every delivery is
// checked against its provider's signing secret before it is deduplicated or read.
type Provider = 'github' | 'linear'
const providers: readonly Provider[] = ['linear', 'github']
/** Project secrets Amp injects into the orb's environment; read once per arm, never logged or returned. */
const secretEnv: Record<Provider, string> = { github: 'ODD_GITHUB_WEBHOOK_SECRET', linear: 'ODD_LINEAR_WEBHOOK_SECRET' }
/** GitHub signs as `sha256=<hex>`, Linear as bare `<hex>`: HMAC-SHA256 of the raw body. */
const signatureHeaders: Record<Provider, { name: string; format: RegExp }> = {
	github: { name: 'x-hub-signature-256', format: /^sha256=([0-9a-f]{64})$/i },
	linear: { name: 'linear-signature', format: /^([0-9a-f]{64})$/i },
}
/** Linear's documented replay guard: the signed `webhookTimestamp` within a minute of receipt. */
export const linearFreshMs = 60_000

/**
 * Why a delivery is not authentic, or undefined when it is. Freshness is measured against
 * Amp's server-side `receivedAt`, so Amp's own retries of a failed handler stay valid. The
 * reason never contains the secret or the signature.
 */
export function rejectDelivery(provider: Provider, secret: string, event: Pick<WebhookEvent, 'body' | 'headers' | 'receivedAt'>): string | undefined {
	const { name, format } = signatureHeaders[provider]
	const header = event.headers[name]
	if (!header) return `missing ${name}`
	const hex = format.exec(header.trim())?.[1]
	if (!hex) return `malformed ${name}`
	if (!timingSafeEqual(createHmac('sha256', secret).update(event.body).digest(), Buffer.from(hex, 'hex'))) return `invalid ${name}`
	if (provider === 'github') return undefined
	let sent: unknown
	try { sent = (JSON.parse(new TextDecoder().decode(event.body)) as { webhookTimestamp?: unknown }).webhookTimestamp } catch { return 'unparseable body' }
	const received = Date.parse(event.receivedAt)
	if (typeof sent !== 'number' || !Number.isFinite(received)) return 'missing webhookTimestamp'
	return Math.abs(received - sent) > linearFreshMs ? `stale delivery (${Math.round((received - sent) / 1000)} s from receipt)` : undefined
}

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
		stage: 'received' | 'ignored' | 'rejected' | 'dry-run' | 'performed' | 'failed'
		status?: string
		action?: Action
		error?: string
		/** The wait's age against its budget (`ci 12 min`), or `unknown` when no durable start time exists. */
		wait?: string
		/** The evaluation failed on an authoritative read (ReadError), even after an action was chosen. */
		read?: boolean
	}
	type ArmState = {
		armed: boolean
		error?: string
		webhooks: string[]
		urls: string[]
		/** Signing secrets, in memory only, never logged, returned or persisted: from the project environment (secretEnv) at arm, else entered through a secret dialog until the next reload. */
		secrets: Partial<Record<Provider, string>>
		/** Providers whose secret came from the project environment; a private dialog never replaces them. */
		configured: Provider[]
		events: HandledEvent[]
		/** Slack intake poll: last run, last error, and the message timestamps handed to Intake. */
		slack: { polledAt?: string; error?: string; spawned: string[] }
		/** Watchdog sweep (scripts/odd/watchdog.ts): last run, issues swept, episodes in progress, digest day, cancellations today. */
		watchdog: { sweptAt?: string; error?: string; issues?: number; overSince?: string; alerted?: boolean; blindSince?: string; paged?: boolean; digestDay?: string; digestError?: string; heartbeatId?: string; cancelled: string[]; waits: Record<string, DigestWait & { list: 'risk' | 'failedVerification' | 'unknownAge' }>; overdue: string[] }
		/** Failing actions by `<issue> <episode key>` (scripts/odd/watchdog.ts Episode), and the build slots the incidents are judged against. */
		episodes: Record<string, Episode>
		plane: Plane
		/** Arm-time check that each pinned model is served by its subscription (checkPins): when it ran and what failed. */
		pins: { checkedAt?: string; problems?: string[] }
		timers: ReturnType<typeof setInterval>[]
	}
	const armState = new Map<ThreadID, ArmState>()
	const emptyState = (): ArmState => ({ armed: false, webhooks: [], urls: [], secrets: {}, configured: [], events: [], slack: { spawned: [] }, watchdog: { cancelled: [], waits: {}, overdue: [] }, episodes: {}, plane: { load: { orbs: 0, runnerSlots: 0, buildIssues: 0 }, building: [], waiting: [] }, pins: {}, timers: [] })
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
			'ODD control plane state for this thread: labels, executor kind, whether webhooks are armed, last arming error, the last 20 handled events (webhooks, Slack intake polls, Watchdog sweeps), Slack poll and Watchdog state. Pass arm: true to arm now (control thread in an orb only). Pass poll_slack: true to poll #factory-intake now. Pass sweep: true to run the Watchdog sweep now. Pass show_urls: true to show the webhook URLs to the human in a confirm dialog; the call blocks until they answer. URLs are never returned to the agent. Signing secrets come from the project environment (ODD_GITHUB_WEBHOOK_SECRET, ODD_LINEAR_WEBHOOK_SECRET) at arm; pass set_secrets: true to ask the human in private dialogs for each provider the environment does not configure (kept only until the next reload). Until a provider\'s secret is set its deliveries are refused and nothing is evaluated. Secrets are never returned; status shows only set or missing and the source (environment or private).',
		inputSchema: {
			type: 'object',
			properties: {
				arm: { type: 'boolean', description: 'Arm the control plane now if not armed' },
				poll_slack: { type: 'boolean', description: 'Poll #factory-intake now and hand new messages to Intake (dry run without the odd-perform label)' },
				sweep: { type: 'boolean', description: 'Run the Watchdog sweep now: re-evaluate every live or ODD-owned issue' },
				show_urls: { type: 'boolean', description: 'Show the webhook URLs to the human in a dialog and wait for them to confirm' },
				set_secrets: { type: 'boolean', description: 'Ask the human in private dialogs for the webhook signing secret of each provider not configured by the project environment (URLs unchanged)' },
			},
		},
		async execute(input, ctx) {
			const labels = await ctx.thread.labels()
			if (input.arm === true) await arm(ctx, labels, true)
			const current = armState.get(ctx.thread.id)
			if (input.poll_slack === true && current?.armed) await pollSlackIntake(ctx, current)
			if (input.sweep === true && current?.armed) await sweep({ ...ctx, $: amp.$ }, current)
			if (input.set_secrets === true && current) await setSecrets(ctx, current, true)
			const { urls, secrets, configured, timers: _timers, ...state } = current ?? emptyState()
			const dialog = input.show_urls === true && urls.length > 0 ? await showUrls(ctx, urls) : undefined
			const signing = Object.fromEntries(providers.map(provider => [provider, secrets[provider] ? 'set' : 'missing']))
			const signingSource = Object.fromEntries(providers.filter(provider => secrets[provider]).map(provider => [provider, configured.includes(provider) ? 'environment' : 'private']))
			return JSON.stringify({ thread: ctx.thread.id, labels, executor: amp.system.executor.kind, ...state, signing, signingSource, dialog })
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
		// The project environment wins; a retried arm keeps secrets already entered privately for
		// the rest; a plugin reload keeps only what the environment (fixed per process) provides.
		const state = { ...emptyState(), secrets: { ...previous?.secrets } }
		for (const provider of providers) {
			const value = process.env[secretEnv[provider]]?.trim()
			if (!value) continue
			state.secrets[provider] = value
			state.configured.push(provider)
		}
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
		// Linear signatures accepted in the freshness window, by event: the same signed bytes under
		// another event ID are a replay; the same event ID is Amp retrying its own delivery.
		const accepted = new Map<string, { id: string; at: number }>()
		const replayed = (event: WebhookEvent): string | undefined => {
			const signature = event.headers[signatureHeaders.linear.name].trim().toLowerCase()
			const at = Date.parse(event.receivedAt)
			for (const [key, prior] of accepted) if (prior.at < at - 2 * linearFreshMs) accepted.delete(key)
			const prior = accepted.get(signature)
			if (prior && prior.id !== event.id) return 'replayed delivery'
			accepted.set(signature, { id: event.id, at })
			return undefined
		}
		const handle = (source: Provider) => async (event: WebhookEvent, hctx: WebhookHandlerContext) => {
			const secret = state.secrets[source]
			if (!secret) {
				// Fail closed and let Amp retry (up to an hour) until the secret is set in private.
				record(state, { at: event.receivedAt, source, issue: null, stage: 'rejected', error: 'signing secret not set' })
				throw new Error(`${source} signing secret not set; set project secret ${secretEnv[source]} and amp orb restart-processes, or odd_control_status set_secrets:true`)
			}
			const rejected = rejectDelivery(source, secret, event) ?? (source === 'linear' ? replayed(event) : undefined)
			if (rejected) {
				record(state, { at: event.receivedAt, source, issue: null, stage: 'rejected', error: rejected })
				hctx.logger.log(marker, source, 'delivery rejected', event.id, rejected)
				return
			}
			if (seen.has(event.id)) return
			seen.add(event.id)
			const body = new TextDecoder().decode(event.body)
			const identifier = issueFromEvent(source, body)
			if (!identifier) {
				record(state, { at: event.receivedAt, source, issue: null, stage: 'ignored' })
				// P3.13: an issue-scoped Linear delivery that names no issue; only its type is logged.
				const unresolved = source === 'linear' ? linearUnresolved(body) : undefined
				if (unresolved) hctx.logger.log(marker, unresolved)
				return
			}
			const entry = await evaluate(hctx, state, source, identifier, event.receivedAt)
			if (entry.stage === 'failed') {
				// A redelivery of a failed event is evaluated again.
				seen.delete(event.id)
				throw new Error(entry.error)
			}
		}
		// Slack intake is polled (pollSlackIntake), so no Slack webhook is registered. Keys are
		// stable, so re-registering after a reload returns the same URLs.
		for (const key of providers) {
			const { url } = await amp.createWebhook({ key, headers: [signatureHeaders[key].name], handler: handle(key) })
			state.webhooks.push(key)
			state.urls.push(`${key}: ${url}`)
		}
		// Not awaited: the dialogs wait for a human and must not hold the turn boundary that armed
		// it. URLs are shown only on demand (odd_control_status show_urls:true).
		void setSecrets(ctx, state).catch((error: unknown) => ctx.logger.log(marker, 'signing secret dialog failed', String(error)))
	}

	// Each missing (or, with `all`, every privately entered) signing secret through an owner-only
	// secret dialog; a provider configured by the project environment is never asked. A dismissed
	// dialog leaves that provider refusing deliveries.
	async function setSecrets(ctx: Pick<ArmContext, 'ui'>, state: ArmState, all = false) {
		for (const provider of providers) {
			if (state.configured.includes(provider) || (state.secrets[provider] && !all)) continue
			const value = (await ctx.ui.input({
				title: `ODD ${provider === 'github' ? 'GitHub' : 'Linear'} webhook signing secret`,
				helpText: `The signing secret of the existing ${provider} webhook, kept in memory only until the next plugin reload; set project secret ${secretEnv[provider]} to keep it. Until it is set, ${provider} deliveries are refused and nothing is evaluated. The URL does not change.`,
				secret: true,
				requireHuman: true,
			}))?.trim()
			if (value) state.secrets[provider] = value
		}
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
	// re-evaluated too, with backoff, up to `failureRechecks` times. One pending re-check per issue;
	// a sooner one replaces a later one, so a merge's immediate re-check is not held behind a backoff.
	const recheckMs = 90_000
	const failureRechecks = 5
	const rechecks = new Map<string, { timer: ReturnType<typeof setTimeout>; due: number }>()
	const failures = new Map<string, number>()
	const recheck = (ctx: EvalContext, state: ArmState, identifier: string, delayMs: number) => {
		const due = Date.now() + delayMs
		const pending = rechecks.get(identifier)
		if (pending && pending.due <= due) return
		if (pending) clearTimeout(pending.timer)
		rechecks.set(identifier, { due, timer: setTimeout(() => {
			rechecks.delete(identifier)
			void evaluate(ctx, state, 'recheck', identifier, new Date().toISOString())
		}, delayMs) })
	}
	// Linear sends several webhooks for one change and `find_thread` indexes a new thread with a
	// lag, so evaluations of one issue run one at a time, and every spawn is recorded on the issue
	// (`odd-spawn`) before its create and bound to the returned thread before its outcome is sent.
	// The next evaluation, in this process or after a reload, reads the bound thread by its ID.
	const queues = new Map<string, Promise<unknown>>()
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
			// The issue's log readers this process spawned are read by ID, like bound spawn records: one search has not
			// returned yet is still archived once diagnosed, which frees its runner slot (no issue record holds it).
			const readers = [...ledger].flatMap(([slot, held]) => (held.role === 'deployer' && held.thread && slot.split(' ').includes(`odd-issue-${identifier.toLowerCase()}`) ? [held.thread] : []))
			const derived = await snapshotFor(ctx, identifier, merged.get(identifier), readers)
			const { threads, comments } = derived
			issue = derived.snapshot
			loadEpisodes(state, issue.identifier, comments)
			performing = (await ctx.thread.labels()).includes(performLabel)
			if (performing) await reconcileSpawns(ctx, issue, threads)
			holdSpawns(issue, threads)
			const finished = finishedThreads(issue.status, threads)
			if (finished.length && performing) {
				await archiveThreads(ctx, finished)
				// An archived log reader may never have been returned by thread search, which is what admission waits for; its slot is free now.
				for (const [slot, held] of ledger) if (finished.some(thread => thread.id === held.thread)) ledger.delete(slot)
			}
			const { usage, threads: live } = await currentLoad(ctx)
			// The issue's own reservations are left out: a pending one must reach perform's fail-closed check and page, not wait on its own slot.
			const { load } = admittedLoad(live, [...ledger.values()].filter(held => held.issue !== issue!.identifier))
			state.plane = { load, building: [...new Set(live.flatMap(thread => { const labels = parseThreadLabels(thread.labels); return labels.role === 'builder' && labels.issue ? [labels.issue] : [] }))].sort(), waiting: state.plane.waiting }
			const action = nextAction(issue, load, Date.now())
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
				entry.stage = (await perform(ctx, state, issue, action, threads, usage, touched, comments)) ? 'performed' : 'ignored'
			}
			if (action.kind === 'wait') await alertOverdue(ctx, state, issue, action, comments)
			await resolveEpisodes(ctx, state, issue.identifier, touched)
			failures.delete(identifier)
		} catch (error: unknown) {
			entry.stage = 'failed'
			entry.error = String(error)
			// A failed authoritative read is a failed derivation wherever it happens, so its episode is the evaluation's, not the action's.
			if (error instanceof ReadError) entry.read = true
			ctx.logger.log(marker, source, 'evaluation failed', entry.error)
			const count = (failures.get(identifier) ?? 0) + 1
			failures.set(identifier, count)
			const episode = await recordFailure(ctx, state, identifier, failureKey(issue, entry.read ? undefined : entry.action), entry.error)
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

	// --- Admission (P4.1). Every spawn path (issue roles, Slack intake, the red-deploy log reader)
	// takes its cap check and its reservation in one global queue, so concurrent evaluations
	// cannot each see the same free slot. A reservation counts against the caps until thread
	// search returns its thread; one whose create never confirmed a thread is never released in
	// this process. Slots: `<issue> <role> <round> <key>`, `slack <ts>`, `deployer <labels>`.
	const ledger = new Map<string, Reservation>()
	let admission: Promise<unknown> = Promise.resolve()
	const spawnSlot = (identifier: string, record: SpawnRecord) => `${identifier} ${record.role} ${record.round} ${record.key}`
	/** Reserves `slot`, or returns why it must wait. */
	function admit(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, slot: string, reservation: Reservation): Promise<string | undefined> {
		const run = admission.then(async () => {
			if (ledger.has(slot)) return `${slot} is already reserved`
			const { threads } = await currentLoad(ctx)
			const indexed = new Set(threads.map(thread => thread.id))
			for (const [key, held] of ledger) if (held.thread && indexed.has(held.thread)) ledger.delete(key)
			const { load, building } = admittedLoad(threads, [...ledger.values()])
			const wait = capacityWait(reservation.role, load, !(reservation.issue && building.has(reservation.issue)))
			if (!wait) ledger.set(slot, reservation)
			return wait
		})
		admission = run.catch(() => undefined)
		return run
	}
	/** Records from the issue's comments rebuild its reservations after a reload: a pending one is held, a bound one until its thread is archived. */
	function holdSpawns(issue: IssueSnapshot, threads: readonly LiveThread[]) {
		const live = new Set(threads.map(thread => thread.id))
		const pending = new Set<string>()
		for (const record of issue.spawns ?? []) {
			const slot = spawnSlot(issue.identifier, record)
			const held = ledger.get(slot)
			if (!record.thread) {
				pending.add(slot)
				if (!held) ledger.set(slot, { role: record.role, issue: issue.identifier })
			} else if (held) held.thread = record.thread
		}
		for (const [slot, held] of ledger) {
			if (held.issue === issue.identifier && (held.thread ? !live.has(held.thread) : !pending.has(slot))) ledger.delete(slot)
		}
	}
	/** A pending record is bound to the one live thread carrying its role and round labels that no other record owns; the record is never guessed otherwise. */
	async function reconcileSpawns(ctx: EvalContext, issue: IssueSnapshot, threads: readonly LiveThread[]) {
		const bound = new Set((issue.spawns ?? []).flatMap(record => (record.thread ? [record.thread] : [])))
		for (const record of issue.spawns ?? []) {
			if (record.thread) continue
			const match = threads.filter(thread => reconciles(record, thread, bound))
			if (match.length !== 1) continue
			await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: spawnLine({ ...record, thread: match[0].id }) })
			record.thread = match[0].id
			bound.add(match[0].id)
			ctx.logger.log(marker, 'spawn reconciled', issue.identifier, spawnLine(record))
		}
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
		let digestLoad: Load | undefined
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
				// Only a failed derivation is blindness: one before an action was chosen, or a failed authoritative read
				// while acting (MET-344). An action that fails (no reviewer can spawn) is an incident, not a blind plane.
				const evaluated = await evaluate(ctx, state, 'watchdog', identifier, at)
				if (evaluated.stage === 'failed' && (!evaluated.action || evaluated.read)) failed += 1
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
			digestLoad = load
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
			} else {
				if (performing) await writeHeartbeat(ctx, state, at)
				// A blind episode ends only when the evaluations and the heartbeat succeed; the digest has no part in it (P3.8).
				delete watchdog.error
				delete watchdog.blindSince
				watchdog.paged = false
			}
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
			// The digest runs after the heartbeat and apart from it (P3.8): its failure is `digestError`
			// only, retried by the next sweep, and never withholds a heartbeat or ends a blind episode.
			if (digestLoad && performing) await deliverDigest(ctx, watchdog, now, digestLoad)
			sweeping.delete(state)
		}
	}

	// `digestDay` is in memory and a plugin reload forgets it, so the channel itself is the
	// durable record: a digest already posted for the day is not posted again.
	async function deliverDigest(ctx: EvalContext, watchdog: ArmState['watchdog'], now: Date, load: Load) {
		const day = digestDue(watchdog.digestDay, now)
		if (!day) return
		try {
			if (!(await digestPosted(ctx.tools, day))) {
				for (const text of slackMessages(digest(await digestInput(ctx, day, now, load, watchdog.cancelled, Object.values(watchdog.waits))))) await ctx.tools.call('slack_write', { channelName: alertsChannel, text })
			}
			watchdog.digestDay = day
			watchdog.cancelled = []
			delete watchdog.digestError
		} catch (error: unknown) {
			watchdog.digestError = String(error)
			ctx.logger.log(marker, 'digest failed; retried next sweep', watchdog.digestError)
		}
	}

	// One Software Factory project status update, rewritten in place. The id is forgotten on a
	// plugin reload, so the first write after a reload finds the row by its `odd-heartbeat` line.
	async function writeHeartbeat(ctx: EvalContext, state: ArmState, at: string) {
		const body = heartbeatLine(at)
		if (!state.watchdog.heartbeatId) {
			let cursor: string | undefined
			do {
				const page = await readJson<unknown>(ctx.tools, 'linear.get_status_updates', { type: 'project', project: heartbeatProject, orderBy: 'updatedAt', limit: 50, ...(cursor ? { cursor } : {}) })
				// A failed lookup must not look like no row: it would add a second heartbeat row. Every row has its id and body.
				state.watchdog.heartbeatId = listOf<{ id: string; body: string }>(page, 'statusUpdates', 'linear.get_status_updates', row => named(row.id) && typeof row.body === 'string').find(update => parseHeartbeat(update.body))?.id
				cursor = nextPage(page, 'linear.get_status_updates')
			} while (!state.watchdog.heartbeatId && cursor)
		}
		// No `health`: liveness is the `at` timestamp, and the project's health stays Devon's call (P3.8).
		const saved = await callJson<{ id?: string }>(ctx.tools, 'linear.save_status_update', { type: 'project', project: heartbeatProject, body, ...(state.watchdog.heartbeatId ? { id: state.watchdog.heartbeatId } : {}) })
		if (saved.id) state.watchdog.heartbeatId = saved.id
	}

	// Slack filters each page after the limit, so every page of the last day is read.
	async function digestPosted(tools: Tools, day: string): Promise<boolean> {
		// A malformed read is not "no digest yet": that would post the day's digest twice, or count a failed check as healthy.
		return (await slackMessagesFor(tools, { operation: 'read_messages', channelName: alertsChannel, lookback: 'P1D', limit: 100, filter: { containsAll: [digestHeading(day)] } })).length > 0
	}

	// Every page: the sweep must see every issue in the status, not the first 100.
	async function issueIds(tools: Tools, filter: { state: string; label?: string }): Promise<string[]> {
		const ids: string[] = []
		let cursor: string | undefined
		do {
			const page = await readJson<unknown>(tools, 'linear.list_issues', { team: 'Metacomet', ...filter, limit: 100, fields: ['id'], ...(cursor ? { cursor } : {}) })
			for (const issue of listOf<{ id: string }>(page, 'issues', 'linear.list_issues', row => named(row.id))) ids.push(issue.id)
			cursor = nextPage(page, 'linear.list_issues')
		} while (cursor)
		return ids
	}

	// Yesterday's facts for the digest: identifiers, titles and SHAs only (digest() formats them).
	async function digestInput(ctx: EvalContext, day: string, now: Date, load: Load, cancelled: readonly string[], waits: readonly (DigestWait & { list: string })[]): Promise<DigestInput> {
		const listed = (list: string) => waits.filter(wait => wait.list === list).map(({ identifier, reason }) => ({ identifier, reason }))
		const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString()
		// Every read and every field the digest uses is validated: a malformed read fails the digest (retried next sweep), never an empty day.
		type MergedPr = { number: number; title: string; headRefOid: string; mergeCommit: { oid: string }; mergedAt: string }
		const prs = await ghJson(ctx.$`gh pr list --state merged --search ${`merged:>=${since.slice(0, 10)}`} --json number,title,headRefOid,mergeCommit,mergedAt --limit ${String(prListLimit)}`, 'gh pr list for the digest')
		if (!Array.isArray(prs) || !prs.every(pr => isRow(pr) && typeof pr.number === 'number' && typeof pr.title === 'string' && sha40(pr.headRefOid) && isRow(pr.mergeCommit) && sha40(pr.mergeCommit.oid) && timestamp(pr.mergedAt))) {
			throw new ReadError('gh pr list for the digest returned a malformed PR list')
		}
		if (prs.length >= prListLimit) throw new ReadError(`gh pr list for the digest filled its ${prListLimit} limit; PRs past it are unread`)
		type Issue = { id: string; title: string; completedAt?: string; createdAt?: string }
		const issues = (filter: Record<string, unknown>, fields: string[]) => allPages<Issue>('linear.list_issues', async cursor => {
			const page = await readJson<unknown>(ctx.tools, 'linear.list_issues', { team: 'Metacomet', ...filter, limit: 100, fields, ...(cursor ? { cursor } : {}) })
			const rows = listOf<Issue>(page, 'issues', 'linear.list_issues', row => named(row.id) && typeof row.title === 'string' && fields.slice(2).every(field => timestamp(row[field])))
			return { rows, next: nextPage(page, 'linear.list_issues') }
		}, issue => issue.id)
		const titled = (list: Issue[]) => list.map(issue => ({ identifier: issue.id, title: issue.title }))
		const [done, bugs, escalated] = await Promise.all([
			issues({ state: 'Done' }, ['id', 'title', 'completedAt']).then(list => list.filter(issue => issue.completedAt! >= since)),
			issues({ label: 'Bug', createdAt: '-P1D' }, ['id', 'title', 'createdAt']).then(list => list.filter(issue => issue.createdAt! >= since)),
			issues({ label: escalatedLabel }, ['id', 'title']),
		])
		return {
			day,
			merged: (prs as MergedPr[])
				.filter(pr => pr.mergedAt >= since)
				.map(pr => ({ number: pr.number, title: pr.title, headSha: pr.headRefOid, mergeSha: pr.mergeCommit.oid })),
			done: titled(done),
			bugs: titled(bugs),
			escalated: titled(escalated),
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
			// A Slack intake message needs its ts and text (pendingIntake, intakePrompt).
			const messages = await slackMessagesFor(ctx.tools, {
				operation: 'read_messages',
				channelName: intakeChannel,
				lookback: 'P2D',
				limit: 50,
				include: { resolveUsers: true },
			}, row => named(row.ts) && typeof row.text === 'string')
			const perform = (await ctx.thread.labels()).includes(performLabel)
			for (const message of pendingIntake(messages).filter(message => !state.slack.spawned.includes(message.ts))) {
				const action: Action = { kind: 'spawn', role: 'intake', executor: 'orb', reason: `slack ${message.ts}`, round: 1 }
				const entry = record(state, { at, source: 'slack-poll', issue: null, stage: perform ? 'performed' : 'dry-run', action })
				if (!perform) continue
				const slot = `slack ${message.ts}`
				let creating = false
				let thread: string | undefined
				try {
					const wait = await admit(ctx, slot, { role: 'intake' })
					if (wait) {
						entry.stage = 'dry-run'
						entry.action = { kind: 'wait', reason: wait }
						break
					}
					// Marked handed before the create: a create that never confirms its thread is not retried, it pages.
					state.slack.spawned.push(message.ts)
					creating = true
					thread = await spawnThread(ctx.thread.id, 'intake', ['odd-role-intake', 'odd-round-1', slackSourceLabel(message.ts)], intakePrompt(message, marker), 'orb', undefined, async id => {
						const held = ledger.get(slot)
						if (held) held.thread = id
					})
					await ctx.tools.call('slack_read', { operation: 'add_reaction', channelName: intakeChannel, messageTs: message.ts, emoji: intakeEmoji })
					ctx.logger.log(marker, 'slack intake', message.ts, '->', thread)
				} catch (error: unknown) {
					entry.stage = 'failed'
					entry.error = String(error)
					ctx.logger.log(marker, 'slack intake failed', message.ts, entry.error)
					if (creating && !thread) {
						await deliver(ctx, `${marker} ${pageText('-', { kind: 'page', reason: 'action-failed', detail: `Slack intake ${message.ts}: the Intake thread create did not confirm a thread (${sanitizeError(String(error))}); it holds an orb slot and is not retried until the control orb reloads. Look for an odd-slack thread for it before reacting ${intakeEmoji} on the message.` })}`)
					}
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
	// Labels, then `bind` (the durable record of the returned ID), then the outcome: a lost binding
	// leaves a labelled thread reconciliation can find, and no thread gets its outcome unrecorded.
	async function spawnThread(parentThreadID: ThreadID, role: Role, labels: string[], content: string, executor: AgentThreadExecutor = 'orb', engine?: Engine, bind?: (thread: string) => Promise<void>): Promise<string> {
		const pin = engine ?? pluginPins[role as keyof typeof pluginPins]
		const agent = role === 'builder' ? undefined : role === 'reviewer' ? reviewerAgents.get(pin?.lab as Lab) : agents[role]
		if (!agent || !pin) throw new Error(`no plugin agent for role ${role}${engine ? ` on ${engine.lab}` : ''}`)
		const thread = await agent.createThread({ executor, parentThreadID, visibility: 'workspace' })
		const unlabelled = await thread.setLabels([engineLabel(pin.lab), ...labels]).then(() => undefined, (error: unknown) => error ?? new Error('setLabels failed'))
		await bind?.(thread.id)
		if (unlabelled) throw unlabelled
		await thread.appendUserMessage({ type: 'user-message', content })
		return thread.id
	}

	// The builder is Claude Code on an orb (§6): `amp -ox` through the CLI, labelled at creation and
	// again once its session_id is read, recorded, and only then the local launcher is ended. A
	// failure is posted on the issue once per error and thrown; no plugin agent or other engine
	// stands in for it.
	const launchFailures = new Set<string>()
	async function launchBuilder(ctx: EvalContext, issue: IssueSnapshot, labels: string[], content: string, round: number, bind: (thread: string) => Promise<void>): Promise<string> {
		const expected = [...labels, engineLabel(builderEngine.lab)]
		try {
			return await launch(builderArgs(content, labels, `${issue.identifier} builder round ${round}`), async id => {
				const child = amp.threads.get(id as ThreadID)
				const present = await child.labels()
				if (expected.some(label => !present.includes(label))) await child.addLabels(expected)
				await bind(id)
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
	// Latch IDs whose page Slack took in this process, in case recording the step on the latch failed.
	const paged = new Set<string>()
	/** Returns false when nothing was done because the action is not this control plane's to take. `touched` collects episode keys refused without an exception. */
	async function perform(ctx: EvalContext, state: ArmState, issue: IssueSnapshot, action: Action, threads: readonly LiveThread[], usage: Partial<Record<Lab, number>> = {}, touched = new Set<string>(), comments: readonly Comment[] = []): Promise<boolean> {
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
				// A create that never confirmed its thread may have started one: nothing relaunches the role, so the
				// failure episode pages until a live thread with the record's labels binds it or Devon removes the record.
				const unconfirmed = issue.spawns?.find(record => record.role === action.role && !record.thread)
				if (unconfirmed) throw new Error(`${spawnLine(unconfirmed)} has no confirmed thread; no ${action.role} is launched until a live thread with its labels binds it or the record is removed`)
				// A verifier is labelled with the receipt it verifies, so the next release's receipt starts a fresh budget.
				const receipt = action.role === 'verifier' && issue.deployReceipt ? [receiptLabel(issue.deployReceipt.sha)] : []
				const labels = [...threadLabels(issue.identifier, action.role, action.round), ...receipt]
				const content = `${marker} Outcome ${issue.identifier}. Role: ${action.role}. Reason: ${action.reason}.${spawnTarget(issue, action.role)} Load the \`${contracts[action.role].skill}\` skill and start.`
				// Cross-lab review: never the lab the issue's builder thread runs on.
				let engine: Engine | undefined
				if (action.role === 'reviewer') {
					const builderLab = labOf(threads.find(thread => parseThreadLabels(thread.labels).role === 'builder')?.labels ?? [])
					engine = selectReviewer(builderLab, usage)
					if (!engine) throw new Error(`no reviewer engine outside the builder's lab ${builderLab ?? builderEngine.lab}`)
				}
				const record: SpawnRecord = { role: action.role, round: action.round, key: spawnKey(issue, action.role) }
				const slot = spawnSlot(issue.identifier, record)
				const wait = await admit(ctx, slot, { role: action.role, issue: issue.identifier })
				if (wait) {
					ctx.logger.log(marker, 'spawn waits', issue.identifier, action.role, wait)
					recheck(ctx, state, issue.identifier, recheckMs)
					return false
				}
				try {
					await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: spawnLine(record) })
				} catch (error: unknown) {
					// The record may still have been written; then the next evaluation holds it as pending.
					ledger.delete(slot)
					throw error
				}
				const bind = async (thread: string) => {
					const held = ledger.get(slot)
					if (held) held.thread = thread
					await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: spawnLine({ ...record, thread }) })
				}
				try {
					if (action.role === 'builder') await launchBuilder(ctx, issue, labels, content, action.round, bind)
					else await spawnThread(ctx.thread.id, action.role, labels, content, 'orb', engine, bind)
				} catch (error: unknown) {
					// The episode's first error is what the incident page quotes, so it names what to reconcile.
					throw new Error(`${error instanceof Error ? error.message : String(error)} (${spawnLine(record)} stays pending: nothing relaunches the ${action.role} until a live thread with its labels binds it or the record is removed)`)
				}
				// Todo -> In Progress is the builder's claim; the status change is the handoff artifact (§7).
				if (action.role === 'builder' && issue.status === 'Todo') await callJson(ctx.tools, 'linear.save_issue', { id: issue.identifier, state: 'In Progress' })
				return true
			}
			case 'set-status':
				// Behind the ownership gate: a merge whose confirmation read failed gets its receipt, once, before Deploying.
				if (action.status === 'Deploying') await receiptMerge(ctx, issue, comments)
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
				const refusal = await merge(ctx, state, issue, action.pr, action.sha, comments)
				if (refusal) {
					const failure = failureKey(issue, action)
					touched.add(failure.key)
					await recordFailure(ctx, state, issue.identifier, failure, `merge refused at ${action.sha}: ${refusal}`)
				}
				return true
			}
			case 'page':
				await page(ctx, issue, action, spawnDeployer(ctx), threads, paged)
				return true
			// Budget and resume records change what the issue may do next, so it is evaluated again at once.
			case 'admit':
				await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: budgetLine(action.budget) })
				recheck(ctx, state, issue.identifier, 0)
				return true
			case 'resume':
				await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: resumeLine(action.escalation, action.epoch) })
				recheck(ctx, state, issue.identifier, 0)
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
	/** The PR this process merged per issue, read by number while GitHub's merged search has not indexed it (P4.6-recheck). */
	const merged = new Map<string, number>()
	// Every refusal and failed merge at one head counts toward that head's failure episode, which pages at the third attempt.
	// A durable receipt for this head means the merge happened; a PR read still showing it open is lag, never a second merge.
	// Once the receipt is written the issue is re-evaluated at once, so it moves to Deploying without a webhook or the sweep.
	async function merge(ctx: EvalContext, state: ArmState, issue: IssueSnapshot, pr: number, sha: string, comments: readonly Comment[]): Promise<string | undefined> {
		if (comments.some(comment => comment.body.startsWith(`odd-merge pr=${pr} head=${sha} `))) throw new ReadError(`PR #${pr} has a merge receipt at ${sha} but still reads open; waiting for GitHub to catch up`)
		const draft = await shellRead(ctx.$`gh pr view ${String(pr)} --json isDraft --jq .isDraft`, `gh pr view ${pr} --json isDraft`)
		if (draft.exitCode !== 0) throw new ReadError(`gh pr view ${pr} --json isDraft failed: ${draft.stderr.trim()}`)
		const isDraft = draft.stdout.trim()
		if (isDraft !== 'true' && isDraft !== 'false') throw new ReadError(`gh pr view ${pr} --json isDraft returned ${JSON.stringify(isDraft.slice(0, 60))}, not true or false`)
		if (isDraft === 'true') {
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
		const result = await ctx.$`gh pr merge ${String(pr)} --squash --match-head-commit ${sha}`
		if (result.exitCode !== 0) throw new Error(`gh pr merge ${pr} at ${sha} failed: ${result.stderr.trim()}`)
		// The receipt needs the merge commit. The merge has happened, so a failed confirmation is a failed read, not a
		// receipt with `merge=unknown`: the next evaluation finds the PR merged and posts the receipt once (receiptMerge).
		const view = await shellRead(ctx.$`gh pr view ${String(pr)} --json mergeCommit --jq .mergeCommit.oid`, `gh pr view ${pr} --json mergeCommit`)
		const mergeSha = view.stdout.trim()
		if (view.exitCode !== 0 || !sha40(mergeSha)) throw new ReadError(`PR #${pr} merged at ${sha}, but its merge commit was not read (${view.exitCode !== 0 ? view.stderr.trim() : `got ${JSON.stringify(mergeSha.slice(0, 60))}`}); the merge receipt waits for the next evaluation`)
		await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: mergeReceipt(pr, sha, mergeSha) })
		ctx.logger.log(marker, 'merged', issue.identifier, pr, sha, mergeSha)
		merged.set(issue.identifier, pr)
		recheck(ctx, state, issue.identifier, 0)
		return undefined
	}

	// The red-deploy log reader (§4 Deployer, Build 6): an Amp low thread on the deploy host, admitted
	// against the runner slots. A create that never confirmed its thread keeps its slot, so the
	// same reader is refused for the rest of this process instead of created again.
	const spawnDeployer = (ctx: EvalContext) => async (labels: string[], content: string) => {
		const slot = `deployer ${labels.join(' ')}`
		const wait = await admit(ctx, slot, { role: 'deployer' })
		if (wait) throw new Error(`log reader not admitted: ${wait}`)
		return spawnThread(ctx.thread.id, 'deployer', labels, content, { type: 'runner', id: deployRunner }, undefined, async id => {
			const held = ledger.get(slot)
			if (held) held.thread = id
		})
	}
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

// Escalation (§8) is a latch (MET-348). The `odd-escalated` comment is written before any side
// effect, so the lifecycle holds from then on; each step after it (the `escalated` label, the PR
// back to draft so nothing merges it, one Slack DM in the one page format, archiving reviewer
// threads with `changes` verdicts for older heads so the next epoch counts afresh) is recorded on
// the latch once it succeeded. A failed step does not stop the others, the evaluation fails, and
// the next one retries only the missing steps (nextAction returns the page with its latch), so a
// partial failure loses no notification and repeats none: the DM is also remembered here, for a
// latch record that failed after Slack took it. `slack_write` without a recipient DMs the thread
// owner. A failed rollback starts its log reader before the DM; a page is never held back by that
// spawn, so its failure goes into the page instead.
export async function page(ctx: Pick<WebhookHandlerContext, 'tools' | '$' | 'logger'>, issue: IssueSnapshot, action: Extract<Action, { kind: 'page' }>, spawn?: Spawn, threads: readonly LiveThread[] = [], delivered = new Set<string>()) {
	const done = new Set<EscalationStep>(action.latch?.done ?? [])
	const body = () => `${escalationLine({ reason: action.reason, pr: action.pr, sha: action.sha, done: [...done] })}\n\n${action.detail}`
	let id = action.latch?.id
	if (!id) id = (await callJson<{ id?: string } | undefined>(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: body() }))?.id
	const failures: unknown[] = []
	const step = async (name: EscalationStep, run: () => Promise<void>) => {
		if (done.has(name)) return
		try {
			await run()
			done.add(name)
			if (id) await callJson(ctx.tools, 'linear.save_comment', { id, body: body() })
		} catch (error: unknown) {
			failures.push(error)
		}
	}
	await step('label', async () => {
		if (!issue.labels.includes(escalatedLabel)) await callJson(ctx.tools, 'linear.save_issue', { id: issue.identifier, addLabels: [escalatedLabel] })
	})
	if (action.pr !== undefined) {
		await step('draft', async () => {
			const draft = await ctx.$`gh pr ready ${String(action.pr)} --undo`
			if (draft.exitCode !== 0) throw new Error(`gh pr ready ${action.pr} --undo failed: ${draft.stderr.trim()}`)
		})
	}
	let detail = action.detail
	// A failed read on the way is still a failed read: it is rethrown once the page is out, so the sweep does not report this evaluation healthy.
	let unread: ReadError | undefined
	if (!done.has('page') && action.diagnose && spawn) {
		try {
			await diagnose(ctx, issue, action.diagnose, undefined, spawn)
		} catch (error: unknown) {
			if (error instanceof ReadError) unread = error
			detail += ` (log reader not started: ${String(error)}; read journalctl -u factory-deploy on ${action.diagnose.host})`
		}
	}
	await step('page', async () => {
		if (id && delivered.has(id)) return
		const sent = (await ctx.tools.call('slack_write', { text: `${marker} ${pageText(issue.identifier, { ...action, detail })} Remove the \`${escalatedLabel}\` label to resume.` })) as { isError?: boolean } | undefined
		if (sent?.isError) throw new Error(`slack_write reported an error for the ${action.reason} page`)
		if (id) delivered.add(id)
	})
	await step('archive', async () => {
		const head = issue.pr?.headSha.slice(0, 12)
		await archiveThreads(ctx, threads.filter(thread => thread.labels.some(label => {
			const match = verdictPattern.exec(label)
			return match?.[1] === 'changes' && match[2] !== head
		})))
	})
	if (failures.length) {
		const error = failures[0]
		// A failed page step after a failed read keeps the read classification, and names both failures.
		if (unread) throw new ReadError(`${unread.message}; then the page failed: ${String(error)}`)
		throw error
	}
	ctx.logger.log(marker, 'paged', issue.identifier, action.reason)
	if (unread) throw unread
}

// A rolled-back release returns its issues to Todo and files one Bug in Triage per failed
// release (the title carries the SHA; a second issue of the same release reuses it). Returns the Bug.
export async function followUp(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, issue: IssueSnapshot, followUp: { title: string; body: string }): Promise<string | undefined> {
	// A malformed row is a failed lookup, never "no Bug yet": that would file a duplicate.
	const existing = listOf<{ id: string; title: string }>(await readJson(ctx.tools, 'linear.list_issues', { team: 'Metacomet', query: followUp.title, limit: 10 }), 'issues', 'linear.list_issues', row => named(row.id) && typeof row.title === 'string')
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
	const label = readerLabel(receipt.sha)
	const found = listOf(await readJson(ctx.tools, 'find_thread', { query: `label:${label}`, limit: 1 }), 'threads', 'find_thread', row => named(row.id))
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
			`Once that comment is posted, add the label \`${diagnosedLabel(receipt.sha)}\` to this thread with \`update_thread\` (\`labels.add\`); the control plane archives the thread on that label.`,
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

/** A failed or malformed authoritative read. Wherever it is thrown, the evaluation is a failed derivation (MET-344). */
class ReadError extends Error {}

/** `callJson` for a read: any failure, an MCP error envelope included, is a ReadError. Writes keep `callJson`. */
async function readJson<T>(tools: Tools, name: string, input: Record<string, unknown>): Promise<T> {
	try {
		return await callJson<T>(tools, name, input)
	} catch (error: unknown) {
		throw error instanceof ReadError ? error : new ReadError(error instanceof Error ? error.message : String(error))
	}
}

const sha40 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)

/** The merge receipt (§7): `odd-merge pr=<n> head=<sha> merge=<sha> release=none`. */
const mergeReceipt = (pr: number, head: string, merge: string) => `odd-merge pr=${pr} head=${head} merge=${merge} release=none`

/**
 * A merged PR without its receipt (the confirmation read after `gh pr merge` failed) gets it before the issue moves to
 * Deploying, from the merge commit the PR read has validated. The receipt is what makes older deploy receipts stale.
 */
async function receiptMerge(ctx: Pick<WebhookHandlerContext, 'tools' | '$'>, issue: IssueSnapshot, comments: readonly { body: string; createdAt?: string }[]) {
	const pr = issue.pr
	if (!pr?.merged || !sha40(pr.mergeSha)) return
	if (comments.some(comment => comment.body.startsWith(`odd-merge pr=${pr.number} head=${pr.headSha} `))) return
	// A late receipt resets every deploy receipt before it. The receipt the lifecycle acts on is the snapshot's
	// (snapshot.toSnapshot: the latest by comment time after the latest merge receipt), so only that one is checked:
	// it is this release's evidence only if its deployed revision contains the merge commit (equal, or a descendant
	// carrying later PRs too, so necessarily deployed after the merge), and then no receipt is recovered over it.
	// Otherwise it is stale, however many earlier receipts were valid, and the recovered receipt retires it.
	// Receipts that cannot be ordered, and an unreadable ancestry, are a failed read.
	if (!timestamp(pr.mergedAt)) throw new ReadError(`PR #${pr.number} has no merge time to order its receipt by`)
	if (comments.some(comment => parseDeployReceipt(comment.body) && !timestamp(comment.createdAt))) throw new ReadError(`${issue.identifier} has a deploy receipt without a creation time`)
	if (issue.deployReceipt && await contains(ctx, issue.deployReceipt.sha, pr.mergeSha)) return
	await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: mergeReceipt(pr.number, pr.headSha, pr.mergeSha) })
}

/** Whether the deployed revision `release` contains `merge`, from GitHub's compare of the two. */
async function contains(ctx: Pick<WebhookHandlerContext, '$'>, release: string, merge: string): Promise<boolean> {
	if (release === merge) return true
	const name = `gh api compare ${merge}...${release}`
	const compare = await shellRead(ctx.$`gh api ${`repos/{owner}/{repo}/compare/${merge}...${release}`} --jq .status`, name)
	const status = compare.stdout.trim()
	if (compare.exitCode !== 0) throw new ReadError(`${name} failed: ${compare.stderr.trim()}`)
	if (!['identical', 'ahead', 'behind', 'diverged'].includes(status)) throw new ReadError(`${name} returned ${JSON.stringify(status.slice(0, 60))}`)
	return status === 'identical' || status === 'ahead'
}

/** The cursor of a Linear page: `hasNextPage` is a boolean, and a next page has a cursor. Ending without one would drop the rest. */
function nextPage(page: unknown, name: string): string | undefined {
	if (!isRow(page) || typeof page.hasNextPage !== 'boolean') throw new ReadError(`${name} returned no hasNextPage`)
	if (!page.hasNextPage) return undefined
	if (!named(page.cursor)) throw new ReadError(`${name} reported a next page without a cursor`)
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
	if (!Array.isArray(list)) throw new ReadError(`${name} returned no ${key} list`)
	const bad = list.findIndex(row => !isRow(row) || !valid(row))
	if (bad >= 0) throw new ReadError(`${name} returned a malformed ${key} row at ${bad}`)
	return list as T[]
}

/** An issue read without its identifier, status or labels is a failed read, not a Backlog issue. */
async function getIssue(tools: Tools, input: Record<string, unknown>): Promise<LinearIssue> {
	const issue = await readJson<unknown>(tools, 'linear.get_issue', input)
	// Requested relations must be present: an absent blocker list would lift the dependency gate.
	const requested = input.includeRelations === true
	const relations = isRow(issue) ? issue.relations : undefined
	const blockedBy = isRow(relations) ? relations.blockedBy : undefined
	const relationsValid = relations === undefined || relations === null
		? !requested
		: isRow(relations) && (blockedBy === undefined || blockedBy === null ? !requested : Array.isArray(blockedBy) && blockedBy.every(row => isRow(row) && named(row.id)))
	if (!isRow(issue) || !named(issue.id) || !named(issue.status) || !strings(issue.labels) || !optional(issue, 'description', 'string') || !relationsValid) {
		throw new ReadError(`linear.get_issue ${String(input.id)} returned a malformed issue`)
	}
	return issue as unknown as LinearIssue
}

/**
 * Every page of a cursor read (MET-345), in page order. `read` validates one page and returns its
 * rows and next cursor; a cursor already sent fails the read, since following it would loop or
 * skip pages. A row repeated across overlapping pages counts once by `key`.
 */
async function allPages<T>(name: string, read: (cursor: string | undefined) => Promise<{ rows: readonly T[]; next?: string }>, key: (row: T) => string | undefined): Promise<T[]> {
	const rows: T[] = []
	const keys = new Set<string>()
	const sent = new Set<string>()
	let cursor: string | undefined
	for (;;) {
		const page = await read(cursor)
		for (const row of page.rows) {
			const id = key(row)
			if (id !== undefined && keys.has(id)) continue
			if (id !== undefined) keys.add(id)
			rows.push(row)
		}
		if (page.next === undefined) return rows
		if (sent.has(page.next)) throw new ReadError(`${name} repeated cursor ${page.next.slice(0, 60)} after ${sent.size + 1} pages`)
		sent.add(page.next)
		cursor = page.next
	}
}

/** Every page of a Slack `read_messages`; `nextCursor` names the next page. */
function slackMessagesFor(tools: Tools, input: Record<string, unknown>, valid: (row: Row) => boolean = () => true): Promise<SlackMessage[]> {
	return allPages<SlackMessage>(`slack_read ${String(input.channelName)}`, async cursor => {
		const page = await readJson<Row>(tools, 'slack_read', { ...input, ...(cursor ? { cursor } : {}) })
		const rows = listOf<SlackMessage>(page, 'messages', 'slack_read', valid)
		if (!optional(page, 'nextCursor', 'string')) throw new ReadError('slack_read returned a malformed nextCursor')
		return { rows, next: named(page.nextCursor) ? page.nextCursor : undefined }
	}, message => (named(message.ts) ? message.ts : undefined))
}

// Every comment, so a receipt or marker older than the newest 100 still counts; toSnapshot orders them by createdAt.
// Like every Linear read, each page must say whether another follows (nextPage): a page without `hasNextPage` is malformed.
const listComments = (tools: Tools, issueId: string): Promise<Comment[]> => allPages<Comment>(`linear.list_comments ${issueId}`, async cursor => {
	const page = await readJson<unknown>(tools, 'linear.list_comments', { issueId, limit: 100, ...(cursor ? { cursor } : {}) })
	const rows = listOf<Comment>(page, 'comments', 'linear.list_comments', row => typeof row.body === 'string' && optional(row, 'id', 'string') && optional(row, 'createdAt', 'string'))
	return { rows, next: nextPage(page, 'linear.list_comments') }
}, comment => comment.id)

type Comment = { id?: string; body: string; createdAt?: string }

/** failedReceiptAt over a comment read: a failed receipt without a creation time is a failed read. */
function failedAt(comments: readonly Comment[]): string | undefined {
	try {
		return failedReceiptAt(comments)
	} catch (error: unknown) {
		throw new ReadError(error instanceof Error ? error.message : String(error))
	}
}

// A thread an `odd-spawn` record binds is read by its ID, so search lag (or a plugin reload) never
// hides it; one whose labels did not land carries its record's role labels. `known` are other
// threads of the issue to read by ID (the log readers this process spawned).
async function snapshotFor(ctx: Pick<WebhookHandlerContext, 'tools' | '$' | 'logger'>, identifier: string, merged?: number, known: readonly string[] = []): Promise<{ snapshot: IssueSnapshot; threads: LiveThread[]; comments: Comment[] }> {
	const [issue, comments] = await Promise.all([
		getIssue(ctx.tools, { id: identifier, includeRelations: true }),
		listComments(ctx.tools, identifier),
	])
	const pr = await pullRequestFor(ctx, identifier, failedAt(comments), merged)
	const bound = new Map(spawnRecords(comments).flatMap(record => (record.thread ? [[record.thread, record] as const] : [])))
	const threads = (await threadsFor(ctx.tools, `label:odd-issue-${identifier.toLowerCase()} archived:false`, [...bound.keys(), ...known])).map(thread => {
		const record = bound.get(thread.id)
		return record && !parseThreadLabels(thread.labels).role ? { ...thread, labels: [...thread.labels, ...threadLabels(identifier, record.role, record.round)] } : thread
	})
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
const prListFields = 'number,headRefName,body,mergedAt'
const prListLimit = 1000
const prFields = 'number,headRefName,headRefOid,state,mergeCommit,mergedAt,mergeable,statusCheckRollup,body'

type ShellResult = { exitCode: number; stdout: string; stderr: string }

/** A shell read: a rejected run (the shell or gh never answered) is a failed read, like a nonzero exit. */
async function shellRead(run: PromiseLike<ShellResult>, command: string): Promise<ShellResult> {
	try {
		return await run
	} catch (error: unknown) {
		throw new ReadError(`${command} did not run: ${error instanceof Error ? error.message : String(error)}`)
	}
}

async function ghJson(run: PromiseLike<ShellResult>, command: string): Promise<unknown> {
	const result = await shellRead(run, command)
	if (result.exitCode !== 0) throw new ReadError(`${command} failed: ${result.stderr.trim()}`)
	try {
		return JSON.parse(result.stdout)
	} catch {
		throw new ReadError(`${command} returned no JSON`)
	}
}

// P4.3: `failed` is the latest failed receipt's time (failedReceiptAt); a PR merged at or before it is skipped (prEligible),
// so an older merge never hides a later one and never stands in for a missing PR after a rollback.
async function ownedPullRequest(ctx: Pick<WebhookHandlerContext, '$'>, identifier: string, state: 'merged' | 'open', failed: string | undefined, merged?: number): Promise<GitHubPullRequest | undefined> {
	const command = `gh pr list --state ${state}`
	const listed = await ghJson(state === 'open'
		? ctx.$`gh pr list --state open --json ${prListFields} --limit ${String(prListLimit)}`
		: ctx.$`gh pr list --search ${`"${identifier}"`} --state merged --json ${prListFields} --limit ${String(prListLimit)}`, command)
	if (!Array.isArray(listed) || listed.some(pr => typeof pr?.number !== 'number' || typeof pr.headRefName !== 'string' || typeof pr.body !== 'string' )) throw new ReadError(`${command} returned a malformed PR list`)
	if (listed.length >= prListLimit) throw new ReadError(`${command} filled its ${prListLimit} limit; PRs past it are unread`)
	// After a failed receipt every merged row is ordered against it, so each needs a usable merge time.
	if (failed && state === 'merged' && listed.some(pr => !timestamp(pr.mergedAt))) throw new ReadError(`${command} returned a merged PR without a usable merge time to order against the failed receipt at ${failed}`)
	const owned = (listed as GitHubPullRequest[]).find(pr => prEligible(pr, identifier, failed))
	return owned && viewPullRequest(ctx, identifier, owned.number, owned.number === merged ? 'merged' : state)
}

/** One owned PR read in full by number, validated to be in `state`; anything else is a failed read. */
async function viewPullRequest(ctx: Pick<WebhookHandlerContext, '$'>, identifier: string, number: number, state: 'merged' | 'open'): Promise<GitHubPullRequest> {
	const pr = await ghJson(ctx.$`gh pr view ${String(number)} --json ${prFields}`, `gh pr view ${number}`) as GitHubPullRequest | null
	// A merged PR's merge time is the durable start of its receipt wait, so it must be a usable timestamp.
	const merged = state === 'merged' ? isRow(pr?.mergeCommit) && sha40(pr.mergeCommit.oid) && timestamp(pr.mergedAt) : pr?.mergedAt === null || pr?.mergedAt === undefined || timestamp(pr.mergedAt)
	if (!isRow(pr) || pr.number !== number || pr.state !== state.toUpperCase() || !sha40(pr.headRefOid) || typeof pr.headRefName !== 'string' || typeof pr.body !== 'string' || !optional(pr, 'mergeable', 'string')
		|| !merged || !Array.isArray(pr.statusCheckRollup) || !pr.statusCheckRollup.every(checkRecord) || !prOwnsIssue(pr, identifier)) {
		throw new ReadError(`gh pr view ${number} returned malformed or changed details for ${state} ${identifier}`)
	}
	const head = await shellRead(ctx.$`gh api ${`repos/{owner}/{repo}/commits/${pr.headRefOid}`} --jq .commit.committer.date`, `gh api head commit ${pr.headRefOid}`)
	if (head.exitCode !== 0) throw new ReadError(`gh api head commit ${pr.headRefOid} failed: ${head.stderr.trim()}`)
	const committedDate = head.stdout.trim()
	if (!timestamp(committedDate)) throw new ReadError(`gh api head commit ${pr.headRefOid} returned no commit time`)
	return { ...pr, commits: [{ oid: pr.headRefOid, committedDate }] }
}

// `merged` is the PR this process just merged (P4.6-recheck). GitHub's lists trail the merge: a stale open-list row
// for it is read as merged, never as open, and while the merged search has not indexed it, it is read by number,
// so the re-check right after a merge derives neither "no PR" nor an open PR. A view still open is a failed read.
async function pullRequestFor(ctx: Pick<WebhookHandlerContext, '$'>, identifier: string, failed: string | undefined, merged?: number): Promise<GitHubPullRequest | undefined> {
	// Prefer the open PR; otherwise the merged one, so a merged issue derives `Deploying`.
	return (await ownedPullRequest(ctx, identifier, 'open', failed, merged)) ?? (await ownedPullRequest(ctx, identifier, 'merged', failed))
		?? (merged === undefined ? undefined : await viewPullRequest(ctx, identifier, merged, 'merged'))
}

const statusReads = 3

// `known` are thread IDs this control plane spawned that the search index may not return yet.
// Thread search pages at 100; every page is read so load and the sweep see every live thread.
async function threadsFor(tools: Tools, query: string, known: readonly string[] = []): Promise<LiveThread[]> {
	const found: { id: string; updatedAt?: string }[] = []
	let cursor: string | undefined
	do {
		const page = await readJson<{ nextCursor?: string }>(tools, 'find_thread', { query, limit: 100, ...(cursor ? { cursor } : {}) })
		if (!optional(page as Row, 'nextCursor', 'string')) throw new ReadError('find_thread returned a malformed nextCursor')
		const threads = listOf<{ id: string; updatedAt?: string }>(page, 'threads', 'find_thread', row => named(row.id) && optional(row, 'updatedAt', 'string'))
		found.push(...threads)
		cursor = threads.length ? page.nextCursor : undefined
	} while (cursor)
	const updated = new Map(found.map(({ id, updatedAt }) => [id, updatedAt]))
	const ids = new Set([...found.map(({ id }) => id), ...known])
	const threads = await Promise.all([...ids].map(async id => {
		// get_thread_status rejects when its own open-dialog read times out, asking to be retried (MET-385). A sweep reads
		// every live thread once per evaluation, so one transient rejection would otherwise fail the whole sweep. The read
		// has no side effect: a rejection is retried up to `statusReads` attempts, the last one still fails the derivation,
		// and a resolved status is validated below and never retried.
		let status: { metadata: { labels: string[]; archived?: boolean }; agentState?: { state?: string } }
		for (let attempt = 1; ; attempt++) {
			try {
				status = await readJson(tools, 'get_thread_status', { thread: id })
				break
			} catch (error: unknown) {
				if (attempt === statusReads) throw error
			}
		}
		// An unknown execution state is not idleness: it would let the Watchdog cancel a running thread.
		if (!strings(status?.metadata?.labels) || !named(status.agentState?.state) || !optional(status.metadata, 'archived', 'boolean')) throw new ReadError(`get_thread_status ${id} returned no labels or agent state`)
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
	// The snapshot's eligibility rule (P4.3): a merge at or before the latest failed receipt is not this round's PR.
	const failed = failedAt(await listComments(ctx.tools, issue))
	const open = await ownedPullRequest(ctx, issue, 'open', failed)
	if (!open) {
		// A PR merged before the guard ran (MET-279's #179) is delivered work, not a missing PR.
		const merged = await ownedPullRequest(ctx, issue, 'merged', failed)
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
