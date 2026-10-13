import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sections, slug, prompt, validate, isMergedGitHubPR, commentMarkers } from './dispatch.ts';

const executable = fileURLToPath(new URL('dispatch.ts', import.meta.url));
const threadId = 'T-01234567-89ab-4cde-8fab-0123456789ab';
const key = 'synthetic-test-secret-not-a-credential';
const dispatchLabel = { id: 'dispatch-id', name: 'dispatch' };
const group = (name: string, value: string) => ({ id: `${name}-${value}`, name: value, parent: { name } });
const body = `## Goal
Ship the widget.
> Goal hint, not instructions.
## Link type
> Defaults to contributes.
## Context
Leave production alone.
## Isolation
Only widgets/.
## Build
Build the widget.
## Tests
> Test hint.
## Sandbox check
none (external APIs use fakes)
## Deploy artifacts
Write, do not run.
## Done means
Reviewable PR.`;
function issue(n = 123, overrides: any = {}) {
  return { id: `uuid-${n}`, identifier: `MET-${n}`, title: 'Build the useful widget today', description: body,
    priority: 2, createdAt: '2026-10-01T00:00:00Z', team: { id: 'team-id', key: 'MET' },
    state: { type: 'unstarted' },
    labels: [{ ...dispatchLabel }, { id: 'feature', name: 'Feature' }, { id: 'area', name: 'area:agents' }],
    comments: [], inverseRelations: [], attachments: [], ...overrides };
}
const threadComment = (runner = 'gpu') => ({ body: `https://ampcode.com/threads/${threadId}\n<!-- factory-dispatch:thread ${threadId} runner:${runner} -->` });
const claimComment = () => ({ body: '<!-- factory-dispatch:claim runner:gpu -->', createdAt: '2026-10-10T12:00:00.000Z' });
const attachment = (status: string) => ({ url: 'https://github.com/Metacomet-Technologies/factory/pull/90', metadata: { status }, createdAt: '2026-10-10T12:00:00.001Z' });
const labeled = (i: any) => i.labels.some((label: any) => label.name === 'dispatch');
const now = Date.parse('2026-10-13T12:00:00.000Z');
const quietUpdated = '2026-10-13T11:55:00.000Z';
const archived = (i: any) => i.comments.some((c: any) => c.body.includes('<!-- factory-dispatch:archived -->'));
const archivable = (n = 123) => issue(n, { labels: [], state: { type: 'completed' }, comments: [
  { body: `<!-- factory-dispatch:thread T-01234567-89ab-4cde-8fab-${String(n).padStart(12, '0')} runner:gpu -->` }, { body: '<!-- factory-dispatch:wrapup -->' },
] });

