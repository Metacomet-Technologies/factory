// MET-261 local ledger: the dispatcher's source of truth for issue snapshots and the
// control markers on them. Linear comments are the write-only audit trail; one
// dispatcher process holds the flock, so no fencing is needed.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { commentMarkers, type Issue } from './dispatch.ts';

type Comment = Issue['comments'][number];

const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT);
CREATE TABLE IF NOT EXISTS markers (comment_id TEXT NOT NULL, issue_id TEXT NOT NULL, line TEXT NOT NULL,
  kind TEXT NOT NULL, thread TEXT, pr TEXT, sha TEXT, created_at TEXT, PRIMARY KEY (comment_id, line));
CREATE INDEX IF NOT EXISTS comments_issue ON comments (issue_id);
CREATE INDEX IF NOT EXISTS markers_issue ON markers (issue_id, kind);`;
const tables = ['meta', 'issues', 'comments', 'markers'];

// Claims, builder threads, QA verdicts and archive steps, keyed by issue with head SHA and time.
export function parseMarker(line: string) {
  const [, space, name] = line.match(/^<!-- factory-(dispatch|qa):([\w-]+)/) ?? [];
  return {
    kind: `${space}:${name}`,
    thread: line.match(/\b(T-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|bc-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\b/)?.[1] ?? null,
    pr: line.match(/\bpr:(\d+)\b/)?.[1] ?? null,
    sha: line.match(/\bsha:([a-f0-9]{40})\b/)?.[1] ?? null,
  };
}

// Markers that cannot all be true at once. Import refuses them rather than picking one.
export function markerConflicts(comments: Comment[]) {
  const lines = comments.flatMap(c => commentMarkers(c.body));
  const distinct = new Map<string, Set<string>>();
  const add = (key: string, value: string) => distinct.set(key, (distinct.get(key) ?? new Set()).add(value));
  for (const line of lines) {
    const { kind, thread } = parseMarker(line);
    const round = line.includes(' round:2') ? ' round:2' : '';
    const key = line.match(/\bpr:\d+ sha:[a-f0-9]{40}/)?.[0];
    if (kind === 'dispatch:thread') add('builder thread', thread ?? line);
    else if (['dispatch:claim', 'dispatch:repo', 'dispatch:worktree'].includes(kind)) add(kind.slice(9), line);
    else if (kind === 'qa:review-claim' && key) add(`QA reviewer ${key}${round}`, thread ?? line);
    else if (kind === 'qa:review' && key) add(`QA verdict ${key}${round} ${thread}`, line.match(/verdict:(\w+)/)?.[1] ?? line);
  }
  return [...distinct].filter(([, values]) => values.size > 1).map(([marker, values]) => ({ marker, values: [...values].sort() }));
}

// Deterministic UUIDv4-shaped ID: a retry of the same write reuses it, and the n-th identical
// body on an issue gets its own. Linear accepts caller-supplied comment IDs.
export function commentId(issueId: string, body: string, n: number) {
  const hex = createHash('sha256').update(`${issueId}\n${n}\n${body}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type Ledger = ReturnType<typeof openLedger>;

// Dry-run works on an in-memory copy, so it never writes the file (or creates it).
export function openLedger(path: string, dryRun: boolean) {
  let db: DatabaseSync;
  if (dryRun) {
    db = new DatabaseSync(':memory:');
    db.exec(schema);
    if (existsSync(path)) {
      const source = new DatabaseSync(path, { readOnly: true });
      for (const table of tables) {
        const rows = source.prepare(`SELECT * FROM ${table}`).all() as Record<string, any>[];
        for (const row of rows) {
          const names = Object.keys(row);
          db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(name => row[name]));
        }
      }
      source.close();
    }
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec(schema);
  }
  const statements = {
    get: db.prepare('SELECT value FROM meta WHERE key = ?'),
    set: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    issue: db.prepare('INSERT INTO issues (id, identifier, snapshot) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET identifier = excluded.identifier, snapshot = excluded.snapshot'),
    // A Linear read is authoritative for the body and creation time; the dispatcher's own
    // write has no creation time until the next read supplies Linear's.
    read: db.prepare(`INSERT INTO comments (id, issue_id, body, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`),
    write: db.prepare('INSERT OR IGNORE INTO comments (id, issue_id, body, created_at) VALUES (?, ?, ?, NULL)'),
    clearMarkers: db.prepare('DELETE FROM markers WHERE comment_id = ?'),
    marker: db.prepare('INSERT OR IGNORE INTO markers VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  };
  const ledger = {
    path,
    get: (key: string) => (statements.get.get(key) as { value: string } | undefined)?.value,
    set: (key: string, value: string | number) => { statements.set.run(key, String(value)); },
    transaction(work: () => void) {
      db.exec('BEGIN IMMEDIATE');
      try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    has: (id: string) => !!db.prepare('SELECT 1 FROM issues WHERE id = ?').get(id),
    saveIssue(issue: Issue) {
      const { comments: _comments, ...snapshot } = issue;
      statements.issue.run(issue.id, issue.identifier, JSON.stringify(snapshot));
    },
    saveComment(issueId: string, comment: Comment, written = false) {
      if (written) statements.write.run(comment.id!, issueId, comment.body);
      else statements.read.run(comment.id!, issueId, comment.body, comment.createdAt ?? null);
      statements.clearMarkers.run(comment.id!);
      for (const line of commentMarkers(comment.body)) {
        const { kind, thread, pr, sha } = parseMarker(line);
        statements.marker.run(comment.id!, issueId, line, kind, thread, pr, sha, comment.createdAt ?? null);
      }
    },
    // Upsert: overlapping reads and repeated imports change nothing. Callers own the transaction.
    store(issue: Issue) {
      ledger.saveIssue(issue);
      for (const comment of issue.comments) ledger.saveComment(issue.id, comment);
    },
    // Insertion order matches Linear's order at import; later comments follow.
    issues(): Issue[] {
      const comments = new Map<string, Comment[]>();
      for (const row of db.prepare('SELECT id, issue_id, body, created_at FROM comments ORDER BY rowid').all() as any[]) {
        comments.set(row.issue_id, [...(comments.get(row.issue_id) ?? []), { id: row.id, body: row.body, ...(row.created_at === null ? {} : { createdAt: row.created_at }) }]);
      }
      return (db.prepare('SELECT id, snapshot FROM issues ORDER BY rowid').all() as any[])
        .map(row => ({ ...JSON.parse(row.snapshot), comments: comments.get(row.id) ?? [] }));
    },
    // Blocker state lives on the blocked issue's snapshot; refresh it when the blocker changes.
    patchBlockers(states: Map<string, { type: string }>) {
      if (!states.size) return;
      for (const issue of ledger.issues()) {
        let changed = false;
        for (const relation of issue.inverseRelations) {
          const state = states.get(relation.issue.identifier);
          if (state && state.type !== relation.issue.state.type) { relation.issue.state = { type: state.type }; changed = true; }
        }
        if (changed) ledger.saveIssue(issue);
      }
    },
    markers: (issueId: string) => db.prepare('SELECT line, kind, thread, pr, sha, created_at FROM markers WHERE issue_id = ? ORDER BY rowid').all(issueId) as any[],
    counts: () => Object.fromEntries(['issues', 'comments', 'markers'].map(table => [table, (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n])),
  };
  return ledger;
}
