// Outcome driven development: the Watchdog's pure rules (docs/odd/README.md §4, §5.3, §8).
// The control-plane plugin runs the sweep on a timer and does the IO; nothing here calls out.

import { capacity, pageText, parseThreadLabels, waitAge, waitBudgets, type Action, type Load, type Role, type Status, type Wait } from './lifecycle.ts';
import { delivered, type LiveThread } from './snapshot.ts';

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
 * (`updatedAt` missing) is never stale, and neither is one that delivered (a reviewer with a
 * verdict, a verifier of another receipt than `receiptSha`).
 */
export function staleThreads(action: Action, threads: readonly LiveThread[], now: Date, receiptSha?: string): LiveThread[] {
  if (action.kind !== 'wait' || !action.stuck) return [];
  return threads.filter(thread => {
    const { role } = parseThreadLabels(thread.labels);
    if (role !== action.stuck || thread.state !== 'idle' || !thread.updatedAt || delivered(thread, receiptSha)) return false;
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

/** A human wait (a risk decision, a failed verification) or a machine wait whose age is unknown; the digest lists both. */
export type DigestWait = { identifier: string; reason: string };

export type DigestInput = {
  day: string;
  merged: readonly { number: number; title: string; headSha: string; mergeSha: string }[];
  done: readonly { identifier: string; title: string }[];
  bugs: readonly { identifier: string; title: string }[];
  escalated: readonly { identifier: string; title: string }[];
  load: Load;
  cancelled: readonly string[];
  risk: readonly DigestWait[];
  failedVerification: readonly DigestWait[];
  unknownAge: readonly DigestWait[];
};

/** The digest's first line; the sweep searches `#factory-alerts` for it so a plugin reload does not post the day twice. */
export const digestHeading = (day: string) => `ODD digest ${day}`;

const short = (sha: string) => sha.slice(0, 12);
const list = <T>(items: readonly T[], line: (item: T) => string) => (items.length ? items.map(item => `- ${line(item)}`).join('\n') : '- none');

/** Slack rejects a message whose block text exceeds 3000 characters (`invalid_blocks`); a day with 46 merged PRs is longer. */
export const slackMessageMax = 2800;

/** Splits `text` on line breaks into messages of at most `max` characters; every part after the first starts with `(n/total)`. */
export function slackMessages(text: string, max = slackMessageMax): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= max || !current) {
      current = next;
    } else {
      parts.push(current);
      current = line;
    }
  }
  parts.push(current);
  return parts.length === 1 ? parts : parts.map((part, i) => (i === 0 ? part : `(${i + 1}/${parts.length})\n${part}`));
}

/** The daily digest for `#factory-alerts`: counts, identifiers and SHAs only; never diffs or secrets. */
export function digest(input: DigestInput): string {
  return [
    digestHeading(input.day),
    `Merged PRs (${input.merged.length}):`,
    list(input.merged, pr => `#${pr.number} ${pr.title} head ${short(pr.headSha)} merge ${short(pr.mergeSha)}`),
    `Issues Done (${input.done.length}):`,
    list(input.done, issue => `${issue.identifier} ${issue.title}`),
    `Bugs filed (${input.bugs.length}):`,
    list(input.bugs, issue => `${issue.identifier} ${issue.title}`),
    `Waiting on Devon (${input.escalated.length}):`,
    list(input.escalated, issue => `${issue.identifier} ${issue.title}`),
    `Risk decisions waiting (${input.risk.length}):`,
    list(input.risk, wait => `${wait.identifier} ${wait.reason}`),
    `Failed verifications (${input.failedVerification.length}):`,
    list(input.failedVerification, wait => `${wait.identifier} ${wait.reason}`),
    `Waits of unknown age (${input.unknownAge.length}):`,
    list(input.unknownAge, wait => `${wait.identifier} ${wait.reason}`),
    `Load: orbs ${input.load.orbs}/${capacity.orbs}, runner slots ${input.load.runnerSlots}/${capacity.runnerSlots}, build issues ${input.load.buildIssues}/${capacity.buildIssues}`,
    `Watchdog cancellations (${input.cancelled.length}):`,
    list(input.cancelled, line => line),
  ].join('\n');
}

// --- Overdue waits (audit P3.1): one page per durable episode, recorded on the issue after delivery.

export const overdueLine = (key: string) => `odd-overdue key=${key}`;