async function fixture(t: any, issues = [issue()], options: any = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-dispatch-test-'));
  const callsFile = join(directory, 'amp-calls');
  const threadsFile = join(directory, 'amp-threads');
  writeFileSync(threadsFile, JSON.stringify(options.threads ?? issues.flatMap(i => i.comments.flatMap((c: any) => {
    const id = c.body.match(/factory-dispatch:thread (T-[a-f0-9-]{36})/)?.[1];
    return id ? [{ id, archived: false, updated: quietUpdated }] : [];
  }))));
  writeFileSync(join(directory, 'clock.mjs'), `Date.now = () => Number(process.env.FAKE_NOW);`);
  writeFileSync(join(directory, 'key'), key);
  writeFileSync(join(directory, 'lock'), '');
  writeFileSync(join(directory, 'amp'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\\n');
if (process.env.FAKE_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
if (process.env.FAKE_FAIL) { console.error('${key} full prompt must not leak'); process.exit(7); }
if (args[0] === 'threads' && args[1] === 'list') {
  if (process.env.FAKE_BAD_LIST) { console.log(process.env.FAKE_BAD_LIST); process.exit(0); }
  const threads = JSON.parse(fs.readFileSync(process.env.FAKE_THREADS, 'utf8'));
  const offset = Number(args[args.indexOf('--offset') + 1]);
  const limit = Number(args[args.indexOf('--limit') + 1]);
  console.log(JSON.stringify(threads.filter(t => args.includes('--include-archived') || !t.archived).slice(offset, offset + limit).map(t => ({ id: t.id, updated: t.updated }))));
  process.exit(0);
}
if (args[0] === 'threads' && args[1] === 'archive') {
  if (process.env.FAKE_ARCHIVE_FAIL) process.exit(7);
  const threads = JSON.parse(fs.readFileSync(process.env.FAKE_THREADS, 'utf8'));
  const thread = threads.find(t => t.id === args[2]);
  // Deliberately reject repeated archive commands: recovery must check first.
  if (!thread || thread.archived) process.exit(8);
  thread.archived = true;
  fs.writeFileSync(process.env.FAKE_THREADS, JSON.stringify(threads));
  process.exit(0);
}
console.log(process.env.FAKE_NO_ID ? 'submitted without id' : 'https://ampcode.com/threads/${threadId}');
`, { mode: 0o755 });
  const mutations: any[] = [];
  const queries: any[] = [];
  const children = new Set<any>();
  let current: any;
  let crash = options.crash;
  const pageSize = options.pageSize ?? 100;
  function page(nodes: any[], after: string | null = null) {
    const start = Number(after ?? 0);
    const end = start + pageSize;
    return { nodes: structuredClone(nodes.slice(start, end)), pageInfo: { hasNextPage: end < nodes.length, endCursor: String(Math.min(end, nodes.length)) } };
  }
  function wire(i: any) {
    return { ...structuredClone(i), ...Object.fromEntries(['labels', 'comments', 'inverseRelations', 'attachments'].map(name => [name, page(i[name])])) };
  }
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/graphql');
      assert.equal(request.headers.authorization, key);
      let text = '';
      for await (const chunk of request) text += chunk;
      const { query, variables: v } = JSON.parse(text);
      const operation = query.match(/^(?:query|mutation) (\w+)/)[1];
      const i = issues.find(i => i.id === (v.id ?? v.input?.issueId) || i.identifier === v.id);
      let data: any;
      if (query.startsWith('mutation')) {
        mutations.push({ operation, ...v });
        const crashHere = crash && crash(operation, v);
        if (crashHere === 'before') { crash = null; current.kill('SIGKILL'); response.destroy(); return; }
        if (options.rejectMutation === operation) { response.end(JSON.stringify({ data: { refused: { success: false } } })); return; }
        if (operation === 'Comment') { i.comments.push({ body: v.input.body, createdAt: new Date().toISOString() }); data = { commentCreate: { success: true } }; }
        else if (operation === 'RemoveLabel') { i.labels = i.labels.filter((label: any) => label.id !== v.labelId); data = { issueRemoveLabel: { success: true } }; }
        else if (operation === 'Move') { i.stateId = v.input.stateId; data = { issueUpdate: { success: true } }; }
        else throw new Error(`Unexpected mutation ${operation}`);
        if (crashHere === 'after') { crash = null; current.kill('SIGKILL'); response.destroy(); return; }
      } else {
        queries.push({ operation, query, ...v });
        if (options.graphqlError) { response.end(JSON.stringify({ errors: [{ message: key }] })); return; }
        if (options.invalidJSON) { response.end(`not JSON: ${key}`); return; }
        if (operation === 'Queue') {
          assert.match(query, /team \{ id key \} state \{ type \}/);
          assert.deepEqual(v.filter, { team: { key: { eq: 'MET' } }, or: [{ labels: { some: { name: { eq: 'dispatch' } } } }, { comments: { some: { body: { contains: '<!-- factory-dispatch:' } } } }] });
          const selected = issues.filter(i => i.team.key === 'MET' && (labeled(i) || i.comments.some((c: any) => c.body.includes('<!-- factory-dispatch:'))));
          const connection = page(selected, v.after);
          connection.nodes = connection.nodes.map(wire);
          data = { issues: connection };
        } else if (operation === 'OneIssue') data = { issue: wire(i) };
        else if (operation === 'IssuePage') {
          const name = query.match(/\{ issue\(id: \$id\) \{ (\w+)/)[1];
          data = { issue: { [name]: page(i[name], v.after) } };
        } else if (operation === 'States') {
          assert.deepEqual(v.filter, { team: { key: { eq: 'MET' } }, name: { eq: 'In Progress' } });
          data = { workflowStates: page([{ id: 'started-id', name: 'In Progress', type: 'started' }], v.after) };
        } else throw new Error(`Unexpected query ${operation}`);
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data }));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  function run(args = ['poll'], environment: any = {}) {
    const started = performance.now();
    const child = spawn(process.execPath, ['--import', join(directory, 'clock.mjs'), executable, ...args], { env: {
      PATH: `${directory}:/usr/bin:/bin`, HOME: directory, LINEAR_API_KEY_FILE: join(directory, 'key'),
      DISPATCH_LOCK_FILE: join(directory, 'lock'), DISPATCH_LINEAR_URL: `http://127.0.0.1:${(server.address() as any).port}/graphql`,
      FAKE_CALLS: callsFile, FAKE_THREADS: threadsFile, FAKE_NOW: String(now), ...environment,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise<any>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr, durationMs: performance.now() - started }); });
    });
  }
  return { issues, mutations, queries, run, directory,
    threads: () => JSON.parse(readFileSync(threadsFile, 'utf8')),
    setThreads: (threads: any[]) => writeFileSync(threadsFile, JSON.stringify(threads)),
    calls: () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}

test('full fake-server poll: dispatch, prompt contract, Linear state, and manual/poll idempotency', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const [args] = f.calls();
  assert.equal(args[0], '-x');
  assert.deepEqual(args.slice(2), ['--mode', 'medium', '--executor', 'runner:factory-gpu', '--runner-dir', '/home/agent/work', '--title', 'MET-123 — Build the useful widget today', '--visibility', 'private', '--no-archive-after-execute']);
  assert.equal(args[1].split('\n')[0], '**Thread title:** Use the Linear ticket identifier and title: `MET-123 — Build the useful widget today`.');
  for (const text of ['export GH_TOKEN="$AGENT_GH_TOKEN" && gh auth setup-git', 'git -C ~/work/factory fetch origin', 'git -C ~/work/factory worktree add -b met-123-build-the-useful-widget ~/work/factory-met-123-build-the-useful-widget origin/main', 'Never reuse or overwrite', 'Contributes MET-123', 'cargo fmt --check', 'cargo clippy --all-targets -- -D warnings', 'cargo test --workspace', 'vp check', 'factory-ssh', 'console-ssh', 'Never deploy']) assert.ok(args[1].includes(text), text);
  for (const text of [
    'Use the already-connected Linear MCP server', 'report their names without calling a write tool',
    'If unavailable, stop and report', 'do not work around it or change MCP settings',
    'read issues, comment progress on your own issue MET-123, link your PR',
    'create follow-up issues in Backlog related to MET-123',
    "Never change any existing issue's status, labels, assignee or priority; never edit other issues",
    'Backlog is allowed only when creating a follow-up',
    'The dispatcher owns the dispatch label, state moves and claim/thread/wrap-up/archive markers',
    'Never write or delete <!-- factory-dispatch:… --> or <!-- factory-qa:… --> markers',
    'Only the later wrap-up prompt may authorize the wrapup-done completion marker',
    'After opening the PR and after each later push, post one Linear comment on MET-123',
    'PR URL, head SHA and complete changed-file list from git diff --name-only origin/main...HEAD',
    'If git diff origin/main...HEAD is under 400 lines, include that full diff',
    'At 400 lines or more', 'full contents of every changed file under deploy/, every changed migration, and every changed script',
    'Identify deleted files explicitly', 'Use fenced code blocks', 'Never include secrets or production data',
    'redact them and identify any omissions',
  ]) assert.ok(args[1].includes(text), text);
  assert.ok(!args[1].includes('<!-- factory-dispatch:wrapup-done -->'));
  assert.ok(!args[1].includes('Goal hint'));
  assert.ok(!result.stdout.includes('Ship the widget'));
  assert.deepEqual(f.mutations.map(m => m.operation), ['RemoveLabel', 'Comment', 'Comment', 'Move']);
  assert.equal(f.issues[0].stateId, 'started-id');
  assert.equal(labeled(f.issues[0]), false);
  assert.ok(f.issues[0].comments.some((c: any) => c.body.includes(`<!-- factory-dispatch:thread ${threadId} runner:gpu -->`)));
  await f.run();
  await f.run(['issue', 'MET-123']);
  f.issues[0].labels.push({ ...dispatchLabel });
  await f.run();
  assert.equal(labeled(f.issues[0]), false);
  assert.equal(f.calls().length, 1);
});

