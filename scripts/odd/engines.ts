// Engine selection: the one source of truth for which model and subscription runs each role.
// The dispatcher's engine table (`engine/*` × `agent-effort/*`, CLI modes) and the ODD control
// plane's pins (plugin agent models, the Claude Code builder launch, cross-lab review) both
// live here, so a billing route is chosen in one place. Pure functions; callers do the IO.

// --- Dispatcher engine table (CLI subscription modes, `amp -x --mode <key>`) ---------------------

export const CLAUDE_MODEL = 'claude-opus-5-5';
export const modes = {
  amp: { low: 'low', medium: 'medium', high: 'high' },
  claude: { low: 'external-agent:claude-code', medium: 'external-agent:claude-code', high: 'external-agent:claude-code' },
  chatgpt: { low: 'gpt56l', medium: 'gpt61s', high: 'gpt61s' },
  ultra: { low: 'ultra', medium: 'ultra', high: 'ultra' },
  // Devon's User Plugins (subscription-backed, no Claude models). Checked with
  // `amp plugins list` before launch; never substituted when missing.
  grok: { low: 'grok-low', medium: 'grok-medium', high: 'grok-high', ultra: 'grok-ultra' },
  go: { low: 'go-low', medium: 'go-medium', high: 'go-high', ultra: 'go-ultra' },
  docs: { low: 'docs', medium: 'docs', high: 'docs' },
};
export const families = { amp: 'Amp', claude: 'Claude Code subscription', chatgpt: 'ChatGPT through Amp', ultra: 'Amp credits',
  grok: 'Grok subscription', go: 'OpenCode Go subscription', docs: 'OpenCode Go subscription' };
export const pluginEngines = ['grok', 'go', 'docs'];
// Report-only advisor tools each plugin mode registers; low and docs have none.
export const advisors = { grok: { medium: 'grok_advisor_high', high: 'grok_advisor_high', ultra: 'grok_advisor_xhigh' },
  go: { medium: 'go_advisor_high', high: 'go_advisor_high', ultra: 'go_advisor_max' } };
const effortIgnored = (engine: string) => engine === 'ultra' || engine === 'docs';
export function assignment(engine: string, effort: string, advisor: boolean) {
  const tool = advisors[engine]?.[effort];
  const advice = !tool ? 'none for this mode' : advisor
    ? `warranted for the unresolved question named in Context; ${tool} is optional, report-only and bounded to two consultations, never a review or a second builder`
    : `not warranted; do not call ${tool}`;
  return `Mode: ${modes[engine][effort]} (${families[engine]}, ${effortIgnored(engine) ? 'agent-effort ignored' : `effort ${effort}`}). Advisor: ${advice}.`;
}
export function engineArgs(engine: string, effort: string) {
  return ['--mode', modes[engine][effort],
    ...(engine === 'claude' ? ['--features', `model:${CLAUDE_MODEL},effort:${effort}`] : [])];
}

// --- ODD pins (docs/odd/README.md §6) ------------------------------------------------------------

export type Lab = 'anthropic' | 'openai' | 'xai';
const labs: readonly Lab[] = ['anthropic', 'openai', 'xai'];
export type Effort = 'low' | 'medium' | 'high';
/** The model provider connection that must serve an engine: `type` from `amp config model-providers list --json`, plus its name when one account has several. */
export type Subscription = { type: string; name?: string; label: string };
export type Engine = { lab: Lab; model: `${Lab}/${string}`; effort: Effort; subscription: Subscription };

const claudeSubscription: Subscription = { type: 'model_provider_claude_sub', label: 'Claude Subscription' };
const chatgpt: Subscription = { type: 'model_provider_chatgpt', label: 'ChatGPT' };
const superGrok: Subscription = { type: 'model_provider_xai_grok', name: 'Cursor', label: 'SuperGrok connection Cursor' };

/**
 * The Builder is Claude Code on an orb, launched through the CLI with `engineArgs('claude', effort)`;
 * Amp-native Anthropic models bill Amp credits, so no plugin agent ever builds.
 */
export const builderEngine: Engine = { lab: 'anthropic', model: `anthropic/${CLAUDE_MODEL}`, effort: 'high', subscription: claudeSubscription };

/** Reviewer candidates, in tie-break order. `selectReviewer` never picks the Builder's lab. */
export const reviewerEngines: readonly Engine[] = [
  { lab: 'openai', model: 'openai/gpt-6-astra', effort: 'high', subscription: chatgpt },
  { lab: 'xai', model: 'xai/grok-4.7', effort: 'high', subscription: superGrok },
];

const astra = (effort: Effort): Engine => ({ lab: 'openai', model: 'openai/gpt-6-astra', effort, subscription: chatgpt });

/**
 * Explicit model of every other plugin agent. `builder` is the manual `odd-builder` mode only; the
 * control plane launches Claude Code instead (`builderEngine`).
 */
export const pluginPins = Object.freeze({
  intake: astra('low'),
  spec: astra('medium'),
  builder: astra('high'),
  verifier: astra('low'),
  deployer: astra('low'),
  control: astra('low'),
});

/** The thread label that records which lab serves a role thread. */
export const engineLabel = (lab: Lab) => `odd-engine-${lab}`;

export function labOf(labels: readonly string[]): Lab | undefined {
  const lab = labels.find(label => label.startsWith('odd-engine-'))?.slice('odd-engine-'.length);
  return labs.includes(lab as Lab) ? lab as Lab : undefined;
}

