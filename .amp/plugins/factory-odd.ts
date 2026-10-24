// @amp-agent-mode {"key":"odd-intake","label":"ODD Intake"}
// @amp-agent-mode {"key":"odd-spec","label":"ODD Spec"}
// @amp-agent-mode {"key":"odd-reviewer","label":"ODD Reviewer"}
// @amp-agent-mode {"key":"odd-verifier","label":"ODD Verifier"}
// @amp-agent-mode {"key":"odd-control","label":"ODD Control"}

import type { Agent, PluginAPI, ThreadID, WebhookEvent, WebhookHandlerContext } from '@ampcode/plugin'
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

export const description =
	'Factory ODD control plane: Linear, GitHub and Slack webhooks drive a deterministic outcome lifecycle; role agents run in orbs; Ralph loops are bounded by external checks. See docs/odd/README.md.'

// Phase 2 (MET-276): the plugin is armed only in the control thread. Everywhere else it
// registers the role modes and the Ralph guard and does nothing on its own.
const controlLabel = 'odd-control-plane'
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
		const { role, issue } = parseThreadLabels(await ctx.thread.labels())
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
	amp.on('session.start', async (_event, ctx) => {
		const labels = await ctx.thread.labels()
		if (!labels.includes(controlLabel)) return
		if (ctx.system.executor.kind !== 'remote') {
			await ctx.ui.notify(`${marker} control plane needs an Amp-managed orb; webhooks are unavailable here.`)
			return
		}
		await ctx.system.executor.keepAlive().catch((error: unknown) => ctx.logger.log(marker, 'keepAlive failed', String(error)))
		const seen = new Set<string>()
		const handle = (source: 'linear' | 'github' | 'slack') => async (event: WebhookEvent, hctx: WebhookHandlerContext) => {
			if (seen.has(event.id)) return
			seen.add(event.id)
			const issue = await snapshotFor(hctx, source, event.payload)
			if (!issue) return
			const action = nextAction(issue, await currentLoad(hctx))
			hctx.logger.log(marker, source, issue.identifier, issue.status, JSON.stringify(action))
			await perform(hctx, issue, action)
		}
		const urls = await Promise.all((['linear', 'github', 'slack'] as const).map(async key => {
			const { url } = await amp.createWebhook({ key, headers: ['x-hub-signature-256', 'linear-signature', 'x-slack-signature'], handler: handle(key) })
			return `${key}: ${url}`
		}))
		// The URLs are credentials. They are shown once, in the control thread, for Devon to paste
		// into Linear, GitHub and Slack. Never log or post them anywhere else.
		await ctx.ui.confirm({ title: 'ODD webhook endpoints', message: urls.join('\n'), confirmButtonText: 'Configured', requireHuman: true })
	})

	// Phase 2 stops here: derive and log. Phases 3-6 fill in `perform` stage by stage.
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

// --- Derivation helpers. Real implementations land with phase 2; shapes are fixed here. --------

async function snapshotFor(ctx: WebhookHandlerContext, source: string, payload: unknown): Promise<IssueSnapshot | undefined> {
	ctx.logger.log(marker, 'snapshot', source, typeof payload)
	return undefined
}

async function currentLoad(ctx: WebhookHandlerContext): Promise<Load> {
	// Derived from live thread labels odd-role-* in later phases; conservative until then.
	ctx.logger.log(marker, 'load assumed full', JSON.stringify(capacity))
	return { orbs: capacity.orbs, runnerSlots: capacity.runnerSlots }
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