test('only standalone unfenced marker lines count, including future QA markers', () => {
  const markers = [
    '<!-- factory-dispatch:claim runner:gpu -->',
    `<!-- factory-dispatch:thread ${threadId} runner:gpu -->`,
    '<!-- factory-dispatch:worktree met-123-quoted-worktree -->',
    ...['waiting', 'invalid', 'wrapup-claim', 'wrapup', 'wrapup-done', 'archive-claim', 'archived']
      .map(name => `<!-- factory-dispatch:${name} -->`),
    '<!-- factory-qa:passed -->', '<!-- factory-qa:failed -->',
  ];
  const lines = markers.join('\n');
  for (const fence of ['```', '````', '~~~']) {
    assert.deepEqual(commentMarkers(`${fence}diff\n${lines}\n${fence}`), []);
    assert.deepEqual(commentMarkers(`${fence}diff\n${lines}`), []);
  }
  assert.deepEqual(commentMarkers(markers.map(marker => `quoted ${marker} text`).join('\n')), []);
  assert.deepEqual(commentMarkers(markers.map(marker => `+${marker}`).join('\n')), []);
  assert.deepEqual(commentMarkers(markers.map(marker => `> ${marker}`).join('\n')), []);
  assert.deepEqual(commentMarkers(markers.join(' ')), []);
  assert.deepEqual(commentMarkers('````diff\n```\n' + lines + '\n```\n````'), []);
  assert.deepEqual(commentMarkers('```diff\n```text\n' + lines + '\n```'), []);
  assert.deepEqual(commentMarkers('```diff\n~~~\n' + lines + '\n```'), []);
  assert.deepEqual(commentMarkers('```diff\n' + lines + '\n```\n' + markers.map(marker => ` \t${marker} \t`).join('\r\n')), markers);
});

test('quoted markers cannot claim work, reserve capacity or suppress waiting and invalid comments', { timeout: 10_000 }, async t => {
  for (const quote of [(text: string) => `\`\`\`\`diff\n${text}\n\`\`\`\``, (text: string) => text.split('\n').map(line => `quoted ${line} text`).join('\n')]) {
    const quoted = { body: quote([
      '<!-- factory-dispatch:claim runner:gpu -->',
      `<!-- factory-dispatch:thread ${threadId} runner:gpu -->`,
      '<!-- factory-dispatch:waiting -->', '<!-- factory-dispatch:invalid -->',
    ].join('\n')), createdAt: '2026-10-10T12:00:00.000Z' };
    const ghost = issue(100, { labels: [], comments: [quoted] });
    const blocked = issue(101, { comments: [quoted], inverseRelations: [
      { type: 'blocks', issue: { identifier: 'MET-10', state: { type: 'started' } } },
    ] });
    const invalid = issue(102, { comments: [quoted], description: body.replace('Ship the widget.', '> hint') });
    const ready = issue(123, { comments: [quoted] });
    const f = await fixture(t, [ghost, blocked, invalid, ready]);
    const result = await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '1' });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(f.calls().length, 1);
    assert.equal(f.calls()[0][f.calls()[0].indexOf('--executor') + 1], 'runner:factory-gpu');
    assert.equal(ready.stateId, 'started-id');
    assert.match(blocked.comments.at(-1).body, /^Waiting on MET-10\n\n<!-- factory-dispatch:waiting -->$/);
    assert.match(invalid.comments.at(-1).body, /^Cannot dispatch:/);
    assert.equal(ghost.comments.length, 1);
    for (const mutation of f.mutations.filter(m => m.operation === 'Comment')) {
      assert.ok(commentMarkers(mutation.input.body).length > 0, mutation.input.body);
    }
  }
});

