// @amp-agent-mode {"key":"odd-intake","label":"ODD Intake"}
// @amp-agent-mode {"key":"odd-spec","label":"ODD Spec"}
// @amp-agent-mode {"key":"odd-builder","label":"ODD Builder"}
// @amp-agent-mode {"key":"odd-reviewer","label":"ODD Reviewer"}
// @amp-agent-mode {"key":"odd-verifier","label":"ODD Verifier"}
// @amp-agent-mode {"key":"odd-deployer","label":"ODD Deployer"}
// @amp-agent-mode {"key":"odd-control","label":"ODD Control"}

import type { Agent, AgentThreadExecutor, PluginAPI, PluginEventContext, ThreadID, WebhookEvent, WebhookHandlerContext } from '@ampcode/plugin'
import {
	capacity,
	contracts,
	deployReceiptLine,
	escalatedLabel,
	issueTriaged,
	nextAction,
	oddLabel,
	parseThreadLabels,
	ralphGuard,
	specComplete,
	threadLabels,
	type Action,
	type DeployReceipt,
	type IssueSnapshot,
	type Load,
	type Role,
} from '../../scripts/odd/lifecycle.ts'
import { intakeChannel, intakeEmoji, intakePrompt, pendingIntake, slackSourceLabel, type SlackMessage } from '../../scripts/odd/intake.ts'
import { finishedThreads, issueFromEvent, loadFrom, prOwnsIssue, roleLabelQueries, toSnapshot, type GitHubPullRequest, type LinearIssue, type LiveThread } from '../../scripts/odd/snapshot.ts'

export const description =
	'Factory ODD control plane: Linear, GitHub and Slack webhooks drive a deterministic outcome lifecycle; role agents run in orbs; Ralph loops are bounded by external checks. See docs/odd/README.md.'