/** Wait episodes already paged on this issue (`odd-overdue` comments). */
export function overdueKeys(comments: readonly { body: string }[]): Set<string> {
  return new Set(comments.flatMap(comment => [...comment.body.matchAll(/^odd-overdue key=(\S+)$/gm)].map(match => match[1])));
}

/** The page for a machine wait past its budget, or nothing while it is within budget, human or of unknown age. */
export function overduePage(issue: string, action: Extract<Action, { kind: 'wait' }>, now: number, pr?: { number: number; headSha: string }): string | undefined {
  if (!action.wait) return undefined;
  const age = waitAge(action.wait, now);
  const budget = waitBudgets[action.wait.kind];
  if (age.state !== 'over' || budget.notify !== 'page') return undefined;
  const detail = `${action.reason}: ${action.wait.kind} wait is ${minutes(age.ageMs)} old (budget ${minutes(budget.ms)}) since ${action.wait.since}. episode=${action.wait.key}`;
  return pageText(issue, { kind: 'page', reason: 'wait-overdue', detail, pr: pr?.number, sha: pr?.headSha });
}

const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min`;

// --- Failure episodes and incidents (audit P3.1): an action that keeps failing is a red flag,
// and one shared blocker is one incident however many issues and rechecks it touches.

/** A failing action pages at its third attempt or five minutes after the first failure, whichever comes first. */
export const failureBudget = Object.freeze({ attempts: 3, ms: 5 * 60_000 });

export type Alert = 'pending' | 'action-failed' | 'plane-blocked' | 'closed';

/**
 * One failing action on one issue: `key` is `<stage>-<head or round>` so a new head or round is
 * a new episode. `first` and `attempts` survive sweeps and reloads through the `odd-failure`
 * comment (updated in place by `commentId`). `alert` is the incident page actually delivered
 * for it (`pending` until Slack confirms; `closed` once the resolution is delivered).
 */
export type Episode = {
  issue: string;
  key: string;
  stage: string;
  first: string;
  attempts: number;
  state: 'open' | 'resolved';
  alert: Alert;
  error: string;
  commentId?: string;
  /** The evaluation's recheck budget is spent: the episode is due now, never only logged. */
  exhausted?: boolean;
};

export const episodeLine = (episode: Episode) =>
  `odd-failure key=${episode.key} stage=${episode.stage} first=${episode.first} attempts=${episode.attempts} state=${episode.state} alert=${episode.alert}\n\n${episode.error}`;

export function parseEpisode(issue: string, comment: { id?: string; body: string }): Episode | undefined {
  const match = /^odd-failure key=(\S+) stage=(\S+) first=(\S+) attempts=(\d+) state=(open|resolved) alert=(pending|action-failed|plane-blocked|closed)$/m.exec(comment.body);
  if (!match || Number.isNaN(Date.parse(match[3]))) return undefined;
  const error = comment.body.slice(match.index + match[0].length).trim();
  return { issue, key: match[1], stage: match[2], first: match[3], attempts: Number(match[4]), state: match[5] as Episode['state'], alert: match[6] as Alert, error, ...(comment.id ? { commentId: comment.id } : {}) };
}

/** Error text safe for Slack and Linear: no tokens, URL queries or line breaks; at most 300 characters. */
export function sanitizeError(error: string): string {
  return error
    .replace(/\b(?:gh[opsu]_|github_pat_|xox[abpr]-|lin_api_|sk-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b(Bearer|token)\s+\S+/gi, '$1 [redacted]')
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export const failureDue = (episode: Episode, now: number) =>
  episode.exhausted === true || episode.attempts >= failureBudget.attempts || now - Date.parse(episode.first) >= failureBudget.ms;

/** The shared blocker: same stage, same error once issue identifiers, SHAs, thread IDs and numbers are masked. */
export function incidentKey(episode: Pick<Episode, 'stage' | 'error'>): string {
  const shape = episode.error.replace(/\bMET-\d+\b/gi, 'MET-n').replace(/\bT-[0-9a-f-]{36}\b/gi, 'T-id').replace(/\b[0-9a-f]{7,40}\b/gi, 'sha').replace(/\d+/g, 'n');
  let hash = 0x811c9dc5;
  for (const char of `${episode.stage}\n${shape}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `${episode.stage}-${hash.toString(16).padStart(8, '0')}`;
}

/** `building` are the issues holding build slots; `waiting` the issues held at build capacity. */
export type Plane = { load: Load; building: readonly string[]; waiting: readonly string[] };

export type Incident = {
  key: string;
  reason: 'action-failed' | 'plane-blocked';
  episodes: Episode[];
  due: boolean;
  /** The strongest page delivered for it, if any. */
  delivered?: 'action-failed' | 'plane-blocked';
  resolved: boolean;
};