test('quoted diff markers cannot suppress wrap-up or archive or replace their claim, thread and worktree', { timeout: 10_000 }, async t => {
  const quotedMarkers = [
    '<!-- factory-dispatch:claim runner:console -->',
    '<!-- factory-dispatch:thread T-01234567-89ab-4cde-8fab-999999999999 runner:console -->',
    '<!-- factory-dispatch:worktree met-123-quoted-worktree -->',
    ...['waiting', 'invalid', 'wrapup-claim', 'wrapup', 'wrapup-done', 'archive-claim', 'archived']
      .map(name => `<!-- factory-dispatch:${name} -->`),
    '<!-- factory-qa:passed -->', '<!-- factory-qa:failed -->',
  ];
  for (const quote of [(text: string) => `\`\`\`diff\n${text}\n\`\`\``, (text: string) => `\`\`\`\`diff\n\`\`\`\n${text}\n\`\`\`\n\`\`\`\``, (text: string) => text.split('\n').map(line => `quoted ${line} text`).join('\n')]) {
    const i = issue(123, { labels: [], state: { type: 'completed' }, attachments: [attachment('merged')], comments: [
      { body: quote(quotedMarkers.join('\n')), createdAt: '2026-10-11T12:00:00.000Z' },
      claimComment(), threadComment(), { body: ' \t<!-- factory-dispatch:worktree met-123-real-worktree --> \t' },
    ] });
    const f = await fixture(t, [i], { threads: [{ id: threadId, updated: quietUpdated, archived: false }] });
    const result = await f.run();
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(f.calls()[0].slice(0, 4), ['threads', 'continue', threadId, '-ox']);
    assert.match(f.calls()[0][4], /worktree remove \/home\/agent\/work\/factory-met-123-real-worktree/);
    assert.deepEqual(f.calls().at(-1), ['threads', 'archive', threadId]);
    assert.deepEqual(f.mutations.map(m => m.input.body.split('\n').at(-1)), [
      '<!-- factory-dispatch:wrapup-claim -->', '<!-- factory-dispatch:wrapup -->',
      '<!-- factory-dispatch:archive-claim -->', '<!-- factory-dispatch:archived -->',
    ]);
    for (const mutation of f.mutations) assert.equal(commentMarkers(mutation.input.body).length, 1);
    await f.run();
    assert.equal(f.calls().length, 3);
  }
});

test('blocked: one waiting comment; all blockers must complete or cancel before next-pass dispatch', { timeout: 10_000 }, async t => {
  const blocked = issue(123, { inverseRelations: [
    { type: 'blocks', issue: { identifier: 'MET-10', state: { type: 'started' } } },
    { type: 'blocks', issue: { identifier: 'MET-11', state: { type: 'unstarted' } } },
    { type: 'related', issue: { identifier: 'MET-12', state: { type: 'started' } } },
  ] });
  const f = await fixture(t, [blocked]);
  await f.run(); await f.run();
  assert.equal(blocked.comments.length, 1);
  assert.equal(blocked.comments[0].body, 'Waiting on MET-10, MET-11\n\n<!-- factory-dispatch:waiting -->');
  assert.equal(labeled(blocked), true);
  blocked.inverseRelations[0].issue.state.type = 'completed';
  await f.run();
  assert.equal(f.calls().length, 0);
  blocked.inverseRelations[1].issue.state.type = 'canceled';
  await f.run();
  assert.equal(f.calls().length, 1);
});

test('invalid and orb issues lose label with actionable reasons, without dispatch', { timeout: 10_000 }, async t => {
  const invalid = issue(123, { description: body.replace('Ship the widget.', '> only a hint'), labels: [{ ...dispatchLabel }] });
  const orb = issue(124); orb.labels.push(group('runner', 'orb'));
  const f = await fixture(t, [invalid, orb]);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.calls().length, 0);
  for (const i of f.issues) assert.equal(labeled(i), false);
  for (const reason of ['Empty required section: Goal', 'exactly one of Bug/Feature/Improvement', 'area:*']) assert.ok(invalid.comments[0].body.includes(reason));
  assert.match(orb.comments[0].body, /orb overflow not set up yet/);
});

test('per-runner cap includes claims; priority then age; completed wrap-ups release slots', { timeout: 10_000 }, async t => {
  const existing = issue(1, { labels: [], comments: [threadComment()] });
  const done = issue(2, { labels: [], comments: [threadComment(), { body: '<!-- factory-dispatch:wrapup -->' }] });
  const low = issue(3, { priority: 0, createdAt: '2020-01-01T00:00:00Z' });
  const later = issue(4, { priority: 1, createdAt: '2026-10-02T00:00:00Z' });
  const first = issue(5, { priority: 1 });
  for (const i of [low, later, first]) i.labels.push(group('runner', 'gpu'));
  const consoleIssue = issue(6); consoleIssue.labels.push(group('runner', 'console'));
  const claimed = issue(7, { labels: [], comments: [{ body: '<!-- factory-dispatch:claim runner:gpu -->' }] });
  const f = await fixture(t, [low, later, existing, done, first, consoleIssue, claimed]);
  await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '3' });
  assert.deepEqual(f.calls().map(args => args[args.indexOf('--title') + 1].split(' — ')[0]), ['MET-5', 'MET-6']);
  assert.equal(labeled(low), true); assert.equal(labeled(later), true);
  assert.equal(low.comments.length, 0); assert.equal(later.comments.length, 0);
  await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '3' }); assert.equal(f.calls().length, 2);
});

test('crash after label removal has not submitted Amp; explicit retry may safely claim', { timeout: 10_000 }, async t => {
  const f = await fixture(t, [issue()], { crash: (op: string) => op === 'RemoveLabel' ? 'after' : false });
  assert.equal((await f.run()).signal, 'SIGKILL');
  assert.equal(f.calls().length, 0);
  assert.equal(labeled(f.issues[0]), false);
  await f.run();
  assert.equal(f.calls().length, 0);
  await f.run(['issue', 'MET-123']);
  await f.run(['issue', 'MET-123']);
  assert.equal(f.calls().length, 1);
});

