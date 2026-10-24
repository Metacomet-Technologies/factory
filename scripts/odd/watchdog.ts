// Outcome driven development: the Watchdog's pure rules (docs/odd/README.md §4, §5.3, §8).
// The control-plane plugin runs the sweep on a timer and does the IO; nothing here calls out.

import { capacity, parseThreadLabels, type Action, type Load, type Role, type Status } from './lifecycle.ts';
import { verdictPattern, type LiveThread } from './snapshot.ts';

/** Sweep cadence: every issue with live work or in an ODD-owned status is re-evaluated this often. */
export const sweepMs = 10 * 60_000;
/** An idle role thread the lifecycle is waiting on is cancelled after this long without activity. */
export const staleMs = 15 * 60_000;
/** Soft caps exceeded for this long raise one `#factory-alerts` post per episode. */
export const capsAlertMs = 60 * 60_000;
/** Every sweep call failing for this long pages `control-plane-blind` once per episode. */
export const blindMs = 15 * 60_000;
/** Digest hour and zone: 08:00 on the deploy host's clock (factory-gpu runs America/New_York). */
export const digestHour = 8;
export const digestTimeZone = 'America/New_York';
export const alertsChannel = 'factory-alerts';

/**
 * Threads to cancel: the action waits on an idle thread of `action.stuck`'s role, and that
 * thread has been idle longer than `staleMs`. A thread the search index has not dated yet
 * (`updatedAt` missing) is never stale; a reviewer thread with a verdict has delivered.
 */
export function staleThreads(action: Action, threads: readonly LiveThread[], now: Date): LiveThread[] {
  if (action.kind !== 'wait' || !action.stuck) return [];
  return threads.filter(thread => {
    const { role } = parseThreadLabels(thread.labels);
    if (role !== action.stuck || thread.state !== 'idle' || !thread.updatedAt) return false;
    if (role === 'reviewer' && thread.labels.some(label => verdictPattern.test(label))) return false;
    return now.getTime() - Date.parse(thread.updatedAt) > staleMs;
  });
}

/** The status a cancelled role's issue returns to; undefined keeps the current status. */
export function restoreStatus(role: Role, status: Status, hasPr: boolean): Status | undefined {
  return role === 'builder' && status === 'In Progress' && !hasPr ? 'Todo' : undefined;
}

export const overCaps = (load: Load) => load.orbs > capacity.orbs || load.runnerSlots > capacity.runnerSlots || load.buildIssues > capacity.buildIssues;

/** Calendar day (YYYY-MM-DD) and hour in the digest zone. */
export function localClock(now: Date, timeZone = digestTimeZone): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** One digest per local day, once the clock has passed `digestHour`. */
export function digestDue(lastDigestDay: string | undefined, now: Date, timeZone = digestTimeZone): string | undefined {
  const { day, hour } = localClock(now, timeZone);
  return hour >= digestHour && day !== lastDigestDay ? day : undefined;
}

export type DigestInput = {
  day: string;
  merged: readonly { number: number; title: string; headSha: string; mergeSha: string }[];
  done: readonly { identifier: string; title: string }[];
  bugs: readonly { identifier: string; title: string }[];
  escalated: readonly { identifier: string; title: string }[];
  load: Load;
  cancelled: readonly string[];
};

const short = (sha: string) => sha.slice(0, 12);
const list = <T>(items: readonly T[], line: (item: T) => string) => (items.length ? items.map(item => `- ${line(item)}`).join('\n') : '- none');

/** The daily digest for `#factory-alerts`: counts, identifiers and SHAs only; never diffs or secrets. */
export function digest(input: DigestInput): string {
  return [
    `ODD digest ${input.day}`,
    `Merged PRs (${input.merged.length}):`,
    list(input.merged, pr => `#${pr.number} ${pr.title} head ${short(pr.headSha)} merge ${short(pr.mergeSha)}`),
    `Issues Done (${input.done.length}):`,
    list(input.done, issue => `${issue.identifier} ${issue.title}`),
    `Bugs filed (${input.bugs.length}):`,
    list(input.bugs, issue => `${issue.identifier} ${issue.title}`),
    `Waiting on Devon (${input.escalated.length}):`,
    list(input.escalated, issue => `${issue.identifier} ${issue.title}`),
    `Load: orbs ${input.load.orbs}/${capacity.orbs}, runner slots ${input.load.runnerSlots}/${capacity.runnerSlots}, build issues ${input.load.buildIssues}/${capacity.buildIssues}`,
    `Watchdog cancellations (${input.cancelled.length}):`,
    list(input.cancelled, line => line),
  ].join('\n');
}
