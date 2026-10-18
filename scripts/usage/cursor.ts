import { lstat, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { check, FORMAT_CHANGED } from './parsers.ts';
import type { Reading } from './parsers.ts';

// Cursor Teams Admin API (MET-221). The key is read only here, sent only as
// Basic auth, and never logged or persisted. Emails, names and IDs in responses
// are validated where needed and dropped; only aggregate totals are kept.
export const ADMIN_KEY_FILE = '/etc/factory-usage/cursor-admin-key';
export const ADMIN_BASE = 'https://api.cursor.com';
export const ADMIN_REJECTED = 'admin key rejected';
export const ADMIN_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;
const EVENTS_RANGE_MS = 30 * DAY_MS;
const SPEND_PAGE_SIZE = 100, EVENTS_PAGE_SIZE = 1000, MAX_PAGES = 100;
// Microcents keep Cursor's fractional cents exact enough without float money storage.
const MICRO = 1_000_000;

export type Response = { status: number; body: string };
export type AdminDeps = {
  readKey: () => Promise<string | null>;
  post: (path: string, body: object, key: string, timeoutMs: number) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
};
export type UsageRow = { model: string; headless: boolean; events: number; charged: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
export type CursorData = {
  fetched_at_ms: number; cycle_start_ms: number; next_cycle_ms: number;
  spend: string; limit: string | null; max_user_spend: string | null; limited_users_count: number | null;
  breakdown: { label: string; amount: string }[]; usage: UsageRow[];
};
export type CursorState = { attempted_at_ms: number; reason: string | null; data: CursorData | null };

function fail(message = FORMAT_CHANGED): never { throw new Error(message); }
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function count(value: unknown, max = 1e12): number {
  check(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max);
  return value as number;
}
function micro(cents: unknown): number {
  check(typeof cents === 'number' && Number.isFinite(cents) && cents >= 0 && cents <= 1e9);
  return Math.round(cents * MICRO);
}
function add(a: number, b: number): number { const sum = a + b; check(Number.isSafeInteger(sum)); return sum; }
// Microcents to a USD decimal string: 1 USD = 100 cents = 1e8 microcents.
export function usd(value: number): string {
  check(Number.isSafeInteger(value) && value >= 0);
  const whole = Math.floor(value / 1e8), frac = String(value % 1e8).padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
// Next cycle start: same UTC day-of-month next month, clamped to the month end.
export function nextCycle(start: number): number {
  const d = new Date(start);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}
const LABEL = /^[a-z0-9._ -]{1,64}$/;
function modelLabel(model: string): string {
  const label = model.toLowerCase().replace(/[^a-z0-9._ -]+/g, '-').slice(0, 64);
  return label === 'headless' || label === 'interactive' || label === 'other models' ? `model ${label}`.slice(0, 64) : label;
}

export function defaultAdmin(env = process.env): AdminDeps {
  const keyFile = env.FACTORY_CURSOR_ADMIN_KEY_FILE || ADMIN_KEY_FILE;
  const base = env.FACTORY_CURSOR_API_BASE || ADMIN_BASE;
  // Only the real API or a loopback fake (sandbox checks) may receive the key.
  if (base !== ADMIN_BASE && !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base)) fail('CLI failed');
  return {
    readKey: () => readAdminKey(keyFile),
    post: (path, body, key, timeoutMs) => post(base, path, body, key, timeoutMs),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}
// Missing key: null (plan-only). Anything unsafe or unreadable fails closed.
export async function readAdminKey(path: string): Promise<string | null> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    fail('CLI failed');
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o007) !== 0 || info.size === 0 || info.size > 1024) fail('CLI failed');
  let key: string;
  try { key = (await readFile(path, 'utf8')).trim(); } catch { fail('CLI failed'); }
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) fail('CLI failed');
  return key;
}
function post(base: string, path: string, body: object, key: string, timeoutMs: number): Promise<Response> {
  const url = new URL(path, base);
  const payload = JSON.stringify(body);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: 'POST', timeout: timeoutMs,
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
        'Content-Type': 'application/json', Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload), Connection: 'close',
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (Buffer.byteLength(text) > 8_000_000) { req.destroy(); reject(new Error('CLI output too large')); }
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      res.on('error', () => reject(new Error('CLI failed')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', () => reject(new Error('CLI failed')));
    req.end(payload);
  });
}