for (const [name, crash] of [
  ['after claim before Amp', (op: string, v: any) => op === 'Comment' && v.input.body.includes('factory-dispatch:claim') ? 'after' : false],
  ['after Amp success before thread marker', (op: string, v: any) => op === 'Comment' && v.input.body.includes('factory-dispatch:thread') ? 'before' : false],
  ['after thread marker before state move', (op: string, v: any) => op === 'Comment' && v.input.body.includes('factory-dispatch:thread') ? 'after' : false],
] as const) {
  test(`crash ${name}: manual and relabeled retries never create a second thread`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, [issue()], { crash });
    assert.equal((await f.run()).signal, 'SIGKILL');
    const count = f.calls().length;
    assert.equal(count, name === 'after claim before Amp' ? 0 : 1);
    assert.equal(labeled(f.issues[0]), false);
    await f.run(['issue', 'MET-123']);
    f.issues[0].labels.push({ ...dispatchLabel });
    await f.run();
    assert.equal(f.calls().length, count);
  });
}

test('manual issue without dispatch label still validates, claims and dispatches', { timeout: 10_000 }, async t => {
  const i = issue(); i.labels = i.labels.filter(label => label.name !== 'dispatch');
  const f = await fixture(t, [i]);
  assert.equal((await f.run(['issue', 'MET-123'])).code, 0);
  await f.run(['issue', 'MET-123']);
  assert.equal(f.calls().length, 1);
  assert.equal(f.mutations[0].operation, 'Comment');
});

for (const environment of [{ FAKE_FAIL: '1' }, { FAKE_NO_ID: '1' }]) {
  test(`Amp failure ${Object.keys(environment)[0]}: label off, no state move, no retry or secrets`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const result = await f.run(['poll'], environment);
    assert.equal(result.code, 0);
    assert.equal(labeled(f.issues[0]), false);
    assert.equal(f.issues[0].stateId, undefined);
    assert.match(f.issues[0].comments.at(-1).body, /Automatic retry is disabled|automatic retry is disabled/);
    assert.ok(!JSON.stringify([result, f.issues[0].comments]).includes(key));
    await f.run(['issue', 'MET-123']);
    assert.equal(f.calls().length, 1);
  });
}

test('wrap-up only after merged GitHub attachment, sent once to existing thread', { timeout: 10_000 }, async t => {
  const i = issue(123, { labels: [], comments: [claimComment(), threadComment(), { body: '<!-- factory-dispatch:worktree met-123-build-the-useful-widget -->' }], attachments: [attachment('open')] });
  const f = await fixture(t, [i]);
  await f.run(); i.attachments[0].metadata.status = 'closed'; await f.run();
  assert.equal(f.calls().length, 0);
  i.title = 'Renamed after dispatch';
  i.attachments[0].metadata.status = 'merged';
  await f.run(); await f.run();
  assert.equal(f.calls().length, 1);
  const args = f.calls()[0];
  assert.deepEqual(args.slice(0, 4), ['threads', 'continue', threadId, '-ox']);
  assert.match(args[4], /^export GH_TOKEN="\$AGENT_GH_TOKEN" && gh auth setup-git/);
  assert.match(args[4], /Confirm the linked PR.*is merged/);
  assert.match(args[4], /Never deploy/);
  assert.match(args[4], /worktree remove \/home\/agent\/work\/factory-met-123-build-the-useful-widget/);
  for (const text of [
    'Use the already-connected Linear MCP server', 'report their names without calling a write tool first',
    'If unavailable, stop and report', 'do not work around it or change MCP settings',
    'read issues, comment progress on your own issue MET-123, link your PR',
    'create follow-up issues in Backlog related to MET-123',
    "Never change any existing issue's status, labels, assignee or priority; never edit other issues",
    'Backlog is allowed only when creating a follow-up',
    'Never write or delete <!-- factory-dispatch:… --> or <!-- factory-qa:… --> markers except the completion marker explicitly authorized below',
    'Never include secrets or production data',
    'Only after all wrap-up steps succeed, post a Linear comment on MET-123',
    'the sole marker exception; not deployment verification',
  ]) assert.ok(args[4].includes(text), text);
  assert.match(args[4], /Wrap-up finished\n\n<!-- factory-dispatch:wrapup-done -->$/);
  assert.equal(i.comments.some((c: any) => c.body.includes('<!-- factory-dispatch:wrapup-done -->')), false);
  assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:wrapup -->')).length, 1);
});

test('old merged PR cannot wrap up new work; the post-claim PR merging sends exactly once', { timeout: 10_000 }, async t => {
  const oldPR = { ...attachment('merged'), url: 'https://github.com/Metacomet-Technologies/factory/pull/89', createdAt: '2026-10-10T11:59:59.999Z' };
  const newPR = attachment('open');
  const i = issue(123, { labels: [], comments: [claimComment(), { ...threadComment(), createdAt: '2026-10-10T12:00:01.000Z' }], attachments: [oldPR, newPR] });
  const f = await fixture(t, [i]);
  await f.run(); await f.run();
  assert.equal(f.calls().length, 0);
  assert.equal(f.mutations.length, 0);
  newPR.metadata.status = 'merged';
  await f.run(); await f.run();
  assert.equal(f.calls().length, 1);
  assert.deepEqual(f.calls()[0].slice(0, 4), ['threads', 'continue', threadId, '-ox']);
  assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:wrapup -->')).length, 1);
});