// The plugin is armed only in the control thread (label odd-control-plane). Everywhere else it
// registers the role modes and the Ralph guard and does nothing on its own. `perform` acts only
// when the control thread also carries odd-perform, and only for the roles already live:
// phase 3 (MET-278) spawns intake and spec and sets Triage/Todo; phase 4 (MET-279) adds the
// builder, the reviewer and the deterministic merge for issues labelled `odd`.
const controlLabel = 'odd-control-plane'
const performLabel = 'odd-perform'
const marker = '[odd]'
const liveRoles: ReadonlySet<Role> = new Set<Role>(['intake', 'spec', 'builder', 'reviewer'])
const slackPollMs = 5 * 60_000
/** Runner ID of the host the deploy job runs on; the red-deploy log reader runs there. */
const deployRunner = 'factory-gpu'

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
			// update_thread lets a role label its own thread (the reviewer's verdict is a label).
			tools: { add: ['mcp__linear__*', 'slack_read', 'slack_write', 'create_thread', 'get_thread_status', 'wait_for_threads', 'update_thread'], ...tools },
			display: { label, color: '#0f766e' },
		})

	const modes: { key: string; label: string; agent: Agent }[] = [
		{ key: 'intake', label: 'ODD Intake', agent: roleAgent('intake', 'low', 'ODD Intake', 'Turn a message or bare issue into a Linear issue in the team template, with type and area labels and a duplicate check.') },
		{ key: 'spec', label: 'ODD Spec', agent: roleAgent('spec', 'medium', 'ODD Spec', 'Write Isolation, Build, Done means and Evidence; one Evidence line per Done-means item; set priority and risk.') },
		{ key: 'builder', label: 'ODD Builder', agent: roleAgent('builder', 'medium', 'ODD Builder', 'Implement the smallest correct change on your own branch, open the PR with the Evidence output in its body, and keep the same thread and branch across review rounds.') },
		{ key: 'reviewer', label: 'ODD Reviewer', agent: roleAgent('reviewer', 'high', 'ODD Reviewer', 'Rerun the Evidence commands yourself at the exact head SHA. Verdict is bound to that SHA: a PR comment plus the odd-verdict thread label.', { exclude: ['edit_file', 'create_file'] }) },
		{ key: 'verifier', label: 'ODD Verifier', agent: roleAgent('verifier', 'low', 'ODD Verifier', 'Check each Done-means item against the deployed system using the Evidence lines and the deploy receipt.', { exclude: ['edit_file', 'create_file'] }) },
		{ key: 'deployer', label: 'ODD Deployer', agent: roleAgent('deployer', 'low', 'ODD Deployer', 'Read the factory-deploy journal and ledger for the red receipt you were given and attach the installer and journal excerpts to the named issue. Never run installers, rollbacks, sudo or systemctl.', { exclude: ['edit_file', 'create_file'] }) },
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
		try {
			const { snapshot: issue, threads } = await snapshotFor(ctx, identifier, spawned.get(identifier) ?? [])
			const finished = finishedThreads(issue.status, threads)
			if (finished.length && (await ctx.thread.labels()).includes(performLabel)) await archiveThreads(ctx, finished)
			const action = nextAction(issue, await currentLoad(ctx))
			ctx.logger.log(marker, source, issue.identifier, issue.status, JSON.stringify(action))
			entry.status = issue.status
			entry.action = action
			const ownerBusy = action.kind === 'spawn' || (action.kind === 'wait' && action.reason.endsWith('running'))
			if (ownerBusy) recheck(ctx, state, identifier, recheckMs)
			if (!(await ctx.thread.labels()).includes(performLabel)) {
				ctx.logger.log(marker, 'dry run; add label', performLabel, 'to act')
				entry.stage = 'dry-run'
				return entry
			}
			await perform(ctx, issue, action)
			entry.stage = 'performed'
			failures.delete(identifier)
		} catch (error: unknown) {
			entry.stage = 'failed'
			entry.error = String(error)
			ctx.logger.log(marker, source, 'evaluation failed', entry.error)
			const count = (failures.get(identifier) ?? 0) + 1
			failures.set(identifier, count)
			if (count <= failureRechecks) recheck(ctx, state, identifier, recheckMs * 2 ** (count - 1))
			else ctx.logger.log(marker, 'giving up rechecks after failures', identifier, count)
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

	async function spawnThread(parentThreadID: ThreadID, role: Role, labels: string[], content: string, executor: AgentThreadExecutor = 'orb'): Promise<string> {
		const agent = agents[role]
		if (!agent) throw new Error(`no plugin agent for role ${role}`)
		const thread = await agent.createThread({ executor, parentThreadID, visibility: 'workspace' })
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
	// issues between Triage and Todo; phase 4 builds, reviews and merges; deploy is deferred.
	// ODD owns Backlog and Triage for every issue. From Todo on, the dispatcher still owns an
	// issue unless it carries the `odd` label (§6), so an issue the orchestrator created in Todo
	// without an Evidence section is neither pulled back into Triage nor built twice.
	// A steer is delivered once per (thread, message): the message names the head SHA, and the
	// same evaluation repeats on every webhook until the builder pushes.
	const steered = new Set<string>()
	async function perform(ctx: EvalContext, issue: IssueSnapshot, action: Action) {
		const owned = issue.status === 'Backlog' || issue.status === 'Triage' || issue.labels.includes(oddLabel)
		if (!owned) {
			ctx.logger.log(marker, 'deferred: dispatcher owns', issue.identifier, issue.status, action.kind)
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
				const target = action.role === 'reviewer' && issue.pr ? ` Review PR #${issue.pr.number} at head ${issue.pr.headSha}.` : ''
				const threadID = await spawnThread(
					ctx.thread.id,
					action.role,
					threadLabels(issue.identifier, action.role, action.round),
					`${marker} Outcome ${issue.identifier}. Role: ${action.role}. Reason: ${action.reason}.${target} Load the \`${contracts[action.role].skill}\` skill and start.`,
				)
				spawned.set(issue.identifier, [...(spawned.get(issue.identifier) ?? []), threadID])
				// Todo -> In Progress is the builder's claim; the status change is the handoff artifact (§7).
				if (action.role === 'builder' && issue.status === 'Todo') await callJson(ctx.tools, 'linear.save_issue', { id: issue.identifier, state: 'In Progress' })
				return
			}
			case 'set-status':
				await setStatus(ctx, issue, action, spawnDeployer(ctx))
				return
			case 'steer': {
				const key = `${action.threadID}:${action.message}`
				if (steered.has(key)) return
				steered.add(key)
				await amp.threads.get(action.threadID as ThreadID).appendUserMessage({ type: 'user-message', content: `${marker} ${action.message}` }, { steer: true })
				return
			}
			case 'merge':
				await merge(ctx, issue, action.pr, action.sha)
				return
			case 'page':
				await page(ctx, issue, action, spawnDeployer(ctx))
				return
			default:
				ctx.logger.log(marker, 'deferred to a later phase', action.kind)
		}
	}

	// The Shipper (§4) is this function: the dispatcher's merge gate at the exact head, then a
	// head-pinned squash merge. Self-deploying paths pass because ODD merges them too (§1). A
	// refusal is posted once per head so the builder sees it; the next push re-enters the loop.
	const refused = new Set<string>()
	async function merge(ctx: EvalContext, issue: IssueSnapshot, pr: number, sha: string) {
		const root = (await ctx.$`git rev-parse --show-toplevel`).stdout.trim()
		const check = await ctx.$`node ${`${root}/scripts/dispatch/qa.ts`} check ${String(pr)} ${sha} --self-deploying-ok`
		if (check.exitCode !== 0) {
			const cause = check.stderr.trim() || check.stdout.trim()
			ctx.logger.log(marker, 'merge refused', issue.identifier, pr, sha, cause)
			if (!refused.has(sha)) {
				refused.add(sha)
				await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: `odd-merge-refused pr=${pr} head=${sha}\n\n${cause}` })
			}
			return
		}
		const merged = await ctx.$`gh pr merge ${String(pr)} --squash --match-head-commit ${sha}`
		if (merged.exitCode !== 0) throw new Error(`gh pr merge ${pr} at ${sha} failed: ${merged.stderr.trim()}`)
		const view = await ctx.$`gh pr view ${String(pr)} --json mergeCommit --jq .mergeCommit.oid`
		const mergeSha = view.exitCode === 0 ? view.stdout.trim() : 'unknown'
		await callJson(ctx.tools, 'linear.save_comment', { issueId: issue.identifier, body: `odd-merge pr=${pr} head=${sha} merge=${mergeSha} release=none` })
		ctx.logger.log(marker, 'merged', issue.identifier, pr, sha, mergeSha)
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
// on it), the PR goes back to draft so nothing merges it, and Devon gets one Slack DM.
// `slack_write` without a recipient DMs the thread owner. The label is written last, so a failed
// step is retried by the next evaluation. A failed rollback starts its log reader first; a page
// is never held back by that spawn, so its failure goes into the page instead.
export async function page(ctx: Pick<WebhookHandlerContext, 'tools' | '$' | 'logger'>, issue: IssueSnapshot, action: Extract<Action, { kind: 'page' }>, spawn?: Spawn) {
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
	await ctx.tools.call('slack_write', { text: `${marker} ${issue.identifier} escalated (${action.reason}): ${detail}. Remove the \`${escalatedLabel}\` label to resume.` })
	await callJson(ctx.tools, 'linear.save_issue', { id: issue.identifier, addLabels: [escalatedLabel] })
	ctx.logger.log(marker, 'paged', issue.identifier, action.reason)
}

// A rolled-back release returns its issues to Todo and files one Bug in Backlog per failed
// release (the title carries the SHA; a second issue of the same release reuses it). Returns the Bug.
export async function followUp(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, issue: IssueSnapshot, followUp: { title: string; body: string }): Promise<string | undefined> {
	const existing = await callJson<{ issues?: { id?: string; title?: string }[] }>(ctx.tools, 'linear.list_issues', { team: 'Metacomet', query: followUp.title, limit: 10 })
	const match = existing.issues?.find(candidate => candidate.title === followUp.title)
	if (match?.id) {
		await callJson(ctx.tools, 'linear.save_issue', { id: match.id, relatedTo: [issue.identifier] })
		ctx.logger.log(marker, 'follow-up exists', issue.identifier, match.id)
		return match.id
	}
	const created = await callJson<{ id?: string; identifier?: string }>(ctx.tools, 'linear.save_issue', { team: 'Metacomet', title: followUp.title, description: followUp.body, labels: ['Bug', 'area:agents'], state: 'Backlog', relatedTo: [issue.identifier] })
	ctx.logger.log(marker, 'follow-up filed', issue.identifier, created.identifier ?? created.id ?? '')
	return created.identifier ?? created.id
}

// One log-reading Deployer per red release (label odd-deploy-<sha12>, searched without an
// archived:false filter, plus this process's memory while the search index lags). It attaches the installer and
// journal excerpts to the Bug, or to the issue when the rollback failed and no Bug exists.
const diagnosed = new Set<string>()
export async function diagnose(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, issue: IssueSnapshot, receipt: DeployReceipt, bug: string | undefined, spawn: Spawn) {
	const label = `odd-deploy-${receipt.sha.slice(0, 12)}`
	const found = await callJson<{ threads: { id: string }[] }>(ctx.tools, 'find_thread', { query: `label:${label}`, limit: 1 })
	if (diagnosed.has(label) || found.threads.length) {
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
		callJson<LinearIssue>(ctx.tools, 'linear.get_issue', { id: identifier, includeRelations: true }),
		callJson<{ comments?: { body: string }[] }>(ctx.tools, 'linear.list_comments', { issueId: identifier, limit: 50 }).then(result => result.comments ?? []),
		pullRequestFor(ctx, identifier),
		threadsFor(ctx.tools, `label:odd-issue-${identifier.toLowerCase()} archived:false`, knownThreads),
	])
	// `blockedBy` lists the relation's issues without their status; a blocker is open until closed.
	const blockers = await Promise.all((issue.relations?.blockedBy ?? []).map(({ id }) => callJson<LinearIssue>(ctx.tools, 'linear.get_issue', { id })))
	const openBlockers = blockers.filter(blocker => !['Done', 'Canceled', 'Duplicate'].includes(blocker.status)).map(blocker => blocker.id)
	return { snapshot: toSnapshot({ issue: { ...issue, comments }, pr, threads, openBlockers }), threads }
}