// Fetch every spend page and every event page since the cycle start. Requests
// are sequential and paced under Cursor's 20/min (spend) and 60/min (events).
export async function fetchCursor(deps: AdminDeps, key: string, now: number, budgetMs = 120_000): Promise<CursorData> {
  const deadline = Date.now() + budgetMs;
  const last: Record<string, number> = {};
  const call = async (path: string, body: object, gapMs: number) => {
    if (last[path] !== undefined) await deps.sleep(Math.max(0, last[path] + gapMs - Date.now()));
    const left = deadline - Date.now();
    if (left <= 0) fail('timeout');
    last[path] = Date.now();
    const res = await deps.post(path, body, key, Math.min(20_000, left));
    if (res.status === 401 || res.status === 403) fail(ADMIN_REJECTED);
    if (res.status !== 200) fail('CLI failed');
    try { return object(JSON.parse(res.body)); } catch { fail(); }
  };

  let cycleStart: number | undefined, pages = 1, members = 0, totalMembers = 0;
  let spend = 0, limit: number | null = 0, maxUser: number | null = null, limited: number | null = null;
  for (let page = 1; page <= pages; page++) {
    const data = await call('/teams/spend', { page, pageSize: SPEND_PAGE_SIZE }, 3_100);
    const start = count(data.subscriptionCycleStart, now);
    check(start > 0 && (cycleStart === undefined || cycleStart === start));
    cycleStart = start;
    if (page === 1) {
      pages = count(data.totalPages, MAX_PAGES); totalMembers = count(data.totalMembers, 100_000);
      check(pages >= 1 || totalMembers === 0);
    } else check(data.totalPages === pages && data.totalMembers === totalMembers);
    if (data.maxUserSpendCents != null) maxUser = micro(data.maxUserSpendCents);
    if (data.limitedUsersCount != null) limited = count(data.limitedUsersCount, 100_000);
    check(Array.isArray(data.teamMemberSpend) && data.teamMemberSpend.length <= SPEND_PAGE_SIZE);
    for (const raw of data.teamMemberSpend) {
      const member = object(raw);
      spend = add(spend, micro(member.spendCents));
      // A team limit exists only when every member has an enforced per-user limit.
      const cap = member.effectivePerUserLimitDollars;
      if (cap != null) check(typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 && cap <= 1e7);
      limit = limit !== null && typeof cap === 'number' && cap > 0 ? add(limit, Math.round(cap * 100 * MICRO)) : null;
      members += 1;
    }
  }
  check(cycleStart !== undefined && members === totalMembers);
  if (members === 0) limit = null;

  const rows = new Map<string, UsageRow & { micro: number }>();
  for (let from = cycleStart; from <= now; from += EVENTS_RANGE_MS) {
    const to = Math.min(from + EVENTS_RANGE_MS - 1, now);
    for (let page = 1, more = true; more; page++) {
      check(page <= MAX_PAGES);
      const data = await call('/teams/filtered-usage-events', { startDate: from, endDate: to, page, pageSize: EVENTS_PAGE_SIZE }, 1_050);
      const pagination = object(data.pagination);
      check(typeof pagination.hasNextPage === 'boolean' && (pagination.currentPage === undefined || pagination.currentPage === page));
      more = pagination.hasNextPage as boolean;
      check(Array.isArray(data.usageEvents) && data.usageEvents.length <= EVENTS_PAGE_SIZE);
      check(!more || data.usageEvents.length > 0);
      for (const raw of data.usageEvents) {
        const event = object(raw);
        check(typeof event.model === 'string' && event.model.length > 0 && event.model.length <= 128);
        check(typeof event.isHeadless === 'boolean');
        const tokens = event.tokenUsage == null ? {} : object(event.tokenUsage);
        const id = `${event.isHeadless}\0${event.model}`;
        const row = rows.get(id) ?? { model: modelLabel(event.model), headless: event.isHeadless, events: 0, charged: '0', micro: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
        row.micro = add(row.micro, micro(event.chargedCents ?? 0));
        row.events = add(row.events, 1);
        row.input_tokens = add(row.input_tokens, count(tokens.inputTokens ?? 0));
        row.output_tokens = add(row.output_tokens, count(tokens.outputTokens ?? 0));
        row.cache_read_tokens = add(row.cache_read_tokens, count(tokens.cacheReadTokens ?? 0));
        row.cache_write_tokens = add(row.cache_write_tokens, count(tokens.cacheWriteTokens ?? 0));
        rows.set(id, row);
        check(rows.size <= 200);
      }
    }
  }

  const all = [...rows.values()];
  const sum = (filter: (r: UsageRow) => boolean) => all.filter(filter).reduce((total, r) => add(total, r.micro), 0);
  const byModel = new Map<string, number>();
  for (const r of all) byModel.set(r.model, add(byModel.get(r.model) ?? 0, r.micro));
  const models = [...byModel].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  // At most 20 items: headless, interactive, then models by spend; the tail folds into one item.
  const shown = models.length > 18 ? [...models.slice(0, 17), ['other models', models.slice(17).reduce((t, m) => add(t, m[1]), 0)] as [string, number]] : models;
  const breakdown = [
    { label: 'headless', amount: usd(sum(r => r.headless)) },
    { label: 'interactive', amount: usd(sum(r => !r.headless)) },
    ...shown.map(([label, value]) => ({ label, amount: usd(value) })),
  ];
  const usage = all.map(({ micro: value, ...row }) => ({ ...row, charged: usd(value) }))
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : Number(a.headless) - Number(b.headless)));
  return validData({
    fetched_at_ms: now, cycle_start_ms: cycleStart, next_cycle_ms: nextCycle(cycleStart),
    spend: usd(spend), limit: limit === null ? null : usd(limit),
    max_user_spend: maxUser === null ? null : usd(maxUser), limited_users_count: limited,
    breakdown, usage,
  }, now);
}