test('wrap-up requires a known claim timestamp and an attachment strictly later than it', { timeout: 10_000 }, async t => {
  for (const comments of [[claimComment(), threadComment()], [threadComment()], [{ ...claimComment(), createdAt: undefined }, threadComment()]]) {
    const i = issue(123, { labels: [], comments, attachments: [{ ...attachment('merged'), createdAt: '2026-10-10T08:00:00-04:00' }] });
    const f = await fixture(t, [i]);
    assert.equal((await f.run()).code, 0);
    assert.equal(f.calls().length, 0);
    assert.equal(f.mutations.length, 0);
  }
});

test('wrap-up crash after Amp success does not send twice', { timeout: 10_000 }, async t => {
  const i = issue(123, { labels: [], comments: [claimComment(), threadComment()], attachments: [attachment('merged')] });
  const f = await fixture(t, [i], { crash: (op: string, v: any) => op === 'Comment' && v.input.body.includes('<!-- factory-dispatch:wrapup -->') ? 'before' : false });
  assert.equal((await f.run()).signal, 'SIGKILL');
  await f.run();
  assert.equal(f.calls().length, 1);
  assert.equal(i.comments.some((c: any) => c.body.includes('<!-- factory-dispatch:wrapup -->')), false);
});

test('failed wrap-up is claimed, reported, and never automatically retried', { timeout: 10_000 }, async t => {
  const i = issue(123, { labels: [], comments: [claimComment(), threadComment()], attachments: [attachment('merged')] });
  const f = await fixture(t, [i]);
  await f.run(['poll'], { FAKE_FAIL: '1' });
  await f.run();
  assert.equal(f.calls().length, 1);
  assert.match(i.comments.at(-1).body, /Wrap-up submission failed/);
  assert.equal(i.comments.some((c: any) => c.body.includes('<!-- factory-dispatch:wrapup -->')), false);
});

test('all engine/effort mappings and runner configuration reach exact Amp argv', { timeout: 15_000 }, async t => {
  const expected = { amp: ['low', 'medium', 'high'], claude: ['external-agent:claude-code', 'external-agent:claude-code', 'external-agent:claude-code'], chatgpt: ['gpt56l', 'gpt61s', 'gpt61s'] };
  const issues: any[] = [];
  for (const engine of Object.keys(expected)) for (const effort of ['low', 'medium', 'high']) {
    const i = issue(100 + issues.length);
    i.labels.push(group('engine', engine), group('agent-effort', effort), group('runner', 'console'));
    issues.push(i);
  }
  const f = await fixture(t, issues);
  assert.equal((await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '9', DISPATCH_RUNNERS: 'gpu=gpu-id,console=console-id' })).code, 0);
  assert.deepEqual(f.calls().map(args => args[args.indexOf('--mode') + 1]), Object.values(expected).flat());
  for (const args of f.calls()) assert.equal(args[args.indexOf('--executor') + 1], 'runner:console-id');
});

test('dry-run prints decisions/commands/mutations, never prompts, secrets, Amp calls or writes', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const before = structuredClone(f.issues);
  const lockMtime = statSync(join(f.directory, 'lock')).mtimeMs;
  const result = await f.run(['poll', '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.issues, before);
  assert.equal(f.mutations.length, 0); assert.equal(f.calls().length, 0);
  assert.equal(statSync(join(f.directory, 'lock')).mtimeMs, lockMtime);
  assert.match(result.stdout, /would-run.*--no-archive-after-execute/);
  assert.match(result.stdout, /would-mutate.*issueRemoveLabel/);
  assert.match(result.stdout, /would-mutate.*stateId/);
  assert.ok(!result.stdout.includes('Ship the widget'));
  assert.ok(!result.stdout.includes(key));
});

test('flock serializes simultaneous poll and manual issue through Amp and final mutation', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.run(['poll'], { FAKE_DELAY: '1' }), f.run(['issue', 'MET-123'], { FAKE_DELAY: '1' })]);
  assert.deepEqual(results.map(result => result.code), [0, 0]);
  assert.equal(f.calls().length, 1);
});

test('pagination preserves later blockers, labels, thread markers and merged attachments', { timeout: 10_000 }, async t => {
  const blocked = issue(123, { inverseRelations: [{ type: 'related', issue: { identifier: 'MET-1', state: { type: 'completed' } } }, { type: 'blocks', issue: { identifier: 'MET-2', state: { type: 'started' } } }] });
  const wrapping = issue(124, { labels: [], comments: [{ body: 'ordinary comment' }, claimComment(), threadComment()], attachments: [attachment('closed'), attachment('merged')] });
  const f = await fixture(t, [blocked, wrapping], { pageSize: 1 });
  assert.equal((await f.run()).code, 0);
  assert.equal(labeled(blocked), true);
  assert.equal(f.calls().length, 1);
  assert.equal(f.calls()[0][0], 'threads');
  assert.ok(f.queries.some(q => q.operation === 'Queue' && q.after === '1'));
});

test('GraphQL errors and rejected claim mutations stop before Amp', { timeout: 10_000 }, async t => {
  for (const options of [{ graphqlError: true }, { invalidJSON: true }, { rejectMutation: 'Comment' }]) {
    const f = await fixture(t, [issue()], options);
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.equal(f.calls().length, 0);
    assert.ok(!(result.stderr + result.stdout).includes(key));
  }
});

