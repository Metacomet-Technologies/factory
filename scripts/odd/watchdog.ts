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

/** Calendar day (YYYY-MM-DD), hour and minute in the digest zone. */
export function localClock(now: Date, timeZone = digestTimeZone): { day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

/** One digest per local day, once the clock has passed `digestHour`. */
export function digestDue(lastDigestDay: string | undefined, now: Date, timeZone = digestTimeZone): string | undefined {
  const { day, hour } = localClock(now, timeZone);
  return hour >= digestHour && day !== lastDigestDay ? day : undefined;
}

/** A digest first rendered this long after `digestHour` (three sweeps) is a late catch-up and says so. */
export const digestLateMs = 30 * 60_000;
export function digestLate(now: Date, timeZone = digestTimeZone): boolean {
  const { hour, minute } = localClock(now, timeZone);
  return (hour - digestHour) * 60 + minute >= digestLateMs / 60_000;
}

/** One stalled-work line: an issue and why it waits. */
export type DigestWait = { identifier: string; reason: string };
/** The digest's stalled-work lists, one per class; each issue sits in at most one (the sweep's latest evaluation). */
export type DigestList = 'risk' | 'failedVerification' | 'unknownAge' | 'overBudget' | 'missingReceipt' | 'unownedTodo';

export type DigestInput = {
  day: string;
  /** Rendered after the scheduled window (digestLate): the digest says it is a catch-up. */
  late?: boolean;
  merged: readonly { number: number; title: string; headSha: string; mergeSha: string }[];
  done: readonly { identifier: string; title: string }[];
  bugs: readonly { identifier: string; title: string }[];
  escalated: readonly { identifier: string; title: string }[];
  load: Load;
  cancelled: readonly string[];
  publisher: Publisher;
} & Record<DigestList, readonly DigestWait[]>;

/** Every digest message starts with this; the sweep searches `#factory-alerts` for it. */
export const digestHeading = (day: string) => `ODD digest ${day}`;

const short = (sha: string) => sha.slice(0, 12);
const list = <T>(items: readonly T[], line: (item: T) => string) => (items.length ? items.map(item => `- ${line(item)}`).join('\n') : '- none');

/** Slack rejects a message whose block text exceeds 3000 characters (`invalid_blocks`); a day with 46 merged PRs is longer. */
export const slackMessageMax = 2800;

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

const partHeader = (day: string, part: number, parts: number, id: string) => `${digestHeading(day)} part ${part}/${parts} id=${id}`;
/** Written only after every part of delivery `id` is in the channel; a day with it is never posted again. */
export const digestCompleteLine = (day: string, id: string, parts: number) => `${digestHeading(day)} complete id=${id} parts=${parts}`;

/**
 * The digest as Slack messages of at most `max` characters. Every message starts with its durable
 * identity, `ODD digest <day> part <n>/<total> id=<content hash>`, so a retry after a failed
 * part or a reload posts only the parts the channel lacks. Lines are packed whole; a line longer
 * than a message body is hard-split at code points, with the header (at the widest part number)
 * counted against the limit.
 */
export function digestParts(text: string, day: string, max = slackMessageMax): string[] {
  const id = fnv(text);
  const body = text.split('\n');
  if (body[0] === digestHeading(day)) body.shift();
  for (let digits = 1; ; digits++) {
    const widest = 10 ** digits - 1;
    const room = max - partHeader(day, widest, widest, id).length - 1;
    const lines = body.flatMap(line => {
      const chunks: string[] = [];
      let chunk = '';
      for (const char of line) {
        if (chunk.length + char.length > room) {
          chunks.push(chunk);
          chunk = '';
        }
        chunk += char;
      }
      return [...chunks, chunk];
    });
    const bodies: string[] = [];
    let current: string | undefined;
    for (const line of lines) {
      if (current !== undefined && current.length + 1 + line.length <= room) current += `\n${line}`;
      else {
        if (current !== undefined) bodies.push(current);
        current = line;
      }
    }
    bodies.push(current ?? '');
    if (bodies.length <= widest) return bodies.map((part, i) => `${partHeader(day, i + 1, bodies.length, id)}\n${part}`);
  }
}

/** True when the channel holds the day's completion line, or a digest from before part identities (its first line is the bare heading). */
export function digestDelivered(day: string, posted: readonly string[]): boolean {
  const heading = digestHeading(day);
  return posted.some(text => {
    const first = text.split('\n')[0];
    return first === heading || first.startsWith(`${heading} complete id=`);
  });
}

/** Whether an earlier, incomplete delivery of `day` in the channel was a late catch-up (its part 1 says so); undefined when none was posted. */
export function postedLate(day: string, posted: readonly string[]): boolean | undefined {
  const first = posted.find(text => new RegExp(`^${digestHeading(day)} part 1/\\d+ id=`).test(text));
  return first === undefined ? undefined : first.includes('\nLate catch-up:');
}

/**
 * What to post next for `day`, given what the channel (and this process) already holds: the
 * parts of `parts` not yet posted, oldest first, then the completion line. A delivery the
 * channel already holds in full (an older rendering whose completion line failed) only gets its
 * completion line. An incomplete delivery of another rendering (the facts changed before a
 * reload re-rendered them) is superseded: the new rendering is posted in full under its own id
 * and completed, so no tail is ever left missing. Nothing once the day is delivered.
 */
export function digestSends(day: string, posted: readonly string[], parts: readonly string[]): string[] {
  if (digestDelivered(day, posted)) return [];
  const pattern = new RegExp(`^${digestHeading(day)} part (\\d+)/(\\d+) id=([0-9a-f]{8})$`);
  const seen = new Map<string, { total: number; parts: Set<number> }>();
  for (const text of posted) {
    const match = pattern.exec(text.split('\n')[0]);
    if (!match) continue;
    const key = `${match[3]} ${match[2]}`;
    const entry = seen.get(key) ?? { total: Number(match[2]), parts: new Set<number>() };
    entry.parts.add(Number(match[1]));
    seen.set(key, entry);
  }
  for (const [key, entry] of seen) if (entry.parts.size === entry.total) return [digestCompleteLine(day, key.split(' ')[0], entry.total)];
  const header = pattern.exec(parts[0]?.split('\n')[0] ?? '');
  if (!header) throw new Error(`digest parts for ${day} have no part identity`);
  const done = seen.get(`${header[3]} ${header[2]}`)?.parts ?? new Set<number>();
  return [...parts.filter((_, i) => !done.has(i + 1)), digestCompleteLine(day, header[3], parts.length)];
}

const waits = (title: string, items: readonly DigestWait[]) => [`${title} (${items.length}):`, list(items, wait => `${wait.identifier} ${wait.reason}`)];

/** The daily digest for `#factory-alerts`: counts, identifiers and SHAs only; never diffs or secrets. */
export function digest(input: DigestInput): string {
  return [
    digestHeading(input.day),
    ...(input.late ? [`Late catch-up: due at ${String(digestHour).padStart(2, '0')}:00 ${digestTimeZone} and not delivered then; posted by a later sweep.`] : []),
    publisherLine(input.publisher),
    `Merged PRs (${input.merged.length}):`,
    list(input.merged, pr => `#${pr.number} ${pr.title} head ${short(pr.headSha)} merge ${short(pr.mergeSha)}`),
    `Issues Done (${input.done.length}):`,
    list(input.done, issue => `${issue.identifier} ${issue.title}`),
    `Bugs filed (${input.bugs.length}):`,
    list(input.bugs, issue => `${issue.identifier} ${issue.title}`),
    `Waiting on Devon (${input.escalated.length}):`,
    list(input.escalated, issue => `${issue.identifier} ${issue.title}`),
    ...waits('Risk decisions waiting', input.risk),
    ...waits('Failed verifications', input.failedVerification),
    ...waits('Waits over budget', input.overBudget),
    ...waits('Missing deploy receipts', input.missingReceipt),
    ...waits('Todo with no owner', input.unownedTodo),
    ...waits('Waits of unknown age', input.unknownAge),
    `Load: orbs ${input.load.orbs}/${capacity.orbs}, runner slots ${input.load.runnerSlots}/${capacity.runnerSlots}, build issues ${input.load.buildIssues}/${capacity.buildIssues}`,
    `Watchdog cancellations (${input.cancelled.length}):`,
    list(input.cancelled, line => line),
  ].join('\n');
}

/**
 * The digest list for an evaluated issue's wait, if it is stalled work: a deploy receipt still
 * missing (any age), a machine wait past its budget, a human wait, a wait of unknown age, or a
 * Todo issue that waits with no role thread holding it.
 */
export function stalledWork(identifier: string, status: Status, owned: boolean, action: Action, now: number): (DigestWait & { list: DigestList }) | undefined {
  if (action.kind !== 'wait') return undefined;
  if (!action.wait) return status === 'Todo' && !owned ? { list: 'unownedTodo', identifier, reason: action.reason } : undefined;
  const age = waitAge(action.wait, now);
  const budget = waitBudgets[action.wait.kind];
  const aged = age.state === 'within' || age.state === 'over' ? `${minutes(age.ageMs)} old${budget.notify === 'page' ? `, budget ${minutes(budget.ms)}` : ''}` : 'no durable start time';
  const reason = `${action.reason} (${action.wait.kind} wait, ${aged}, episode ${action.wait.key})`;
  if (action.wait.kind === 'receipt') return { list: 'missingReceipt', identifier, reason };
  if (age.state === 'human') return { list: action.wait.kind === 'risk' ? 'risk' : 'failedVerification', identifier, reason: action.reason };
  if (age.state === 'unknown') return { list: 'unknownAge', ...unknownAge(identifier, action.reason, action.wait) };
  if (age.state === 'over') return { list: 'overBudget', identifier, reason };
  return status === 'Todo' && !owned ? { list: 'unownedTodo', identifier, reason: action.reason } : undefined;
}

// --- Publisher (P6.2): one authenticated GitHub snapshot of first-parent main against the newest
// published release, shared by the digest and the unreleased-main page.

/** First-parent main unreleased for longer than this pages once per stalled SHA. */
export const publisherStallMs = 60 * 60_000;

/** A commit as GitHub's compare lists it, reduced to what the walk needs; `date` is when it landed (committer date). */
export type MainCommit = { sha: string; parents: readonly string[]; date: string };
/** A workflow run as `gh run list` reports it; `conclusion` is empty until the run completes. */
export type Run = { status: string; conclusion: string; url: string; createdAt: string };

/**
 * `pending`: nothing has failed yet (CI or the publisher is queued or running, or waits for its
 * next wakeup). `failed`: the newest `release.yml` run on main failed. `recovery`: the stalled
 * SHA's own push CI failed, so the publisher cannot pass it until that CI is rerun or a
 * historical recovery is approved (docs/release.md); it wins over `failed`, whose cause it is.
 */
export type PublisherState = 'pending' | 'failed' | 'recovery';
export type Publisher = {
  release: { tag: string; sha: string };
  /** The oldest first-parent commit no published release contains, when it landed, how many are unreleased, and the run that explains it. */
  stalled?: { sha: string; since: string; unreleased: number; state: PublisherState; run?: string };
};

/** The newest stable published release: the highest vMAJOR.MINOR.PATCH tag that is neither a draft nor a prerelease. */
export function newestRelease(releases: readonly { tag: string; draft: boolean; prerelease: boolean }[]): string | undefined {
  const version = (tag: string) => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)?.slice(1).map(Number);
  let best: { tag: string; v: number[] } | undefined;
  for (const release of releases) {
    const v = version(release.tag);
    if (!v || release.draft || release.prerelease) continue;
    if (!best || (v[0] - best.v[0] || v[1] - best.v[1] || v[2] - best.v[2]) > 0) best = { tag: release.tag, v };
  }
  return best?.tag;
}

