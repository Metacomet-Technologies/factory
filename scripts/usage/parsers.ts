export const STALE_MS = 45 * 60_000;
export const FORMAT_CHANGED = 'format changed';
export type Window = { name: string; used_percent: number; resets_at_ms: number | null; window_minutes: number | null };
// Decimal strings preserve source precision, including non-USD Codex credits.
export type Balance = { amount: string; unit: 'usd' | 'orb_hours' | 'codex_credits'; remaining: string; total: string | null; label?: string | null };
export type SpendItem = { label: string; amount: string };
// `breakdown` is Cursor-only (MET-231); other tools omit it and the API defaults it to [].
export type Reading = { plan: string | null; windows: Window[]; balance: Balance | null; balances: Balance[]; breakdown?: SpendItem[]; reset_credits_available: number | null };
export type Tool = Reading & { tool: string; status: 'ok' | 'unknown' | 'stale' | 'not_tracked'; reason: string | null; note: null; observed_at_ms: number | null; source: string | null; cli_version: string | null };
export const TOOL_ORDER = ['amp', 'cursor', 'claude-code', 'codex', 'kimi', 'opencode'] as const;
export const sources = {
  amp: 'amp-cli', cursor: 'cursor-about', 'claude-code': 'claude-usage', codex: 'codex-app-server',
  kimi: 'kimi-oauth-usage', opencode: 'opencode-stats',
} as const;
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
    if (new RegExp(`^(?:Individual credits:|\\*\\*Individual credits:\\*\\*) \\$${number} remaining(?: \\(set up auto-reload to avoid running out\\))? - https://ampcode.com/settings$`).test(line)) {
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
const cursorPlans: Record<string, string> = {
  free: 'free', pro: 'pro', 'pro plus': 'pro_plus', 'pro+': 'pro_plus', ultra: 'ultra',
  team: 'team', teams: 'team', business: 'business', enterprise: 'enterprise', edu: 'edu',
};
// Plan name only. `agent about` has no headless usage meters; email and request ids are dropped.
export function parseCursor(text: string): Reading {
  const data = JSON.parse(text);
  check(data && typeof data === 'object' && !Array.isArray(data));
  check(typeof data.cliVersion === 'string' && /^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$/.test(data.cliVersion));
  check(Object.hasOwn(data, 'userEmail') && Object.hasOwn(data, 'subscriptionTier'));
  const email = data.userEmail, tier = data.subscriptionTier;
  check(email === null || (typeof email === 'string' && email.length <= 320));
  check(tier === null || (typeof tier === 'string' && tier.length <= 64));
  if (email === null && tier === null) throw new Error('not logged in');
  if (typeof email === 'string' && email.length > 0 && tier === null) throw new Error('CLI failed');
  check(typeof email === 'string' && email.length > 0 && typeof tier === 'string');
  const plan = cursorPlans[tier.trim().toLowerCase().replace(/^cursor\s+/, '').replace(/\s+/g, ' ')];
  check(plan);
  return { ...emptyReading(), plan };
}
function ratioPercent(value: unknown): number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
  const used = Math.round(value * 1_000_000) / 10_000;
  check(used >= 0 && used <= 100);
  return used;
}
function quotaWindow(entry: unknown, name: string, minutes: number | null): Window | null {
  if (entry == null) return null;
  check(entry && typeof entry === 'object' && !Array.isArray(entry));
  const record = entry as Record<string, unknown>;
  check(Object.keys(record).every(key => key === 'usedRatio' || key === 'resetAt') && Object.hasOwn(record, 'usedRatio'));
  return { name, used_percent: ratioPercent(record.usedRatio), resets_at_ms: record.resetAt == null ? null : iso(record.resetAt), window_minutes: minutes };
}
function cents(value: unknown): number {
  check(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100_000_000_000);
  return value as number;
}
function centsToDecimal(value: number): string {
  const whole = Math.trunc(value / 100), frac = value % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`.replace(/0$/, '');
}
// Local loopback quota only. request_id, login text and non-USD wallets are not stored.
export function parseKimi(text: string): Reading {
  const message = JSON.parse(text);
  check(message && typeof message === 'object' && !Array.isArray(message));
  check(Object.keys(message).every(key => ['code', 'msg', 'data', 'request_id'].includes(key)));
  check(message.code === 0 && message.msg === 'success' && message.data && typeof message.data === 'object');
  if (message.request_id != null) check(typeof message.request_id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(message.request_id));
  const data = message.data as Record<string, unknown>;
  if (data.kind === 'error') {
    check(Object.keys(data).every(key => ['kind', 'message', 'status'].includes(key)));
    check(typeof data.message === 'string' && data.message.length > 0 && data.message.length <= 500);
    if (data.status != null) check(Number.isInteger(data.status) && (data.status as number) >= 100 && (data.status as number) <= 599);
    if (data.message === 'No token for "kimi-code". Run /login to authenticate.') throw new Error('not logged in');
    throw new Error('CLI failed');
  }
  check(data.kind === 'ok' && Object.keys(data).every(key => key === 'kind' || key === 'quota'));
  const quota = data.quota as Record<string, unknown>;
  check(quota && typeof quota === 'object' && !Array.isArray(quota));
  check(Object.keys(quota).every(key => key === 'usages' || key === 'extraUsage'));
  const usages = quota.usages as Record<string, unknown>;
  check(usages && typeof usages === 'object' && !Array.isArray(usages));
  check(Object.keys(usages).every(key => ['limit5h', 'limit7d', 'monthTotal', 'monthCode'].includes(key)));
  quotaWindow(usages.monthCode, 'monthly', null);
  const windows = [
    quotaWindow(usages.limit5h, 'five_hour', 300),
    quotaWindow(usages.limit7d, 'weekly', 10080),
    quotaWindow(usages.monthTotal, 'monthly', null),
  ].filter(window => window != null);
  check(windows.length > 0);
  let wallet: Balance | null = null;
  if (quota.extraUsage != null) {
    const extra = quota.extraUsage as Record<string, unknown>;
    check(extra && typeof extra === 'object' && !Array.isArray(extra));
    const currency = extra.currency;
    check(currency == null || (typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)));
    if (extra.balanceCents != null || extra.totalCents != null) check(currency != null);
    if (currency === 'USD') {
      const amount = centsToDecimal(cents(extra.balanceCents));
      const total = extra.totalCents == null ? null : centsToDecimal(cents(extra.totalCents));
      check(total === null || Number(amount) <= Number(total));
      wallet = { amount, unit: 'usd', remaining: amount, total };
    }
  }
  return { plan: null, windows, balance: wallet, balances: wallet ? [wallet] : [], reset_credits_available: null };
}
const OPENCODE_TOP = '┌────────────────────────────────────────────────────────┐';
const OPENCODE_SEP = '├────────────────────────────────────────────────────────┤';
const OPENCODE_BOT = '└────────────────────────────────────────────────────────┘';
// Local session cost from `opencode stats`, not provider quota. Token counts are checked and dropped.
export function parseOpencode(text: string): Reading {
  check(typeof text === 'string' && text.length > 0 && text.length <= 100_000 && !/[\u0000-\u0009\u000b-\u001f]/.test(text));
  const lines = text.split('\n');
  while (lines.at(-1) === '') lines.pop();
  let index = 0;
  if (/^Large dataset detected \([1-9]\d{0,6} sessions\)\. This may take a while\.\.\.$/.test(lines[0] ?? '')) index += 1;
  const next = (expected?: string) => { const line = lines[index++]; check(expected === undefined || line === expected); return line; };
  const title = (name: string) => { const line = next(); check(line?.startsWith('│') && line.endsWith('│') && line.slice(1, -1).trim() === name); };
  const row = (label: string, pattern: RegExp) => {
    const line = next();
    check(line?.startsWith('│') && line.endsWith('│'));
    const match = line.slice(1, -1).replace(/ $/, '').match(/^(.+?) {2,}(\S+)$/);
    check(match?.[1] === label && pattern.test(match[2]));
    return match[2];
  };
  const open = (name: string) => { next(OPENCODE_TOP); title(name); next(OPENCODE_SEP); };
  const count = /^(?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)$/;
  const money = /^\$(0|[1-9]\d*)\.\d{2}$/;
  const tokens = /^(?:0|[1-9]\d{0,2}|(?:0|[1-9]\d*)\.\d[KM])$/;
  open('OVERVIEW');
  row('Sessions', count); row('Messages', count); row('Days', /^(?:0|[1-9]\d*)$/);
  next(OPENCODE_BOT); next('');
  open('COST & TOKENS');
  const total = row('Total Cost', money);
  row('Avg Cost/Day', money); row('Avg Tokens/Session', tokens); row('Median Tokens/Session', tokens);
  row('Input', tokens); row('Output', tokens); row('Cache Read', tokens); row('Cache Write', tokens);
  next(OPENCODE_BOT);
  if (lines[index] === '') {
    const saved = index;
    index += 1;
    if (lines[index] === OPENCODE_TOP) {
      index += 1; title('TOOL USAGE'); next(OPENCODE_SEP);
      let rows = 0;
      while (lines[index] !== OPENCODE_BOT) {
        const line = lines[index++];
        check(line?.startsWith('│') && line.endsWith('│') && line.includes('%') && line.length <= 120);
        rows += 1; check(rows <= 100);
      }
      check(rows > 0); next(OPENCODE_BOT);
    } else index = saved;
  }
  while (index < lines.length) check(lines[index++] === '');
  return opencodeSession(decimal(total.slice(1)));
}
const OPENCODE_V2_COUNT = /^(?:0|[1-9]\d{0,2}|(?:0|[1-9]\d*)(?:\.\d)?[kmb])$/;
const OPENCODE_V2_PERCENT = /^(?:[0-9]\.\d{2}|[1-9]\d{1,2}\.\d)%$/;
function opencodeSession(amount: string): Reading {
  const session: Balance = { amount, unit: 'usd', remaining: amount, total: null, label: 'session cost' };
  return { ...emptyReading(), balance: session, balances: [session] };
}
// OpenCode 2 `stats --all --cost`. The share card has no cost, so it is rejected.
// Token rows are shape checks only. Model and tool sections are not accepted.
export function parseOpencodeV2(text: string): Reading {
  check(typeof text === 'string' && text.length > 0 && text.length <= 4_000 && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text));
  const lines = text.split('\n');
  while (lines.at(-1) === '') lines.pop();
  const row = (index: number, label: string, pattern: RegExp) => {
    const prefix = `  ${label.padEnd(20)}`;
    const line = lines[index];
    check(line?.startsWith(prefix));
    const value = line.slice(prefix.length);
    check(pattern.test(value));
    return value;
  };
  check(lines.length === 10 && lines[0] === 'all time · all projects' && lines[1] === '' && lines[2] === 'COST & TOKENS');
  const total = row(3, 'cost', /^\$(0|[1-9]\d*)\.\d{2}$/);
  row(4, 'input', OPENCODE_V2_COUNT);
  row(5, 'output', OPENCODE_V2_COUNT);
  row(6, 'reasoning', OPENCODE_V2_COUNT);
  row(7, 'cache read', OPENCODE_V2_COUNT);
  row(8, 'cache write', OPENCODE_V2_COUNT);
  row(9, 'cached input', OPENCODE_V2_PERCENT);
  return opencodeSession(decimal(total.slice(1)));
}
export function age(tool: Tool, now: number): Tool {
  return tool.observed_at_ms !== null && now - tool.observed_at_ms > STALE_MS
    ? { ...tool, status: 'stale', reason: tool.reason ?? 'last good reading older than 45 minutes' } : tool;
}
