// @amp-agent-mode {"key":"odd-intake","label":"ODD Intake"}
// @amp-agent-mode {"key":"odd-spec","label":"ODD Spec"}
// @amp-agent-mode {"key":"odd-reviewer","label":"ODD Reviewer"}
// @amp-agent-mode {"key":"odd-verifier","label":"ODD Verifier"}
// @amp-agent-mode {"key":"odd-control","label":"ODD Control"}

import type { Agent, PluginAPI, PluginEventContext, ThreadID, WebhookEvent, WebhookHandlerContext } from '@ampcode/plugin'
import {
	capacity,
	contracts,
	nextAction,
	parseThreadLabels,
	ralphGuard,
	threadLabels,
	type Action,
	type IssueSnapshot,
	type Load,
	type Role,
} from '../../scripts/odd/lifecycle.ts'
import { issueFromEvent, loadFrom, roleLabelQueries, toSnapshot, type GitHubPullRequest, type LinearIssue, type LiveThread } from '../../scripts/odd/snapshot.ts'

export const description =
	'Factory ODD control plane: Linear, GitHub and Slack webhooks drive a deterministic outcome lifecycle; role agents run in orbs; Ralph loops are bounded by external checks. See docs/odd/README.md.'

// The plugin is armed only in the control thread (label odd-control-plane). Everywhere else it
// registers the role modes and the Ralph guard and does nothing on its own. Phase 2 (MET-277)
// derives and logs; `perform` acts only when the control thread also carries odd-perform.
const controlLabel = 'odd-control-plane'
const performLabel = 'odd-perform'
const marker = '[odd]'

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
			tools: { add: ['mcp__linear__*', 'create_thread', 'get_thread_status', 'wait_for_threads'], ...tools },
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
	type HandledEvent = { at: string; source: string; issue: string; status: string; action: Action; performed: boolean }
	type ArmState = { armed: boolean; error?: string; webhooks: string[]; urls: string[]; events: HandledEvent[] }
	const armState = new Map<ThreadID, ArmState>()
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
			'ODD control plane state for this thread: labels, executor kind, whether webhooks are armed, last arming error, the last 20 handled webhook events. Pass arm: true to arm now (control thread in an orb only). Pass show_urls: true to show the webhook URLs to the human in a confirm dialog; the call blocks until they answer. URLs are never returned to the agent.',
		inputSchema: {
			type: 'object',
			properties: {
				arm: { type: 'boolean', description: 'Arm the control plane now if not armed' },
				show_urls: { type: 'boolean', description: 'Show the webhook URLs to the human in a dialog and wait for them to confirm' },
			},
		},
		async execute(input, ctx) {
			const labels = await ctx.thread.labels()
			if (input.arm === true) await arm(ctx, labels)
			const { urls, ...state } = armState.get(ctx.thread.id) ?? { armed: false, webhooks: [], urls: [], events: [] }
			const dialog = input.show_urls === true && urls.length > 0 ? await showUrls(ctx, urls) : undefined
			return JSON.stringify({ thread: ctx.thread.id, labels, executor: amp.system.executor.kind, ...state, dialog })
		},
	})

	async function arm(ctx: Pick<PluginEventContext<'agent.end'>, 'thread' | 'ui' | 'logger'>, labels: readonly string[]) {
		if (!labels.includes(controlLabel) || armState.has(ctx.thread.id)) return
		const state: ArmState = { armed: false, webhooks: [], urls: [], events: [] }
		armState.set(ctx.thread.id, state)
		try {
			await armWebhooks(ctx, state)
			state.armed = true
		} catch (error: unknown) {
			state.error = String(error)
			ctx.logger.log(marker, 'arming failed', state.error)
			await ctx.ui.notify(`${marker} control plane arming failed: ${state.error}`)
		}
	}

	async function armWebhooks(ctx: Pick<PluginEventContext<'agent.end'>, 'thread' | 'ui' | 'logger'>, state: ArmState) {
		if (amp.system.executor.kind !== 'remote') {
			throw new Error(`control plane needs an Amp-managed orb; executor is ${amp.system.executor.kind}`)
		}
		await amp.system.executor.keepAlive().catch((error: unknown) => ctx.logger.log(marker, 'keepAlive failed', String(error)))
		const seen = new Set<string>()
		const handle = (source: 'linear' | 'github' | 'slack') => async (event: WebhookEvent, hctx: WebhookHandlerContext) => {
			if (seen.has(event.id)) return
			seen.add(event.id)
			const identifier = issueFromEvent(source, new TextDecoder().decode(event.body))
			if (!identifier) return
			const issue = await snapshotFor(hctx, identifier)
			const action = nextAction(issue, await currentLoad(hctx))
			hctx.logger.log(marker, source, issue.identifier, issue.status, JSON.stringify(action))
			const performed = (await hctx.thread.labels()).includes(performLabel)
			state.events.push({ at: event.receivedAt, source, issue: issue.identifier, status: issue.status, action, performed })
			state.events.splice(0, Math.max(0, state.events.length - 20))
			if (!performed) {
				hctx.logger.log(marker, 'dry run; add label', performLabel, 'to act')
				return
			}
			await perform(hctx, issue, action)
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

	// The URLs are credentials, shown only in the control thread for Devon to paste into Linear,
	// GitHub and Slack. Never log or post them anywhere else.
	async function showUrls(ctx: Pick<PluginEventContext<'agent.end'>, 'ui'>, urls: readonly string[]) {
		const confirmed = await ctx.ui.confirm({ title: 'ODD webhook endpoints', message: urls.join('\n'), confirmButtonText: 'Configured', requireHuman: true })
		return confirmed ? 'configured' : 'dismissed'
	}

	// Phases 3-6 fill in `perform` stage by stage; today only spawn, steer and page are wired.
	async function perform(ctx: WebhookHandlerContext, issue: IssueSnapshot, action: Action) {
		switch (action.kind) {
			case 'spawn': {
				const agent = agents[action.role]
				if (!agent || action.executor !== 'orb') {
					// Subscription engines and runner jobs are launched by the runner backstop (§6).
					ctx.logger.log(marker, 'launch request for runner', issue.identifier, action.role)
					return
				}
				const thread = await agent.createThread({ executor: 'orb', parentThreadID: ctx.thread.id, visibility: 'workspace' })
				await thread.setLabels(threadLabels(issue.identifier, action.role, 1))
				await thread.appendUserMessage({
					type: 'user-message',
					content: `${marker} Outcome ${issue.identifier}. Role: ${action.role}. Reason: ${action.reason}. Load the \`${contracts[action.role].skill}\` skill and start.`,
				})
				return
			}
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

async function snapshotFor(ctx: WebhookHandlerContext, identifier: string): Promise<IssueSnapshot> {
	const [issue, comments, pr, threads] = await Promise.all([
		ctx.tools.call('linear.get_issue', { id: identifier }) as Promise<LinearIssue>,
		ctx.tools.call('linear.list_comments', { issueId: identifier, limit: 50 }).then(result => (result as { comments?: { body: string }[] }).comments ?? []),
		pullRequestFor(ctx, identifier),
		threadsFor(ctx.tools, `label:odd-issue-${identifier.toLowerCase()} archived:false`),
	])
	// Open blockers are not exposed by the Linear MCP; phase 4 (MET-279) adds them before builders spawn.
	return toSnapshot({ issue: { ...issue, comments }, pr, threads, openBlockers: [] })
}

async function pullRequestFor(ctx: WebhookHandlerContext, identifier: string): Promise<GitHubPullRequest | undefined> {
	const result = await ctx.$`gh pr list --search ${identifier} --state all --json number,headRefOid,state,mergeCommit,statusCheckRollup --limit 5`
	if (result.exitCode !== 0) {
		ctx.logger.log(marker, 'gh pr list failed', result.stderr.trim())
		return undefined
	}
	const prs = JSON.parse(result.stdout) as GitHubPullRequest[]
	// Prefer the open PR; otherwise the merged one, so a merged issue derives `Deploying`.
	return prs.find(pr => pr.state === 'OPEN') ?? prs.find(pr => pr.state === 'MERGED')
}

async function threadsFor(tools: Tools, query: string): Promise<LiveThread[]> {
	const found = (await tools.call('find_thread', { query, limit: 100 })) as { threads: { id: string }[] }
	return Promise.all(found.threads.map(async ({ id }) => {
		const status = (await tools.call('get_thread_status', { thread: id })) as { metadata: { labels: string[] }; agentState?: { state?: string } }
		return { id, labels: status.metadata.labels, state: status.agentState?.state ?? 'idle' }
	}))
}

async function currentLoad(ctx: WebhookHandlerContext): Promise<Load> {
	const threads = (await Promise.all(roleLabelQueries.map(query => threadsFor(ctx.tools, query)))).flat()
	const load = loadFrom(threads)
	ctx.logger.log(marker, 'load', JSON.stringify(load), 'of', JSON.stringify(capacity))
	return load
}

async function externalStop(ctx: { $: WebhookHandlerContext['$'] }, role: Role, issue: string): Promise<{ stopMet: boolean; missing: string[] }> {
	if (role !== 'builder') return { stopMet: true, missing: [] }
	const pr = await ctx.$`gh pr list --search ${issue} --state open --json number,headRefOid,statusCheckRollup --limit 1`
	if (pr.exitCode !== 0 || pr.stdout.trim() === '[]') return { stopMet: false, missing: [`no open PR for ${issue}`] }
	const [{ statusCheckRollup = [] }] = JSON.parse(pr.stdout) as Array<{ statusCheckRollup?: Array<{ name?: string; conclusion?: string; state?: string }> }>
	const failing = statusCheckRollup.filter(check => (check.conclusion ?? check.state ?? '').toUpperCase() in { FAILURE: 1, ERROR: 1, CANCELLED: 1 }).map(check => check.name ?? 'check')
	const pending = statusCheckRollup.some(check => !check.conclusion && (check.state ?? '').toUpperCase() !== 'SUCCESS')
	if (failing.length) return { stopMet: false, missing: failing.map(name => `CI job ${name} failed on the PR head`) }
	return pending ? { stopMet: false, missing: ['CI still running on the PR head'] } : { stopMet: true, missing: [] }
}