/**
 * Groups live episodes (not `closed`) into incidents. An incident is `plane-blocked` when every
 * occupied build slot belongs to an issue whose next action fails, the slots are full, and ready
 * work waits for one of them; full slots with builders that progress have no episodes at all.
 */
export function incidents(episodes: readonly Episode[], plane: Plane, now: number): Incident[] {
  const failing = new Set(episodes.filter(episode => episode.state === 'open').map(episode => episode.issue));
  const deadlocked = plane.load.buildIssues >= capacity.buildIssues && plane.waiting.length > 0 && plane.building.length > 0 && plane.building.every(issue => failing.has(issue));
  const groups = new Map<string, Episode[]>();
  for (const episode of episodes) {
    if (episode.alert === 'closed') continue;
    const key = incidentKey(episode);
    groups.set(key, [...(groups.get(key) ?? []), episode]);
  }
  return [...groups].map(([key, group]) => {
    const open = group.filter(episode => episode.state === 'open');
    const alerts = group.map(episode => episode.alert);
    const delivered = alerts.includes('plane-blocked') ? 'plane-blocked' : alerts.includes('action-failed') ? 'action-failed' : undefined;
    return {
      key,
      reason: deadlocked && open.some(episode => plane.building.includes(episode.issue)) ? 'plane-blocked' : 'action-failed',
      episodes: group,
      due: open.some(episode => failureDue(episode, now)),
      ...(delivered ? { delivered } : {}),
      resolved: open.length === 0,
    };
  });
}

/** True when the incident's page must go out now: due and not delivered, or newly a deadlock after an action-failed page. */
export const incidentPageDue = (incident: Incident) =>
  !incident.resolved && incident.due && (incident.delivered === undefined || (incident.reason === 'plane-blocked' && incident.delivered === 'action-failed'));

function intervention(stage: string): string {
  if (stage.startsWith('spawn-')) return `make the ${stage.slice(6)} startable (fix the error above, for example register the missing agent mode or engine) and reload the control orb; the next evaluation retries the spawn`;
  if (stage === 'steer') return 'check that the builder thread accepts messages; every evaluation retries the steer';
  if (stage === 'merge') return 'resolve the merge refusal or failure at the PR head (the odd-merge-refused comment has the gate output), or merge by hand';
  if (stage === 'evaluate') return 'restore the Linear, GitHub or thread-search read that fails';
  return 'fix the error above; every evaluation retries the action';
}

/** The incident page, in the one page format: issues, failing stage, sanitized error, age, slots, waiting work and the human step needed. */
export function incidentText(incident: Incident, plane: Plane, now: number): string {
  const open = incident.episodes.filter(episode => episode.state === 'open');
  const first = open.map(episode => episode.first).sort()[0] ?? incident.episodes[0].first;
  const { stage, error } = open[0] ?? incident.episodes[0];
  const attempts = open.reduce((sum, episode) => sum + episode.attempts, 0);
  const issues = [...new Set(open.map(episode => episode.issue))].sort();
  const deadlock = incident.reason === 'plane-blocked'
    ? ` Ready work waiting for a build slot: ${plane.waiting.join(', ')}. Nothing frees a slot automatically.`
    : '';
  const detail = [
    `${stage} failing since ${first} (${minutes(now - Date.parse(first))}, ${attempts} attempts): ${error}.`,
    `Occupied build slots ${plane.load.buildIssues}/${capacity.buildIssues}: ${plane.building.join(', ') || 'none'}.${deadlock}`,
    `Needed: ${intervention(stage)}. incident=${incident.key}`,
  ].join(' ');
  return pageText(issues.join(', '), { kind: 'page', reason: incident.reason, detail });
}

export function resolutionText(incident: Incident, now: number): string {
  const issues = [...new Set(incident.episodes.map(episode => episode.issue))].sort().join(', ');
  const first = incident.episodes.map(episode => episode.first).sort()[0];
  return `ODD resolved: ${incident.delivered ?? incident.reason} | issue ${issues} | ${incident.episodes[0].stage} advances again after ${minutes(now - Date.parse(first))}. incident=${incident.key}`;
}

/** The digest line for a wait the lifecycle cannot age. */
export const unknownAge = (identifier: string, reason: string, wait: Wait): DigestWait => ({ identifier, reason: `${reason} (${wait.kind} wait, episode ${wait.key}: no durable start time)` });