test('slug boundaries, hint stripping, required sections and strict merge predicate', () => {
  assert.equal(slug('MET-9', '  Hello, WORLD! third fourth fifth '), 'met-9-hello-world-third-fourth');
  assert.equal(slug('MET-123', 'Café naïve 東京 API fifth'), 'met-123-caf-na-ve-api');
  assert.equal(slug('MET-1', 'x'.repeat(80)), 'met-1-' + 'x'.repeat(34));
  assert.equal(slug('MET-1', '!!!'), 'met-1');
  assert.equal(slug('MET-1', 'a'.repeat(33) + ' - later'), 'met-1-' + 'a'.repeat(33));
  assert.equal(sections('## Goal\r\n> hint\r\n  > hint\r\n').Goal, '');
  assert.equal(sections('## Build\n```sh\n## Goal\necho ok\n```').Build, '```sh\n## Goal\necho ok\n```');
  for (const name of ['Goal', 'Context', 'Isolation', 'Build', 'Sandbox check', 'Done means']) {
    const i = issue(123, { description: body.replace(new RegExp(`(## ${name}\\n)[\\s\\S]*?(?=\\n## |$)`), '$1> hint') });
    assert.ok(validate(i).errors.includes(`Empty required section: ${name}`), name);
  }
  assert.match(prompt(issue()), /## Link type\ncontributes/);
  assert.match(prompt(issue(123, { description: body.replace('> Defaults to contributes.', 'closes') })), /Closes MET-123/);
  assert.equal(isMergedGitHubPR(attachment('merged')), true);
  for (const value of [attachment('closed'), { ...attachment('merged'), url: 'https://github.com/a/b/issues/1' }, { ...attachment('merged'), url: 'https://github.com.evil/a/b/pull/1' }, { ...attachment('merged'), metadata: { merged: true } }]) assert.equal(isMergedGitHubPR(value), false);
});

test('unlabeled queue fills gpu then console, records overflow, then waits without comments', { timeout: 10_000 }, async t => {
  const issues = Array.from({ length: 5 }, (_, n) => issue(100 + n));
  const f = await fixture(t, issues);
  const result = await f.run();
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(f.calls().map(args => args[args.indexOf('--executor') + 1]), ['runner:factory-gpu', 'runner:factory-gpu', 'runner:factory-console', 'runner:factory-console']);
  for (const [n, args] of f.calls().entries()) {
    const runner = n < 2 ? 'gpu' : 'console';
    assert.ok(args[1].includes(`Runner: factory-${runner}.`));
    assert.ok(issues[n].comments.some((c: any) => c.body.includes(`<!-- factory-dispatch:claim runner:${runner} -->`)));
    assert.ok(issues[n].comments.some((c: any) => c.body.includes(`<!-- factory-dispatch:thread ${threadId} runner:${runner} -->`)));
    assert.equal(issues[n].comments[0].body.includes('(overflow)'), n >= 2);
  }
  assert.equal(labeled(issues[4]), true);
  assert.equal(issues[4].comments.length, 0);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.calls().length, 4);
  assert.equal(issues[4].comments.length, 0);
  t.diagnostic(`overflow poll: ${result.durationMs.toFixed(1)} ms`);
});

test('explicit grouped and flat runner labels never overflow even with spare peer capacity', { timeout: 10_000 }, async t => {
  for (const runner of ['gpu', 'console']) for (const label of [group('runner', runner), { id: 'runner', name: `runner/${runner}` }]) {
    const i = issue(); i.labels.push(label);
    const f = await fixture(t, [issue(1, { labels: [], comments: [threadComment(runner)] }), i]);
    assert.equal((await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '1' })).code, 0);
    assert.equal(f.calls().length, 0);
    assert.equal(labeled(i), true);
    assert.equal(i.comments.length, 0);
  }
});

test('Done archive waits until exactly five quiet minutes from Amp updated, then happens once', { timeout: 10_000 }, async t => {
  const i = archivable();
  const f = await fixture(t, [i], { pageSize: 1 });
  const early = await f.run(['poll'], { FAKE_NOW: String(now - 1) });
  assert.equal(early.code, 0);
  assert.match(early.stdout, /"decision":"archive-pending"/);
  assert.equal(f.calls().filter(args => args[1] === 'archive').length, 0);
  assert.equal(f.mutations.length, 0);
  const eligible = await f.run();
  assert.equal(eligible.code, 0, eligible.stdout);
  assert.match(eligible.stdout, /"decision":"archived"/);
  assert.equal(f.threads()[0].archived, true);
  assert.equal(archived(i), true);
  assert.equal(i.comments.at(-1).body, 'Thread archived.\n\n<!-- factory-dispatch:archived -->');
  const again = await f.run(['poll'], { FAKE_NOW: String(now + 1) });
  assert.equal(again.code, 0);
  assert.deepEqual(f.calls().filter(args => args[1] === 'archive'), [['threads', 'archive', 'T-01234567-89ab-4cde-8fab-000000000123']]);
  assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:archived -->')).length, 1);
  t.diagnostic(`archive polls: 4:59.999=${early.durationMs.toFixed(1)} ms; 5:00.000=${eligible.durationMs.toFixed(1)} ms; repeat=${again.durationMs.toFixed(1)} ms`);
});

test('archive skips canceled, non-Done, missing wrap-up or thread', { timeout: 10_000 }, async t => {
  const issues = Array.from({ length: 4 }, (_, n) => archivable(100 + n));
  issues[0].state = { type: 'canceled', name: 'Done' };
  issues[1].state = { type: 'started', name: 'Done' };
  issues[2].comments.pop();
  issues[3].comments.shift();
  const f = await fixture(t, issues);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.calls().length, 0);
  assert.equal(f.mutations.length, 0);
});