// Finished role threads are archived so the thread list shows only live work; an archived
// thread keeps its labels, so a later `find_thread … archived:false` no longer counts it.
async function archiveThreads(ctx: Pick<WebhookHandlerContext, 'tools' | 'logger'>, threads: readonly LiveThread[]) {
	for (const thread of threads) {
		await callJson(ctx.tools, 'update_thread', { thread: thread.id, archived: true })
		ctx.logger.log(marker, 'archived finished thread', thread.id)
	}
}

// A PR counts only if it owns the issue by branch name or `closes`/`contributes` line
// (prOwnsIssue). Open PRs are listed directly, because GitHub's search index lags a just-opened
// PR by minutes (MET-279 was moved to Deploying off an older merged PR while #180 was open);
// merged ones were indexed while open, so the quoted search (an unquoted `MET-301` also matches
// `301`) is a safe prefilter for them.
const prFields = 'number,headRefName,headRefOid,state,mergeCommit,statusCheckRollup,body'

async function pullRequestsFor(ctx: Pick<WebhookHandlerContext, '$' | 'logger'>, identifier: string, state: 'merged' | 'open'): Promise<GitHubPullRequest[]> {
	const result = state === 'open'
		? await ctx.$`gh pr list --state open --json ${prFields} --limit 100`
		: await ctx.$`gh pr list --search ${`"${identifier}"`} --state merged --json ${prFields} --limit 20`
	if (result.exitCode !== 0) {
		ctx.logger.log(marker, 'gh pr list failed', result.stderr.trim())
		return []
	}
	return (JSON.parse(result.stdout) as GitHubPullRequest[]).filter(pr => prOwnsIssue(pr, identifier))
}