/**
 * The first-parent commits of main after `releaseSha`, oldest first, from the full compare of
 * the release with main. Main's head is the one commit no other listed commit has as a parent;
 * the walk follows first parents to `releaseSha`. A walk that leaves the list (a truncated
 * compare, or a release reached only through a second parent) throws: an unknown stall is never
 * reported as none.
 */
export function firstParentSince(releaseSha: string, commits: readonly MainCommit[]): MainCommit[] {
  if (!commits.length) return [];
  const bySha = new Map(commits.map(commit => [commit.sha, commit]));
  const parents = new Set(commits.flatMap(commit => commit.parents));
  const heads = commits.filter(commit => !parents.has(commit.sha));
  if (heads.length !== 1) throw new Error(`compare lists ${heads.length} heads of main, not one`);
  const chain: MainCommit[] = [];
  for (let commit: MainCommit | undefined = heads[0]; commit; ) {
    chain.push(commit);
    const parent: string | undefined = commit.parents[0];
    if (parent === releaseSha) return chain.reverse();
    commit = parent === undefined ? undefined : bySha.get(parent);
    if (chain.length > commits.length) break;
  }
  throw new Error(`the first-parent walk from main does not reach release ${short(releaseSha)} within the compare`);
}

const newest = (runs: readonly Run[]) => [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const unsuccessful = (run: Run | undefined) => run?.status === 'completed' && !['success', 'skipped', 'neutral'].includes(run.conclusion);

/** The snapshot from the release, its first-parent chain on main, the newest `release.yml` runs on main and the oldest stalled SHA's push CI runs. */
export function publisherSnapshot(release: { tag: string; sha: string }, chain: readonly MainCommit[], publisherRuns: readonly Run[], ciRuns: readonly Run[]): Publisher {
  const oldest = chain[0];
  if (!oldest) return { release };
  const ci = newest(ciRuns);
  const publisher = newest(publisherRuns);
  const state: PublisherState = ci?.status === 'completed' && ci.conclusion !== 'success' ? 'recovery' : unsuccessful(publisher) ? 'failed' : 'pending';
  const run = state === 'recovery' ? ci : state === 'failed' ? publisher : ci && ci.status !== 'completed' ? ci : publisher;
  return { release, stalled: { sha: oldest.sha, since: oldest.date, unreleased: chain.length, state, ...(run ? { run: run.url } : {}) } };
}

// The age is in the page only: the digest is rendered from facts alone, so a reload that re-renders an unchanged day keeps its delivery id.
const stallText = (stalled: NonNullable<Publisher['stalled']>, now?: number) =>
  `${stalled.unreleased} unreleased first-parent commit${stalled.unreleased === 1 ? '' : 's'} on main; oldest ${stalled.sha} landed ${stalled.since}${now === undefined ? '' : ` (${minutes(now - Date.parse(stalled.since))})`}; run ${stalled.run ?? 'none'}`;

export function publisherLine(publisher: Publisher): string {
  const release = `newest release ${publisher.release.tag} at ${short(publisher.release.sha)}`;
  return publisher.stalled ? `Publisher ${publisher.stalled.state}: ${stallText(publisher.stalled)}; ${release}` : `Publisher: main published through ${release}`;
}

/** The page for main left unreleased past `publisherStallMs`; nothing at or below it. One page per stalled SHA (the caller dedupes). */
export function publisherPage(publisher: Publisher, now: number): string | undefined {
  const { stalled } = publisher;
  if (!stalled || now - Date.parse(stalled.since) <= publisherStallMs) return undefined;
  const detail = `publisher ${stalled.state}: ${stallText(stalled, now)}; budget ${minutes(publisherStallMs)}; newest release ${publisher.release.tag}. episode=${publisherEpisode(stalled.sha)}`;
  return pageText('-', { kind: 'page', reason: 'wait-overdue', sha: stalled.sha, detail });
}

/** The durable record of a delivered publisher page, posted to `#factory-alerts` after Slack takes the page. */
export const publisherEpisode = (sha: string) => `publisher-${short(sha)}`;
export const publisherPagedLine = (sha: string) => `odd-publisher-paged sha=${sha}`;

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