test('updating threads stay pending regardless of wrap-up age; unreadable timestamps never archive', { timeout: 10_000 }, async t => {
  const i = archivable();
  i.comments[1].createdAt = '2020-01-01T00:00:00Z';
  const f = await fixture(t, [i]);
  for (const elapsed of [0, 60_000, 10 * 60_000]) {
    f.setThreads([{ ...f.threads()[0], updated: new Date(now + elapsed - 1000).toISOString() }]);
    const result = await f.run(['poll'], { FAKE_NOW: String(now + elapsed) });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /"decision":"archive-pending"/);
  }
  for (const updated of [undefined, null, 0, 'invalid', new Date(now + 1).toISOString()]) {
    f.setThreads([{ ...f.threads()[0], updated }]);
    const result = await f.run();
    assert.equal(result.code, 0);
    assert.match(result.stdout, /"decision":"archive-pending"/);
  }
  assert.equal(f.mutations.length, 0);
  assert.equal(f.calls().filter(args => args[1] === 'archive').length, 0);
  f.setThreads([{ ...f.threads()[0], updated: quietUpdated }]);
  assert.equal((await f.run()).code, 0);
  assert.equal(archived(i), true);
});

test('archive failure logs error, keeps claim without completion marker, and retries next pass', { timeout: 10_000 }, async t => {
  const i = archivable();
  const f = await fixture(t, [i]);
  const failed = await f.run(['poll'], { FAKE_ARCHIVE_FAIL: '1' });
  assert.equal(failed.code, 0);
  assert.match(failed.stdout, /"decision":"error".*"action":"archive"/);
  assert.equal(archived(i), false);
  assert.equal(f.threads()[0].archived, false);
  assert.equal((await f.run()).code, 0);
  assert.equal(archived(i), true);
  assert.equal(f.threads()[0].archived, true);
  assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:archive-claim -->')).length, 1);
  assert.equal(f.calls().filter(args => args[1] === 'archive').length, 2);
});

test('archive attempts are capped at five per pass, including failures', { timeout: 10_000 }, async t => {
  const issues = Array.from({ length: 7 }, (_, n) => archivable(100 + n));
  const f = await fixture(t, issues);
  assert.equal((await f.run(['poll'], { FAKE_ARCHIVE_FAIL: '1' })).code, 0);
  assert.equal(f.calls().filter(args => args[1] === 'archive').length, 5);
  assert.equal(issues.filter(archived).length, 0);
  assert.equal((await f.run()).code, 0);
  assert.equal(issues.filter(archived).length, 5);
  assert.equal(f.threads().filter((t: any) => t.archived).length, 5);
  assert.equal((await f.run()).code, 0);
  assert.equal(issues.filter(archived).length, 7);
  assert.equal(f.threads().filter((t: any) => t.archived).length, 7);
});

for (const [name, marker, boundary] of [
  ['before claim', 'archive-claim', 'before'],
  ['after claim', 'archive-claim', 'after'],
  ['after archive before marker', 'archived', 'before'],
  ['after marker', 'archived', 'after'],
]) {
  test(`archive crash ${name} recovers without a second archive command`, { timeout: 10_000 }, async t => {
    const i = archivable();
    const f = await fixture(t, [i], { crash: (op: string, v: any) => op === 'Comment' && v.input.body.includes(`<!-- factory-dispatch:${marker} -->`) ? boundary : false });
    assert.equal((await f.run()).signal, 'SIGKILL');
    assert.equal(f.threads()[0].archived, marker === 'archived');
    assert.equal((await f.run()).code, 0);
    assert.equal((await f.run()).code, 0);
    assert.equal(archived(i), true);
    assert.equal(f.threads()[0].archived, true);
    assert.equal(f.calls().filter(args => args[1] === 'archive').length, 1);
    assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:archive-claim -->')).length, 1);
    assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:archived -->')).length, 1);
  });
}

test('archive listings paginate and recognize already archived threads; missing or malformed results fail closed', { timeout: 10_000 }, async t => {
  for (const wasArchived of [false, true]) {
    const i = archivable();
    const threads = Array.from({ length: 100 }, (_, n) => ({ id: `other-${n}`, archived: false, updated: quietUpdated }));
    threads.push({ id: 'T-01234567-89ab-4cde-8fab-000000000123', archived: wasArchived, updated: quietUpdated });
    const f = await fixture(t, [i], { threads });
    assert.equal((await f.run()).code, 0);
    assert.equal(archived(i), true);
    assert.equal(f.threads().at(-1).archived, true);
    assert.equal(f.calls().filter(args => args[1] === 'archive').length, wasArchived ? 0 : 1);
  }
  for (const environment of [{}, { FAKE_BAD_LIST: key }, { FAKE_BAD_LIST: '{}' }, { FAKE_BAD_LIST: '[{}]' }, { FAKE_FAIL: '1' }]) {
    const i = archivable();
    const f = await fixture(t, [i], { threads: [] });
    const result = await f.run(['poll'], environment);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /"decision":"archive-pending"/);
    assert.ok(!result.stdout.includes(key));
    assert.equal(archived(i), false);
    assert.equal(f.calls().filter(args => args[1] === 'archive').length, 0);
    assert.equal(f.mutations.length, 0);
  }
});

test('archive dry-run previews conditional Amp commands without claiming quiet time, writes or Amp calls', { timeout: 10_000 }, async t => {
  const f = await fixture(t, [archivable()]);
  const before = structuredClone(f.issues);
  const result = await f.run(['poll', '--dry-run']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /would-run.*'threads' 'archive' 'T-/);
  assert.match(result.stdout, /"decision":"archive-pending".*quiet time not checked/);
  assert.ok(!result.stdout.includes('"decision":"archived"'));
  assert.deepEqual(f.issues, before);
  assert.equal(f.calls().length, 0);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.threads()[0].archived, false);
});