async function pullRequestFor(ctx: Pick<WebhookHandlerContext, '$' | 'logger'>, identifier: string): Promise<GitHubPullRequest | undefined> {
	// Prefer the open PR; otherwise the merged one, so a merged issue derives `Deploying`.
	const [open] = await pullRequestsFor(ctx, identifier, 'open')
	if (open) return open
	const [merged] = await pullRequestsFor(ctx, identifier, 'merged')
	return merged
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
async function externalStop(ctx: Pick<WebhookHandlerContext, '$' | 'tools' | 'logger'>, role: Role, issue: string, labels: readonly string[]): Promise<{ stopMet: boolean; missing: string[] }> {
	if (role === 'intake' || role === 'spec') {
		const snapshot = await callJson<LinearIssue>(ctx.tools, 'linear.get_issue', { id: issue })
		const missing = role === 'intake'
			? issueTriaged(snapshot)
			: specComplete(snapshot.description ?? '') ? [] : ['Goal, Isolation, Build, Done means and Evidence sections, with one Evidence line per Done-means item']
		return { stopMet: missing.length === 0, missing }
	}
	if (role !== 'builder' && role !== 'reviewer') return { stopMet: true, missing: [] }
	const [open] = await pullRequestsFor(ctx, issue, 'open')
	if (!open) return { stopMet: false, missing: [`no open PR for ${issue}`] }
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