/** Live role threads per lab: the load each subscription carries right now. */
export function engineUsage(threads: readonly { labels: readonly string[] }[]): Partial<Record<Lab, number>> {
  const usage: Partial<Record<Lab, number>> = {};
  for (const thread of threads) {
    const lab = labOf(thread.labels);
    if (lab) usage[lab] = (usage[lab] ?? 0) + 1;
  }
  return usage;
}

/**
 * The least-used reviewer engine outside the Builder's lab (ties keep table order). The Builder's
 * lab is the one its thread is labelled with, else `builderEngine`'s, so a changed default never
 * lets one lab approve its own change. Undefined when no engine is left.
 */
export function selectReviewer(builderLab: Lab | undefined, usage: Partial<Record<Lab, number>>, engines: readonly Engine[] = reviewerEngines): Engine | undefined {
  const refused = builderLab ?? builderEngine.lab;
  return engines.filter(engine => engine.lab !== refused).sort((a, b) => (usage[a.lab] ?? 0) - (usage[b.lab] ?? 0))[0];
}

/** The engine a role thread must have been served by, from its role and `odd-engine-<lab>` label. */
export function expectedEngine(role: string, lab: Lab | undefined): Engine | undefined {
  if (!lab) return undefined;
  if (role === 'builder') return builderEngine.lab === lab ? builderEngine : pluginPins.builder.lab === lab ? pluginPins.builder : undefined;
  if (role === 'reviewer') return reviewerEngines.find(engine => engine.lab === lab);
  const pin = pluginPins[role as keyof typeof pluginPins];
  return pin?.lab === lab ? pin : undefined;
}

// --- Routing evidence ------------------------------------------------------------------------------

/** Non-secret fields of `amp config model-providers list --json`. */
export type Connection = { id: string; type: string; name: string };
/** One row of the Model Routing table in `amp threads usage <id> --details`. `connection` is undefined for `Via Amp`. */
export type Route = { model: string; purpose: string; via: string; connection?: Connection; requests: number };

const routeRow = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*Via\s+(.+?)\s*\|\s*([\d,]+)\s*\|/;

export function parseRouting(usage: string, connections: readonly Connection[]): Route[] {
  const routes: Route[] = [];
  const start = usage.indexOf('## Model Routing');
  if (start < 0) return routes;
  for (const line of usage.slice(start).split('\n').slice(1)) {
    if (line.startsWith('## ')) break;
    const match = routeRow.exec(line);
    if (!match) continue;
    const link = /^\[([^\]]+)\]\([^)]*#([0-9a-f-]{36})\)$/.exec(match[3]);
    routes.push({
      model: match[1],
      purpose: match[2],
      via: link ? link[1] : match[3],
      connection: link ? connections.find(connection => connection.id === link[2]) : undefined,
      requests: Number(match[4].replaceAll(',', '')),
    });
  }
  return routes;
}

/** `external-agent:claude-code/claude-opus-5-5` is Anthropic, `openai/gpt-6-astra` OpenAI. */
const routeLab = (model: string): string => model.startsWith('external-agent:claude-code/') ? 'anthropic' : model.split('/')[0];

const serves = (subscription: Subscription, connection: { type?: string | null; name?: string | null } | undefined) =>
  connection?.type === subscription.type && (subscription.name === undefined || connection.name === subscription.name);

export type Routing = { result: 'match' | 'mismatch' | 'missing'; problems: string[] };

/**
 * A role thread matches when every inference it made (Thread Title rows are Amp's own) came from its
 * lab through its engine's subscription. No such row is missing evidence, never a pass.
 */
export function checkRouting(engine: Engine, routes: readonly Route[]): Routing {
  const work = routes.filter(route => route.purpose !== 'Thread Title');
  if (!work.length) return { result: 'missing', problems: ['no model routing rows'] };
  const problems = work.filter(route => routeLab(route.model) !== engine.lab || !serves(engine.subscription, route.connection))
    .map(route => `${route.model} (${route.purpose}) via ${route.via}, expected ${engine.lab} via ${engine.subscription.label}`);
  return { result: problems.length ? 'mismatch' : 'match', problems };
}

/** `amp config model-providers check-access --provider-model <model>` output, reduced to the route. */
export function checkAccess(engine: Engine, output: unknown): Routing {
  const report = output as { ok?: boolean; modelRouting?: { kind?: string; modelProviderName?: string | null; connectionType?: string | null } } | null;
  const routing = report?.modelRouting;
  if (!report?.ok || !routing) return { result: 'missing', problems: [`${engine.model}: check-access reported no route`] };
  const connection = routing.kind === 'model-provider' ? { type: routing.connectionType, name: routing.modelProviderName } : undefined;
  return serves(engine.subscription, connection)
    ? { result: 'match', problems: [] }
    : { result: 'mismatch', problems: [`${engine.model} via ${routing.modelProviderName ?? routing.kind ?? 'unknown'}, expected ${engine.subscription.label}`] };
}

/** The sanitized record the control plane posts on the issue: models, purposes and connection names only. */
export function routingRecord(threadID: string, role: string, engine: Engine, routes: readonly Route[], routing: Routing): string {
  return [
    `odd-routing thread=${threadID} role=${role} engine=${engine.lab} model=${engine.model} result=${routing.result}`,
    ...routes.map(route => `- ${route.model} ${route.purpose}: ${route.requests} via ${route.via}${route.connection ? ` (${route.connection.type})` : ''}`),
    ...routing.problems.map(problem => `- problem: ${problem}`),
  ].join('\n');
}
