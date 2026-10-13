export const STALE_MS = 45 * 60_000;
export const FORMAT_CHANGED = 'format changed';
export type Window = { name: string; used_percent: number; resets_at_ms: number | null; window_minutes: number | null };
// Decimal strings preserve source precision, including non-USD Codex credits.
export type Balance = { amount: string; unit: 'usd' | 'orb_hours' | 'codex_credits'; remaining: string; total: string | null; label?: string | null };
export type Reading = { plan: string | null; windows: Window[]; balance: Balance | null; balances: Balance[]; reset_credits_available: number | null };
export type Tool = Reading & { tool: string; status: 'ok' | 'unknown' | 'stale' | 'not_tracked'; reason: string | null; note: null; observed_at_ms: number | null; source: string | null; cli_version: string | null };
export const sources = { amp: 'amp-cli', 'claude-code': 'claude-usage', codex: 'codex-app-server' } as const;
export const emptyReading = (): Reading => ({ plan: null, windows: [], balance: null, balances: [], reset_credits_available: null });
export function check(value: unknown): asserts value { if (!value) throw new Error(FORMAT_CHANGED); }
function percent(value: unknown): number { check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100); return value; }
function integer(value: unknown): number { check(Number.isSafeInteger(value) && (value as number) >= 0); return value as number; }
function decimal(value: unknown): string {
  check(typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.length <= 32);
  return value;
}
function iso(value: unknown): number | null {
  if (value === null) return null;
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value));
  const result = Date.parse(value); check(Number.isSafeInteger(result) && result > 0);
  check(new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10));
  return result;
}
const number = '(?:0|[1-9]\\d{0,2}(?:,\\d{3})*|[1-9]\\d*)(?:\\.\\d+)?';
const summary = new RegExp(`^Amp (Gigawatt) Tier: agent usage \\$(${number}) of \\$(${number}) remaining \\((\\d{1,3})%\\), orb usage (${number})h of (${number})h (?:a1\\.xxlarge )?orb hours remaining \\((\\d{1,3})%\\) - period (\\d{4}-\\d{2}-\\d{2}) to (\\d{4}-\\d{2}-\\d{2}), resets (?:upon renewal )?in (\\d+) days$`);
function balance(amount: string, unit: Balance['unit'], total: string | null): Balance {
  amount = decimal(amount.replaceAll(',', ''));
  total = total === null ? null : decimal(total.replaceAll(',', ''));
  check(total === null || Number(amount) <= Number(total));
  return { amount, unit, remaining: amount, total };
}
export function parseAmp(text: string): Reading {
  const lines = text.trimEnd().split('\n');
  // Recognize the identity line only to discard it; never return its contents.
  if (/^Signed in as [^\r\n]+ \([^\r\n]+\)$/.test(lines[0])) lines.shift();
  if (lines.at(-1) === '# Run `amp usage --details` for more detailed information.') {
    lines.pop(); check(lines.pop() === '');
  }
  const match = lines.shift()?.replace(/^\*\*Amp Gigawatt Tier:\*\*/, 'Amp Gigawatt Tier:').match(summary); check(match);
  const [, plan, remaining, total, remainingPercent, hours, hoursTotal, hoursPercent, start, end] = match;
  const resets = iso(`${end}T00:00:00Z`);
  check(iso(`${start}T00:00:00Z`)! < resets!);
  const balances = [balance(remaining, 'usd', total), balance(hours, 'orb_hours', hoursTotal)];
  let individual = false;
  const workspaces = new Set<string>();
  for (const line of lines) {
    if (new RegExp(`^(?:Individual credits:|\\*\\*Individual credits:\\*\\*) \\$${number} remaining - https://ampcode.com/settings$`).test(line)) {
      check(!individual); individual = true;
      continue;
    }
    const workspace = line.match(new RegExp(`^(?:Workspace ([a-z0-9][a-z0-9-]{0,62}):|\\*\\*Workspace ([a-z0-9][a-z0-9-]{0,62}):\\*\\*) \\$(${number}) remaining - https://ampcode.com/workspaces/([a-z0-9][a-z0-9-]{0,62})$`));
    check(workspace);
    const name = workspace[1] ?? workspace[2];
    check(name === workspace[4] && !workspaces.has(name) && balances.length < 8); workspaces.add(name);
    balances.push({ ...balance(workspace[3], 'usd', null), label: `workspace ${name}` });
  }
  return { ...emptyReading(), plan, balances, balance: balances[0], windows: [
    { name: 'agent', used_percent: 100 - percent(Number(remainingPercent)), resets_at_ms: resets, window_minutes: null },
    { name: 'orb', used_percent: 100 - percent(Number(hoursPercent)), resets_at_ms: resets, window_minutes: null },
  ] };
}
// Only the summary and the two quota pool tables are consumed. Other report
// sections contain identities/tokens and are deliberately never persisted.
export function parseAmpDetails(text: string): void {
  const lines = text.split('\n');
  check(lines[0] === '# Usage' && lines[1] === '');
  const summaryEnd = lines.findIndex((line, i) => i >= 2 && line === '');
  check(summaryEnd > 2);
  parseAmp(lines.slice(2, summaryEnd).join('\n'));
  for (const [heading, header, unit] of [
    ['## Amp Tier: Agent Usage Pool', '| Source | Recorded cost |', '\\$'],
    ['## Amp Tier: Orb Usage Pool', '| Source | a1.xxlarge orb hours |', ''],
  ]) {
    check(lines.filter(line => line === heading).length === 1);
    const from = lines.indexOf(heading) + 1;
    const next = lines.findIndex((line, i) => i >= from && line.startsWith('## '));
    const rows = lines.slice(from, next < 0 ? undefined : next).filter(line => line.startsWith('|'));
    const suffix = unit ? '' : 'h';
    check(rows.length >= 4 && rows[0] === header && rows[1] === '| --- | ---: |');
    check(new RegExp(`^\\| \\*\\*All sources\\*\\* \\| \\*\\*${unit}${number}${suffix}\\*\\* \\|$`).test(rows[2]));
    check(rows.slice(3).every(row => new RegExp(`^\\| [^|\\r\\n]+ \\| ${unit}${number}${suffix} \\|$`).test(row)));
  }
}
export function parseClaude(text: string): Reading {
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  const reports = events.filter(e => e.type === 'assistant' && e.usage_report != null);
  const results = events.filter(e => e.type === 'result');
  check(reports.length === 1 && results.length === 1);
  const result = results[0];
  check(result.is_error === false && result.num_turns === 0 && result.total_cost_usd === 0);
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) check(result.usage?.[key] === 0);
  const limits = reports[0].usage_report.rate_limits?.limits;
  check(Array.isArray(limits) && limits.length > 0 && limits.length <= 20);
  const windows: Window[] = limits.map(limit => {
    check(['session', 'weekly_all', 'weekly_scoped'].includes(limit.kind));
    check(limit.group === (limit.kind === 'session' ? 'session' : 'weekly'));
    // Scope labels are a small allowlist, never free text from CLI output.
    const scoped = limit.kind === 'weekly_scoped';
    check(scoped ? ['Fable', 'Opus', 'Sonnet'].includes(limit.scope?.model?.display_name) && limit.scope.surface === null : limit.scope === null);
    return { name: scoped ? `weekly_${limit.scope.model.display_name.toLowerCase()}` : limit.kind === 'session' ? 'five_hour' : 'weekly',
      used_percent: percent(limit.percent), resets_at_ms: iso(limit.resets_at), window_minutes: limit.kind === 'session' ? 300 : 10080 };
  });
  check(new Set(windows.map(w => w.name)).size === windows.length);
  // The usage report does not identify Max versus Pro. Do not infer a plan.
  return { ...emptyReading(), windows };
}
export function parseCodex(message: any): Reading {
  check(message?.id === 2 && !message.error && message.result?.rateLimits);
  const rate = message.result.rateLimits;
  check(rate.limitId === 'codex' && ['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu'].includes(rate.planType));
  const windows: Window[] = [];
  for (const [name, value] of [['primary', rate.primary], ['secondary', rate.secondary]] as const) {
    if (value === null) continue;
    check(value && value.windowDurationMins > 0);
    const minutes = integer(value.windowDurationMins);
    const reset = integer(value.resetsAt) * 1000; check(Number.isSafeInteger(reset));
    windows.push({ name: minutes === 10080 ? 'weekly' : minutes === 300 ? 'five_hour' : name, used_percent: percent(value.usedPercent), resets_at_ms: reset, window_minutes: minutes });
  }
  check(windows.length > 0);
  let credits: Balance | null = null;
  if (rate.credits !== null) {
    check(typeof rate.credits?.hasCredits === 'boolean' && typeof rate.credits.unlimited === 'boolean');
    if (rate.credits.balance !== null) credits = balance(decimal(rate.credits.balance), 'codex_credits', null);
  }
  const resets = message.result.rateLimitResetCredits;
  return { plan: rate.planType, windows, balance: credits, balances: credits ? [credits] : [], reset_credits_available: resets == null ? null : integer(resets.availableCount) };
}
export function age(tool: Tool, now: number): Tool {
  return tool.observed_at_ms !== null && now - tool.observed_at_ms > STALE_MS
    ? { ...tool, status: 'stale', reason: tool.reason ?? 'last good reading older than 45 minutes' } : tool;
}