const DECIMAL = /^(?:0|[1-9]\d{0,20})(?:\.\d{1,8})?$/;
function amount(value: unknown): string { check(typeof value === 'string' && DECIMAL.test(value)); return value; }
// Strict shape for cached data, so stored text cannot smuggle identities back.
export function validData(value: unknown, now: number): CursorData {
  const d = object(value);
  check(Object.keys(d).sort().join() === 'breakdown,cycle_start_ms,fetched_at_ms,limit,limited_users_count,max_user_spend,next_cycle_ms,spend,usage');
  const fetched = count(d.fetched_at_ms, now), start = count(d.cycle_start_ms, fetched);
  check(fetched > 0 && start > 0 && d.next_cycle_ms === nextCycle(start));
  amount(d.spend);
  if (d.limit !== null) check(Number(amount(d.limit)) > 0);
  if (d.max_user_spend !== null) amount(d.max_user_spend);
  if (d.limited_users_count !== null) count(d.limited_users_count, 100_000);
  check(Array.isArray(d.breakdown) && d.breakdown.length >= 2 && d.breakdown.length <= 20);
  const labels = new Set<string>();
  for (const raw of d.breakdown) {
    const item = object(raw);
    check(Object.keys(item).sort().join() === 'amount,label' && typeof item.label === 'string' && LABEL.test(item.label) && !labels.has(item.label));
    labels.add(item.label); amount(item.amount);
  }
  check(Array.isArray(d.usage) && d.usage.length <= 200);
  for (const raw of d.usage) {
    const row = object(raw);
    check(Object.keys(row).sort().join() === 'cache_read_tokens,cache_write_tokens,charged,events,headless,input_tokens,model,output_tokens');
    check(typeof row.model === 'string' && LABEL.test(row.model) && typeof row.headless === 'boolean');
    amount(row.charged);
    for (const key of ['events', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) count(row[key]);
  }
  return d as CursorData;
}
export function validState(value: unknown, now: number): CursorState | null {
  try {
    const s = object(value);
    const attempted = count(s.attempted_at_ms, now);
    check(attempted > 0 && [null, FORMAT_CHANGED, 'timeout', 'CLI failed', 'CLI output too large', ADMIN_REJECTED].includes(s.reason as string | null));
    const data = s.data === null ? null : validData(s.data, now);
    check(s.reason === null ? data !== null : data === null);
    return { attempted_at_ms: attempted, reason: s.reason as string | null, data };
  } catch { return null; }
}

// Spend reading for an ok Cursor row. A cycle that has already ended shows no
// spend until the next hourly fetch, rather than last cycle's totals.
export function cursorReading(plan: Reading, data: CursorData, now: number): Reading {
  if (now >= data.next_cycle_ms) return plan;
  const spend = { amount: data.spend, unit: 'usd' as const, remaining: data.spend, total: null, label: 'cycle spend' };
  const windows = data.limit === null ? [] : [{
    name: 'monthly', used_percent: Math.min(100, Math.round(Number(data.spend) / Number(data.limit) * 10_000) / 100),
    resets_at_ms: data.next_cycle_ms, window_minutes: null,
  }];
  return { ...plan, windows, balance: spend, balances: [spend], breakdown: data.breakdown };
}
