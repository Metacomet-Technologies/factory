import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sections, slug, prompt, validate, isMergedGitHubPR, commentMarkers } from './dispatch.ts';
import { reviewerEngine } from './qa.ts';

const executable = fileURLToPath(new URL('dispatch.ts', import.meta.url));
const threadId = 'T-01234567-89ab-4cde-8fab-0123456789ab';
const reviewId = 'T-12345678-89ab-4cde-8fab-0123456789ab';
const sha = 'a'.repeat(40), nextSha = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const playbook = '# Synthetic playbook\n\nNo production data.\n';
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
const archived = (i: any) => i.comments.some((c: any) => commentMarkers(c.body).some(line => line.startsWith('<!-- factory-dispatch:archived thread:')));
const archivable = (n = 123) => issue(n, { labels: [], state: { type: 'completed' }, comments: [
  { body: `<!-- factory-dispatch:thread T-01234567-89ab-4cde-8fab-${String(n).padStart(12, '0')} runner:gpu -->` }, { body: '<!-- factory-dispatch:wrapup -->' },
] });

async function fixture(t: any, issues = [issue()], options: any = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'factory-dispatch-test-'));
  const callsFile = join(directory, 'amp-calls');
  const threadsFile = join(directory, 'amp-threads');
  const githubFile = join(directory, 'github');
  const worktreesFile = join(directory, 'worktrees');
  const eventsFile = join(directory, 'events');
  writeFileSync(worktreesFile, JSON.stringify(options.worktrees ?? { gpu: [], console: [] }));
  writeFileSync(eventsFile, '');
  writeFileSync(githubFile, JSON.stringify(options.github ?? {}));
  writeFileSync(threadsFile, JSON.stringify(options.threads ?? issues.flatMap(i => i.comments.flatMap((c: any) => {
    const id = c.body.match(/factory-dispatch:thread (T-[a-f0-9-]{36})/)?.[1];
    return id ? [{ id, archived: false, updated: quietUpdated }] : [];
  }))));
  writeFileSync(join(directory, 'clock.mjs'), `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Date.now = () => Number(process.env.FAKE_NOW);
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('Only loopback fetches are allowed in tests');
  return fetch(url, options);
};
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => path === '/home/agent/work/factory/docs/PLAYBOOK.md' ? ${JSON.stringify(playbook)} : read(path, ...args);
syncBuiltinESMExports();`);
  writeFileSync(join(directory, 'key'), key);
  writeFileSync(join(directory, 'lock'), '');
  writeFileSync(join(directory, 'ssh'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.slice(0, 7).join(' ') !== '-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes agent@factory-console') process.exit(99);
fs.appendFileSync(process.env.FAKE_EVENTS, JSON.stringify(['ssh', ...args]) + '\\n');
if (process.env.FAKE_SSH_FAIL || (process.env.FAKE_SSH_AFTER_PREFLIGHT && args[7] !== "'true'")) process.exit(255);
const result = spawnSync('/bin/sh', ['-c', 'exec ' + args[7]], { stdio: 'inherit', env: { ...process.env, FAKE_RUNNER: 'console' } });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  writeFileSync(join(directory, 'test'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const trees = JSON.parse(fs.readFileSync(process.env.FAKE_WORKTREES, 'utf8'))[process.env.FAKE_RUNNER ?? 'gpu'];
if (!['-e', '-L'].includes(args[0]) || !args[1].startsWith('/home/agent/work/factory-')) process.exit(99);
process.exit(process.env.FAKE_EXISTING_DIR || trees.some(t => t.path === args[1]) ? 0 : 1);
`, { mode: 0o755 });
  // No GitHub or Git command may escape to the network or the real main checkout.
  for (const program of ['gh', 'git']) writeFileSync(join(directory, program), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GITHUB, 'utf8'));
fs.appendFileSync(process.env.FAKE_GITHUB + '-calls', JSON.stringify(['${program}', ...args]) + '\\n');
fs.appendFileSync(process.env.FAKE_EVENTS, JSON.stringify(['${program}', process.env.FAKE_RUNNER ?? 'gpu', ...args]) + '\\n');
if (process.env.FAKE_GITHUB_FAIL) process.exit(7);
if ('${program}' === 'gh' && args[0] === 'api' && !args.includes('--paginate')) {
  if (process.env.GH_TOKEN || args[2] !== '--hostname' || args[3] !== 'github.com') process.exit(9);
  // Exercise the production gh argv without contacting GitHub or reading real credentials.
  return void fetch(process.env.FAKE_GITHUB_URL + '/' + args[1]).then(async response => {
    if (!response.ok) { console.error('${key} quota exhausted'); process.exit(7); }
    console.log(await response.text());
  }).catch(() => process.exit(7));
}
let output;
if ('${program}' === 'git' && args[0] === 'ls-remote') {
  const pr = args[2].match(/^refs\\/pull\\/(\\d+)\\/head$/)?.[1];
  if (!state[pr]) process.exit(7);
  output = (state[pr].remoteSha ?? state[pr].headRefOid) + '\\t' + args[2];
} else if ('${program}' === 'git' && args[0] === '-C' && args[1] === '/home/agent/work/factory') {
  const all = JSON.parse(fs.readFileSync(process.env.FAKE_WORKTREES, 'utf8'));
  const runner = process.env.FAKE_RUNNER ?? 'gpu';
  const trees = all[runner];
  if (args[2] === 'show-ref') process.exit(process.env.FAKE_EXISTING_BRANCH || trees.some(t => 'refs/heads/' + t.branch === args[5]) ? 0 : 1);
  else if (args[2] === 'fetch') { if (process.env.FAKE_FETCH_FAIL) process.exit(7); output = ''; }
  else if (args[2] === 'worktree') {
    const action = args[3], path = args.at(-1);
    if (action === 'list') output = trees.map(t => 'worktree ' + t.path + '\\nHEAD ${sha}\\n' + (t.branch ? 'branch refs/heads/' + t.branch : 'detached') + (t.locked ? '\\nlocked ' + t.locked : '') + '\\n').join('\\n');
    else if (action === 'add') {
      const path = args.at(-2);
      if (process.env.FAKE_ADD_FAIL || trees.some(t => t.path === path)) process.exit(7);
      trees.push({ path, branch: args.includes('-b') ? args[args.indexOf('-b') + 1] : undefined, locked: args.includes('--reason') ? args[args.indexOf('--reason') + 1] : undefined });
      fs.writeFileSync(process.env.FAKE_WORKTREES, JSON.stringify(all));
      if (process.env.FAKE_CRASH_AFTER_WORKTREE) process.kill(process.ppid, 'SIGKILL');
      output = '';
    } else {
      const tree = trees.find(t => t.path === path);
      if (!tree) process.exit(7);
      if (action === 'unlock') delete tree.locked;
      else if (action === 'lock') tree.locked = args[args.indexOf('--reason') + 1];
      else if (action === 'remove') {
        if (tree.dirty || tree.locked || process.env.FAKE_REMOVE_FAIL) process.exit(7);
        trees.splice(trees.indexOf(tree), 1);
      } else process.exit(99);
      fs.writeFileSync(process.env.FAKE_WORKTREES, JSON.stringify(all));
      output = '';
    }
  } else if (args[2] === 'branch') output = process.env.FAKE_BRANCH ?? 'main';
  else if (args[2] === 'status') output = process.env.FAKE_DIRTY ?? '';
  else if (args[2] === 'merge-base') { if (process.env.FAKE_BEHIND) process.exit(1); output = ''; }
  else if (args[2] === 'rev-parse') output = '${mergeSha}';
  else if (args[2] === 'show') output = ${JSON.stringify(playbook)};
} else if ('${program}' === 'gh' && args[0] === 'pr') {
  const pr = state[args[2]];
  if (!pr) process.exit(7);
  if (args[1] === 'view') output = JSON.stringify(pr);
  else if (args[1] === 'checks') {
    output = JSON.stringify(pr.checks);
    if (pr.pushDuringChecks) {
      pr.headRefOid = pr.pushDuringChecks;
      fs.writeFileSync(process.env.FAKE_GITHUB, JSON.stringify(state));
    }
    if (pr.checkExit) process.exit(pr.checkExit);
  }
} else if ('${program}' === 'gh' && args[0] === 'api') {
  const pr = args[1].match(/^repos\\/Metacomet-Technologies\\/factory\\/pulls\\/(\\d+)\\/files\\?per_page=100$/)?.[1];
  if (!state[pr] || !args.includes('--paginate') || !args.includes('--slurp')) process.exit(7);
  output = JSON.stringify(state[pr].pages ?? [state[pr].files]);
}
if (output === undefined) process.exit(99);
console.log(output);
`, { mode: 0o755 });
  writeFileSync(join(directory, 'amp'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\\n');
fs.appendFileSync(process.env.FAKE_EVENTS, JSON.stringify(['amp', ...args]) + '\\n');
if (args.includes('--project')) process.exit(99);
if (args[0] === '-x') {
  const runner = args[args.indexOf('--executor') + 1].includes('console') ? 'console' : 'gpu';
  const trees = JSON.parse(fs.readFileSync(process.env.FAKE_WORKTREES, 'utf8'))[runner];
  if (!trees.some(t => t.path === args[args.indexOf('--runner-dir') + 1])) process.exit(99);
}
if (process.env.FAKE_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
if (process.env.FAKE_FAIL) { console.error('${key} full prompt must not leak'); process.exit(7); }
if (args[0] === 'threads' && args[1] === 'label') {
  if (process.env.FAKE_LABEL_FAIL) process.exit(7);
  const threads = JSON.parse(fs.readFileSync(process.env.FAKE_THREADS, 'utf8'));
  const thread = threads.find(t => t.id === args[2]);
  if (!thread || thread.archived) process.exit(9);
  thread.labels = [...new Set([...(thread.labels ?? []), ...args.slice(3)])];
  fs.writeFileSync(process.env.FAKE_THREADS, JSON.stringify(threads));
  process.exit(0);
}
if (args[0] === 'threads' && args[1] === 'search') {
  if (process.env.FAKE_BAD_SEARCH) { console.log(process.env.FAKE_BAD_SEARCH); process.exit(0); }
  const threads = JSON.parse(fs.readFileSync(process.env.FAKE_THREADS, 'utf8'));
  if (Number(args.at(-1)) > 500) process.exit(99);
  console.log(JSON.stringify(threads.filter(t => t.labels?.includes(args[2].split(' ')[0].slice(6)) && !t.archived).slice(0, Number(args.at(-1))).map(t => ({ id: t.id, updatedAt: t.updated }))));
  process.exit(0);
}
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
const id = args[0] === '-x' && args[1].includes('— QA PR') ? '${reviewId}' : '${threadId}';
if (args[0] === '-x' && !process.env.FAKE_NO_ID) {
  const threads = JSON.parse(fs.readFileSync(process.env.FAKE_THREADS, 'utf8'));
  if (!threads.some(t => t.id === id)) threads.push({ id, archived: false, updated: new Date(Number(process.env.FAKE_NOW)).toISOString() });
  fs.writeFileSync(process.env.FAKE_THREADS, JSON.stringify(threads));
}
console.log(process.env.FAKE_NO_ID ? 'submitted without id' : 'https://ampcode.com/threads/' + id);
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
      if (request.url?.startsWith('/repos/Metacomet-Technologies/factory/')) {
        assert.equal(request.headers.authorization, undefined);
        const path = request.url.slice('/repos/Metacomet-Technologies/factory/'.length);
        const github = JSON.parse(readFileSync(githubFile, 'utf8'));
        const prNumber = path.match(/^pulls\/(\d+)/)?.[1];
        const pr = prNumber ? github[prNumber] : Object.values(github).find((p: any) => path.startsWith(`commits/${p.headRefOid}/`)) as any;
        if (!pr || pr.publicFail || (pr.checkExit && path.includes('/check-runs'))) { response.statusCode = 503; response.end('{}'); return; }
        if (path === pr.quotaPath) { response.statusCode = 429; response.end('{}'); return; }
        let data;
        if (/^pulls\/\d+$/.test(path)) data = { state: pr.state === 'MERGED' ? 'closed' : pr.state.toLowerCase(), merged: pr.state === 'MERGED', draft: pr.isDraft,
          head: { sha: pr.headRefOid }, base: { ref: pr.baseRefName }, merge_commit_sha: pr.mergeCommit?.oid };
        else if (path.includes('/files?')) {
          const pageNumber = Number(new URL(request.url, 'http://fake').searchParams.get('page'));
          data = (pr.pages?.flat() ?? pr.files).slice((pageNumber - 1) * 100, pageNumber * 100);
        } else if (path.includes('/check-runs?')) {
          const checks = pr.checks.map((c: any) => ({ name: c.name, status: c.bucket === 'pending' ? 'in_progress' : 'completed', conclusion: c.bucket === 'pass' ? 'success' : c.bucket }));
          data = { total_count: pr.checkTotal ?? checks.length, check_runs: checks };
          if (pr.pushDuringChecks) { pr.headRefOid = pr.pushDuringChecks; writeFileSync(githubFile, JSON.stringify(github)); }
        } else if (path.includes('/status?')) data = { total_count: pr.statuses?.length ?? 0, statuses: pr.statuses ?? [] };
        else throw new Error(`Unexpected public GitHub path ${path}`);
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(data)); return;
      }
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
        if (operation === 'Comment') {
          i.comments.push({ body: v.input.body, createdAt: new Date().toISOString() });
          writeFileSync(eventsFile, JSON.stringify(['comment', v.input.body]) + '\n', { flag: 'a' });
          data = { commentCreate: { success: true } };
        }
        else if (operation === 'RemoveLabel') { i.labels = i.labels.filter((label: any) => label.id !== v.labelId); data = { issueRemoveLabel: { success: true } }; }
        else if (operation === 'Move') { i.stateId = v.input.stateId; data = { issueUpdate: { success: true } }; }
        else if (operation === 'SyncPlaybook') { data = { documentUpdate: { success: true } }; }
        else throw new Error(`Unexpected mutation ${operation}`);
        if (crashHere === 'after') { crash = null; current.kill('SIGKILL'); response.destroy(); return; }
      } else {
        queries.push({ operation, query, ...v });
        if (options.graphqlError) { response.end(JSON.stringify({ errors: [{ message: key }] })); return; }
        if (options.invalidJSON) { response.end(`not JSON: ${key}`); return; }
        if (operation === 'Queue') {
          assert.match(query, /team \{ id key \} state \{ type \}/);
          assert.deepEqual(v.filter, { team: { key: { eq: 'MET' } }, or: [{ labels: { some: { name: { eq: 'dispatch' } } } }, { comments: { some: { body: { contains: '<!-- factory-dispatch:' } } } }, { comments: { some: { body: { contains: '<!-- factory-qa:' } } } }] });
          const selected = issues.filter(i => i.team.key === 'MET' && (labeled(i) || i.comments.some((c: any) => /<!-- factory-(?:dispatch|qa):/.test(c.body))));
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
  function run(args = ['poll'], environment: any = {}, script = executable) {
    const started = performance.now();
    const child = spawn(process.execPath, ['--import', join(directory, 'clock.mjs'), script, ...args], { env: {
      PATH: `${directory}:/usr/bin:/bin`, HOME: directory, LINEAR_API_KEY_FILE: join(directory, 'key'),
      DISPATCH_LOCK_FILE: join(directory, 'lock'), DISPATCH_LINEAR_URL: `http://127.0.0.1:${(server.address() as any).port}/graphql`,
      DISPATCH_GITHUB_URL: `http://127.0.0.1:${(server.address() as any).port}`,
      FAKE_GITHUB_URL: `http://127.0.0.1:${(server.address() as any).port}`,
      FAKE_CALLS: callsFile, FAKE_THREADS: threadsFile, FAKE_GITHUB: githubFile, FAKE_NOW: String(now),
      FAKE_WORKTREES: worktreesFile, FAKE_EVENTS: eventsFile, ...environment,
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
  const allCalls = () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  // Existing lifecycle assertions exclude the independent label bookkeeping.
  // Label/group tests use allCalls and inspect the persisted threads.
  return { issues, get mutations() { return mutations.filter(m => !m.input?.body?.includes('<!-- factory-dispatch:labeled ')); },
    allCalls, queries, run, directory,
    check: (pr = '90', head = sha, env = {}) => run(['check', pr, head], env, fileURLToPath(new URL('qa.ts', import.meta.url))),
    setGitHub: (github: any) => writeFileSync(githubFile, JSON.stringify(github)),
    githubCalls: () => existsSync(githubFile + '-calls') ? readFileSync(githubFile + '-calls', 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    worktrees: () => JSON.parse(readFileSync(worktreesFile, 'utf8')),
    events: () => readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    threads: () => JSON.parse(readFileSync(threadsFile, 'utf8')),
    setThreads: (threads: any[]) => writeFileSync(threadsFile, JSON.stringify(threads)),
    calls: () => allCalls().filter(args => !['label', 'search'].includes(args[1]))
      .filter(args => !options.submissionsOnly || args[0] === '-x' || args[1] === 'continue') };
}

test('full fake-server poll: dispatch, prompt contract, Linear state, and manual/poll idempotency', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const [args] = f.calls();
  assert.equal(args[0], '-x');
  assert.deepEqual(args.slice(2), ['--mode', 'medium', '--executor', 'runner:factory-gpu', '--runner-dir', '/home/agent/work/factory-met-123-build-the-useful-widget', '--title', 'MET-123 — Build the useful widget today', '--visibility', 'private', '--no-archive-after-execute']);
  assert.equal(args[1].split('\n')[0], '**Thread title:** Use the Linear ticket identifier and title: `MET-123 — Build the useful widget today`.');
  assert.doesNotMatch(args[1], /GH_TOKEN/);
  assert.ok(args[1].includes("GitHub auth is preconfigured for agent (gh + git credential helper); don't set GitHub token environment variables or run gh auth commands. If `gh auth status` fails, stop and report."));
  assert.ok(args[1].includes("Push, open the PR. Then subscribe this thread to your PR's comments and reviews, and to CI for its exact head commit; after every later push, subscribe to CI for the new head commit. If subscribing fails, note the error in your final reply and continue; subscriptions are optional feedback."));
  for (const text of ['The dispatcher already created branch met-123-build-the-useful-widget', 'This thread starts inside that worktree', 'Work only in that worktree, never the main checkout', 'Contributes MET-123', 'cargo fmt --check', 'cargo clippy --all-targets -- -D warnings', 'cargo test --workspace', 'vp check', 'factory-ssh', 'console-ssh', 'Never deploy']) assert.ok(args[1].includes(text), text);
  assert.doesNotMatch(args[1], /worktree add|--project/);
  const events = f.events();
  const claimed = events.findIndex(e => e[0] === 'comment' && e[1].includes('factory-dispatch:claim'));
  const fetched = events.findIndex(e => e[0] === 'git' && e[4] === 'fetch');
  const added = events.findIndex(e => e[0] === 'git' && e[5] === 'add');
  assert.ok(claimed < fetched && fetched < added && added < events.findIndex(e => e[0] === 'amp'));
  assert.deepEqual(events[added], ['git', 'gpu', '-C', '/home/agent/work/factory', 'worktree', 'add', '-b', 'met-123-build-the-useful-widget', '/home/agent/work/factory-met-123-build-the-useful-widget', 'origin/main']);
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

test('worktree collisions and preparation failures comment, retain claims, and never launch or retry', { timeout: 15_000 }, async t => {
  for (const runner of ['gpu', 'console']) for (const failure of ['FAKE_EXISTING_BRANCH', 'FAKE_EXISTING_DIR', 'FAKE_FETCH_FAIL', 'FAKE_ADD_FAIL', ...(runner === 'console' ? ['FAKE_SSH_AFTER_PREFLIGHT'] : [])]) {
    const i = issue(); i.labels.push(group('runner', runner));
    const f = await fixture(t, [i]);
    const result = await f.run(['poll'], { [failure]: '1' });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(f.calls().length, 0, `${runner} ${failure}`);
    assert.match(i.comments.at(-1).body, /Worktree .*automatic retry is disabled/);
    if (failure.startsWith('FAKE_EXISTING')) assert.match(i.comments.at(-1).body, /already exists/);
    assert.equal(i.stateId, undefined);
    await f.run(['issue', 'MET-123']);
    assert.equal(f.calls().length, 0);
    assert.deepEqual(f.worktrees(), { gpu: [], console: [] });
  }
});

test('unreachable console preserves explicit and overflow builders without claims or cleanup noise', { timeout: 10_000 }, async t => {
  for (const explicit of [false, true]) {
    const busy = issue(1, { labels: [], comments: [threadComment()] });
    const pending = [issue(2), issue(3)];
    if (explicit) for (const i of pending) i.labels.push(group('runner', 'console'));
    const f = await fixture(t, [busy, ...pending]);
    for (let pass = 0; pass < 2; pass++) {
      const result = await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '1', FAKE_SSH_FAIL: '1' });
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.stdout.match(/"decision":"console-unavailable"/g)?.length, 1);
      assert.doesNotMatch(result.stdout, /qa-cleanup-pending/);
    }
    assert.equal(f.mutations.length, 0);
    assert.equal(f.calls().length, 0);
    assert.ok(pending.every(i => labeled(i) && i.comments.length === 0));
    assert.equal(f.events().filter(e => e[0] === 'ssh').length, 2);
    assert.ok(f.events().filter(e => e[0] === 'ssh').every(e => e.at(-1) === "'true'"));
    assert.equal((await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '1' })).code, 0);
    assert.equal(f.calls().length, 1);
    assert.equal(labeled(pending[0]), false);
    assert.equal(labeled(pending[1]), true);
    assert.equal(f.calls()[0][f.calls()[0].indexOf('--executor') + 1], 'runner:factory-console');
  }
});

test('crash after worktree creation leaves claim and checkout but never retries Amp', { timeout: 10_000 }, async t => {
  for (const i of [issue(), reviewable()]) {
    const f = await fixture(t, [i], { github: { 90: githubPR() } });
    assert.equal((await f.run(['poll'], { FAKE_CRASH_AFTER_WORKTREE: '1' })).signal, 'SIGKILL');
    assert.equal(f.calls().length, 0);
    assert.equal(f.worktrees().gpu.length, 1);
    await f.run(['issue', 'MET-123']);
    await f.run();
    assert.equal(f.calls().length, 0);
    assert.equal(f.worktrees().gpu.length, 1);
  }
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
      `<!-- factory-dispatch:archive-claim thread:${threadId} -->`, `<!-- factory-dispatch:archived thread:${threadId} -->`,
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
  assert.doesNotMatch(args[4], /GH_TOKEN/);
  assert.equal(args[4].split('\n')[0], "GitHub auth is preconfigured for agent (gh + git credential helper); don't set GitHub token environment variables or run gh auth commands. If `gh auth status` fails, stop and report.");
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
  assert.ok(i.comments.some((c: any) => /Wrap-up submission failed/.test(c.body)));
  assert.equal(i.comments.some((c: any) => c.body.includes('<!-- factory-dispatch:wrapup -->')), false);
});

test('all engine/effort mappings and runner configuration reach exact Amp argv', { timeout: 15_000 }, async t => {
  const expected = { amp: ['low', 'medium', 'high'], claude: ['external-agent:claude-code', 'external-agent:claude-code', 'external-agent:claude-code'], chatgpt: ['gpt56l', 'gpt61s', 'gpt61s'], ultra: ['ultra', 'ultra', 'ultra'] };
  const issues: any[] = [];
  for (const engine of Object.keys(expected)) for (const effort of ['low', 'medium', 'high']) {
    const i = issue(100 + issues.length);
    i.labels.push(effort === 'medium' ? { id: engine, name: `engine/${engine}` } : group('engine', engine), group('agent-effort', effort), group('runner', 'console'));
    issues.push(i);
  }
  const f = await fixture(t, issues);
  assert.equal((await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '12', DISPATCH_RUNNERS: 'gpu=gpu-id,console=console-id' })).code, 0);
  assert.deepEqual(f.calls().map(args => args[args.indexOf('--mode') + 1]), Object.values(expected).flat());
  for (const [n, args] of f.calls().entries()) {
    assert.equal(args[args.indexOf('--executor') + 1], 'runner:console-id');
    if (n >= 3 && n < 6) assert.deepEqual(args.slice(4, 6), ['--features', `model:claude-opus-5-5,effort:${['low', 'medium', 'high'][n - 3]}`]);
    else assert.ok(!args.includes('--features'));
    const claim = issues[n].comments.find((c: any) => c.body.includes('factory-dispatch:claim'));
    if (n >= 9) {
      assert.ok(claim.body.includes('\nEngine ultra: bills Amp credits (or OpenCode Go)\n'));
      assert.ok(claim.body.includes('agent-effort is ignored for ultra.'));
    } else assert.ok(!claim.body.includes('Engine ultra:'));
  }
});

test('Claude defaults to medium effort and invalid engine labels never launch', { timeout: 10_000 }, async t => {
  const claude = issue(100);
  claude.labels.push(group('engine', 'claude'));
  const invalid = issue(101);
  invalid.labels.push(group('engine', 'unknown'));
  const f = await fixture(t, [claude, invalid]);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.calls().length, 1);
  assert.deepEqual(f.calls()[0].slice(4, 6), ['--features', 'model:claude-opus-5-5,effort:medium']);
  assert.match(invalid.comments[0].body, /Invalid engine label/);
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
  assert.equal(i.comments.at(-1).body, 'Thread archived.\n\n<!-- factory-dispatch:archived thread:T-01234567-89ab-4cde-8fab-000000000123 -->');
  const again = await f.run(['poll'], { FAKE_NOW: String(now + 1) });
  assert.equal(again.code, 0);
  assert.deepEqual(f.calls().filter(args => args[1] === 'archive'), [['threads', 'archive', 'T-01234567-89ab-4cde-8fab-000000000123']]);
  assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:archived thread:')).length, 1);
  t.diagnostic(`archive polls: 4:59.999=${early.durationMs.toFixed(1)} ms; 5:00.000=${eligible.durationMs.toFixed(1)} ms; repeat=${again.durationMs.toFixed(1)} ms`);
});

test('archive skips canceled/non-Done builders and missing threads; Done no longer requires wrap-up', { timeout: 10_000 }, async t => {
  const issues = Array.from({ length: 4 }, (_, n) => archivable(100 + n));
  issues[0].state = { type: 'canceled', name: 'Done' };
  issues[1].state = { type: 'started', name: 'Done' };
  issues[2].comments.pop();
  issues[3].comments.shift();
  const f = await fixture(t, issues);
  assert.equal((await f.run()).code, 0);
  assert.deepEqual(f.calls().filter(args => args[1] === 'archive'), [['threads', 'archive', 'T-01234567-89ab-4cde-8fab-000000000102']]);
  assert.deepEqual(issues.map(archived), [false, false, true, false]);
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
  assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:archive-claim thread:')).length, 1);
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
    const f = await fixture(t, [i], { crash: (op: string, v: any) => op === 'Comment' && v.input.body.includes(`<!-- factory-dispatch:${marker} thread:`) ? boundary : false });
    assert.equal((await f.run()).signal, 'SIGKILL');
    assert.equal(f.threads()[0].archived, marker === 'archived');
    assert.equal((await f.run()).code, 0);
    assert.equal((await f.run()).code, 0);
    assert.equal(archived(i), true);
    assert.equal(f.threads()[0].archived, true);
    assert.equal(f.calls().filter(args => args[1] === 'archive').length, 1);
    assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:archive-claim thread:')).length, 1);
    assert.equal(i.comments.filter((c: any) => c.body.includes('<!-- factory-dispatch:archived thread:')).length, 1);
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

const githubPR = (overrides: any = {}) => ({ state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: sha,
  checks: ['rust', 'kiosk', 'scripts'].map(name => ({ name, bucket: 'pass' })),
  files: [{ filename: 'widgets/widget.rs', status: 'modified' }], ...overrides });
const reviewable = (n = 123) => issue(n, { labels: [], comments: [claimComment(), threadComment()], attachments: [attachment('open')] });
const qaMarker = (text: string) => ({ body: `<!-- factory-qa:${text} -->` });
function reviewed(value = 'ready', head = sha) {
  const i = reviewable();
  i.comments.push(qaMarker(`start pr:90 sha:${head} runner:gpu`), qaMarker(`review-claim pr:90 sha:${head} thread:${reviewId}`));
  i.comments.push({ body: `Findings for ${head}\n<!-- factory-qa:review pr:90 sha:${head} thread:${reviewId} verdict:${value} -->\n\n## Builder follow-up\nFix widgets/widget.rs boundary handling; run widget tests.` });
  return i;
}

test('finished QA reviews archive once; active and undelivered reviews remain open', { timeout: 20_000 }, async t => {
  for (const end of ['changes', 'human', 'retired', 'merged', 'completed', 'canceled', 'active', 'ready', 'undelivered']) {
    const i = reviewed(end === 'changes' || end === 'undelivered' ? 'changes' : 'ready');
    // No builder markers: retroactive QA discovery must work independently.
    i.comments.splice(0, 2);
    if (end === 'active') i.comments.pop();
    if (end === 'changes') i.comments.push(qaMarker(`round pr:90 sha:${sha}`));
    if (['human', 'retired'].includes(end)) i.comments.push(qaMarker(`${end} pr:90 sha:${sha}`));
    if (end === 'merged') i.attachments[0].metadata.status = 'merged';
    if (['completed', 'canceled'].includes(end)) i.state.type = end;
    const f = await fixture(t, [i], { threads: [{ id: reviewId, updated: quietUpdated, archived: false }] });
    const first = await f.run();
    assert.equal(first.code, 0, first.stdout);
    await f.run();
    const eligible = !['active', 'ready', 'undelivered'].includes(end);
    assert.equal(f.calls().filter(a => a[1] === 'archive').length, eligible ? 1 : 0, end);
    assert.equal(i.comments.filter((c: any) => c.body.includes(`factory-dispatch:archived thread:${reviewId}`)).length, eligible ? 1 : 0, end);
    t.diagnostic(`QA archive ${end}: ${first.durationMs.toFixed(1)} ms`);
  }
});

test('QA archiving shares the five-attempt budget with builders and enforces quiet time', { timeout: 10_000 }, async t => {
  const builders = Array.from({ length: 4 }, (_, n) => archivable(n + 1));
  const i = reviewed(); i.comments.splice(0, 2); i.state.type = 'canceled';
  const secondId = 'T-22345678-89ab-4cde-8fab-0123456789ab';
  i.comments.push(qaMarker(`review-claim pr:90 sha:${sha} round:2 thread:${secondId}`));
  const f = await fixture(t, [...builders, i]);
  f.setThreads([...f.threads(), { id: reviewId, updated: quietUpdated, archived: false },
    { id: secondId, updated: quietUpdated, archived: false }]);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.calls().filter(a => a[1] === 'archive').length, 5);
  f.setThreads(f.threads().map((entry: any) => entry.id === secondId ? { ...entry, updated: '2026-10-13T11:55:00.001Z' } : entry));
  await f.run();
  assert.equal(f.calls().filter(a => a[1] === 'archive').length, 5);
  f.setThreads(f.threads().map((entry: any) => ({ ...entry, updated: quietUpdated })));
  await f.run();
  assert.equal(f.calls().filter(a => a[1] === 'archive').length, 6);
  assert.ok(i.comments.some((c: any) => c.body.includes(`factory-dispatch:archived thread:${secondId}`)));
});

test('QA archive crash after Amp before marker repairs without a second archive', { timeout: 10_000 }, async t => {
  const i = reviewed(); i.comments.splice(0, 2); i.state.type = 'canceled';
  const f = await fixture(t, [i], { threads: [{ id: reviewId, updated: quietUpdated, archived: false }],
    crash: (operation: string, v: any) => operation === 'Comment' && v.input.body.includes(`factory-dispatch:archived thread:${reviewId}`) ? 'before' : null });
  assert.equal((await f.run()).signal, 'SIGKILL');
  assert.equal(f.threads()[0].archived, true);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.calls().filter(a => a[1] === 'archive').length, 1);
  assert.equal(i.comments.filter((c: any) => c.body.includes(`factory-dispatch:archive-claim thread:${reviewId}`)).length, 1);
  assert.equal(i.comments.filter((c: any) => c.body.includes(`factory-dispatch:archived thread:${reviewId}`)).length, 1);
});

test('same-SHA newer diff evidence starts exactly one fresh review, then stops after round two', { timeout: 10_000 }, async t => {
  const i = reviewed('changes');
  i.comments.at(-1).createdAt = '2026-10-13T11:00:00Z';
  const f = await fixture(t, [i], { github: { 90: githubPR() } });
  assert.equal((await f.run()).code, 0);
  const round = i.comments.find((c: any) => commentMarkers(c.body).includes(`<!-- factory-qa:round pr:90 sha:${sha} -->`));
  round.createdAt = '2026-10-13T11:02:00Z';
  const evidence = `PR: ${attachment('open').url}\nHead SHA: ${sha}\nComplete changed-file list:\n\`\`\`text\nwidgets/widget.rs\n\`\`\`\n\`\`\`diff\nEvidence fix, no push.\n\`\`\``;
  i.comments.push({ body: evidence, createdAt: '2026-10-13T10:59:59Z' });
  await f.run();
  assert.equal(f.calls().filter(a => a[0] === '-x').length, 0);
  i.comments.push({ body: evidence.replace(sha, nextSha), createdAt: '2026-10-13T11:03:00Z' });
  await f.run();
  assert.equal(f.calls().filter(a => a[0] === '-x').length, 0);
  i.comments.push({ body: evidence, createdAt: '2026-10-13T11:01:00Z' });
  await f.run();
  assert.equal(f.calls().filter(a => a[0] === '-x').length, 0, 'evidence predates delivery');
  i.comments.push({ body: evidence, createdAt: '2026-10-13T11:02:00Z' });
  await f.run();
  assert.equal(f.calls().filter(a => a[0] === '-x').length, 0, 'evidence equals delivery time');
  i.comments.push({ body: evidence, createdAt: '2026-10-13T11:02:00.001Z' });
  for (const timestamp of [undefined, 'invalid']) {
    round.createdAt = timestamp;
    await f.run();
    assert.equal(f.calls().filter(a => a[0] === '-x').length, 0, 'delivery timestamp is unknown');
  }
  round.createdAt = '2026-10-13T11:02:00Z';
  const rereview = await f.run();
  await f.run();
  const launches = f.calls().filter(a => a[0] === '-x');
  assert.equal(launches.length, 1);
  assert.ok(launches[0][1].includes(`factory-qa:review pr:90 sha:${sha} round:2 thread:T-REVIEW`));
  assert.ok(launches[0].includes('/home/agent/work/factory-qa-90-aaaaaaaaaaaa-round-2'));
  i.comments.push({ body: reviewed('changes').comments.at(-1).body.replace(`sha:${sha} thread:`, `sha:${sha} round:2 thread:`) });
  await f.run();
  i.comments.push({ body: evidence, createdAt: '2026-10-13T11:02:00Z' });
  await f.run();
  assert.equal(f.calls().filter(a => a[0] === '-x').length, 1);
  assert.equal(i.comments.filter((c: any) => c.body.includes('factory-qa:round ')).length, 2);
  assert.ok(i.comments.some((c: any) => c.body.includes('factory-qa:stopped pr:90')));
  assert.equal(f.worktrees().gpu.length, 0);
  t.diagnostic(`same-SHA evidence re-review: ${rereview.durationMs.toFixed(1)} ms`);
});

test('QA triggers once per head, sends each changes verdict directly, then stops after two rounds', { timeout: 10_000 }, async t => {
  const i = reviewable();
  const f = await fixture(t, [i], { github: { 90: githubPR() }, submissionsOnly: true });
  const initial = await f.run();
  assert.equal(initial.code, 0, initial.stdout);
  await f.run();
  assert.equal(f.calls().length, 1);
  assert.equal(f.calls()[0][0], '-x');
  assert.ok(f.calls()[0][1].includes(sha));
  const path = '/home/agent/work/factory-qa-90-aaaaaaaaaaaa';
  assert.equal(f.calls()[0][f.calls()[0].indexOf('--runner-dir') + 1], path);
  assert.ok(f.calls()[0][1].includes(`Set QA_BASE=${path}`));
  assert.doesNotMatch(f.calls()[0][1], /Clone https|temporary clone|worktree add|--project/);
  assert.deepEqual(f.worktrees().gpu, [{ path, locked: `factory-qa:${now}` }]);
  const events = f.events();
  const added = events.findIndex(e => e[0] === 'git' && e[5] === 'add');
  assert.ok(events.findIndex(e => e[0] === 'comment' && e[1].includes('factory-qa:start')) < added);
  assert.ok(added < events.findIndex(e => e[0] === 'amp'));
  assert.deepEqual(events[added], ['git', 'gpu', '-C', '/home/agent/work/factory', 'worktree', 'add', '--detach', '--lock', '--reason', `factory-qa:${now}`, path, 'origin/main']);
  assert.doesNotMatch(f.calls()[0][1], /GH_TOKEN|auth setup-git/);
  assert.ok(f.calls()[0][1].includes('GitHub auth is preconfigured for agent'));
  for (const text of ['Never edit code', 'Isolation, Build and Done means', 'PLAYBOOK.md §5', 'update_diff', 'GitHub PR comment', 'Do not merge now', 'your own actual Amp thread ID']) assert.ok(f.calls()[0][1].includes(text), text);
  i.comments.push(reviewed('changes').comments.at(-1));
  const changes = await f.run();
  assert.equal(changes.code, 0, changes.stdout);
  await f.run();
  assert.equal(f.calls().length, 2);
  assert.deepEqual(f.calls()[1].slice(0, 4), ['threads', 'continue', threadId, '-ox']);
  assert.ok(f.calls()[1][4].endsWith('Fix widgets/widget.rs boundary handling; run widget tests.'));
  assert.deepEqual(f.worktrees().gpu, []);
  f.setGitHub({ 90: githubPR({ headRefOid: nextSha }) });
  const push = await f.run();
  assert.equal(push.code, 0, push.stdout);
  assert.equal(f.calls().length, 3);
  assert.ok(f.calls()[2][1].includes(nextSha));
  i.comments.push(reviewed('changes', nextSha).comments.at(-1));
  await f.run();
  assert.equal(f.calls().length, 4);
  assert.ok(i.comments.some((c: any) => c.body.includes('two rounds without ready') && c.body.includes('https://linear.app/metacomet/profiles/devon ')));
  f.setGitHub({ 90: githubPR({ headRefOid: mergeSha }) });
  await f.run();
  assert.equal(f.calls().length, 4);
  assert.equal(i.comments.filter((c: any) => c.body.includes('factory-qa:round ')).length, 2);
  t.diagnostic(`QA fake polls: initial=${initial.durationMs.toFixed(1)} ms; changes=${changes.durationMs.toFixed(1)} ms; push=${push.durationMs.toFixed(1)} ms`);
});

test('QA refuses an existing worktree and reports preparation failure without retrying', { timeout: 10_000 }, async t => {
  for (const failure of ['FAKE_EXISTING_DIR', 'FAKE_FETCH_FAIL', 'FAKE_ADD_FAIL']) {
    const i = reviewable();
    const f = await fixture(t, [i], { github: { 90: githubPR() } });
    const result = await f.run(['poll'], { [failure]: '1' });
    assert.equal(result.code, 0, result.stdout);
    assert.ok(i.comments.some((c: any) => /Worktree .*QA start claim retained; automatic retry is disabled/.test(c.body)));
    await f.run();
    assert.equal(f.calls().length, 0);
    assert.deepEqual(f.worktrees(), { gpu: [], console: [] });
  }
});

test('QA removes completed and human-handoff worktrees, but retains pending and interrupted reviews', { timeout: 10_000 }, async t => {
  for (const end of ['merged', 'human', 'pending', 'interrupted']) {
    const i = reviewed();
    if (end === 'merged') i.attachments[0].metadata.status = 'merged';
    if (end === 'pending') i.comments.pop();
    if (end === 'interrupted') i.comments.splice(3);
    const tree = { path: '/home/agent/work/factory-qa-90-aaaaaaaaaaaa', locked: `factory-qa:${now - 25 * 60 * 60_000}` };
    const f = await fixture(t, [i], { worktrees: { gpu: [tree], console: [] }, github: { 90: githubPR({ files: [{ filename: 'scripts/dispatch/qa.ts' }] }) } });
    assert.equal((await f.run()).code, 0);
    assert.equal(f.worktrees().gpu.length, ['merged', 'human'].includes(end) ? 0 : 1, end);
  }
});

test('QA stale cleanup requires ownership and more than 24 hours, preserves dirty files, and bounds failed attempts', { timeout: 10_000 }, async t => {
  const tree = (n: number, age: number, extra = {}) => ({ path: `/home/agent/work/factory-qa-${n}-aaaaaaaaaaaa`, locked: `factory-qa:${now - age}`, ...extra });
  const day = 24 * 60 * 60_000;
  const protectedTrees = [tree(1, day), tree(2, day - 1), tree(3, day + 1, { locked: 'operator-owned' }), tree(4, day + 1, { locked: undefined })];
  const expired = Array.from({ length: 7 }, (_, n) => tree(10 + n, day + 1));
  const f = await fixture(t, [], { worktrees: { gpu: [...protectedTrees, ...expired.slice(0, 3)], console: expired.slice(3) } });
  assert.equal((await f.run(['poll', '--dry-run'])).code, 0);
  assert.equal(f.githubCalls().length, 0);
  assert.equal((await f.run(['poll'], { FAKE_REMOVE_FAIL: '1' })).code, 0);
  assert.equal(f.githubCalls().filter(a => a[3] === 'worktree' && a[4] === 'remove').length, 5);
  assert.equal(f.worktrees().gpu.length + f.worktrees().console.length, 11);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.worktrees().gpu.length + f.worktrees().console.length, 6);
  assert.equal((await f.run()).code, 0);
  assert.deepEqual(f.worktrees().gpu, JSON.parse(JSON.stringify(protectedTrees)));
  assert.deepEqual(f.worktrees().console, []);
  const dirty = tree(99, day + 1, { dirty: true });
  const d = await fixture(t, [], { worktrees: { gpu: [dirty], console: [] } });
  assert.equal((await d.run()).code, 0);
  assert.deepEqual(d.worktrees().gpu, [dirty]);
});

test('QA has one slot per runner independent of full builder capacity, and never consumes builder slots', { timeout: 10_000 }, async t => {
  const pending = [reviewable(1), reviewable(2), reviewable(3)];
  pending[1].comments[1] = threadComment('console');
  const f = await fixture(t, pending, { github: { 90: githubPR() } });
  const result = await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '1' });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(f.calls().map(a => a[a.indexOf('--executor') + 1]), ['runner:factory-gpu', 'runner:factory-console']);
  await f.run();
  assert.equal(f.calls().length, 2);
  assert.ok(!pending[2].comments.some((c: any) => c.body.includes('factory-qa:start ')));
  // Free builder slots but retain the two QA claims. New builders must still start.
  for (const i of pending) i.comments.push({ body: '<!-- factory-dispatch:wrapup -->' });
  pending.push(issue(4), issue(5));
  await f.run(['poll'], { DISPATCH_MAX_ACTIVE_PER_RUNNER: '1' });
  assert.equal(f.calls().filter(a => a[0] === '-x' && !a[1].includes('— QA PR')).length, 2);
});

test('unreachable console leaves QA unclaimed and retries on a later reachable pass', { timeout: 10_000 }, async t => {
  const busy = reviewable(1);
  busy.comments.push(qaMarker(`start pr:90 sha:${sha} runner:gpu`));
  const pending = reviewable(2);
  const f = await fixture(t, [busy, pending], { github: { 90: githubPR() } });
  const failed = await f.run(['poll'], { FAKE_SSH_FAIL: '1' });
  assert.equal(failed.code, 0, failed.stdout);
  assert.equal(failed.stdout.match(/"decision":"console-unavailable"/g)?.length, 1);
  assert.doesNotMatch(failed.stdout, /qa-cleanup-pending/);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.calls().length, 0);
  assert.ok(!pending.comments.some((c: any) => c.body.includes('factory-qa:start ')));
  assert.deepEqual(f.events().filter(e => e[0] === 'ssh').map(e => e.at(-1)), ["'true'"]);
  const recovered = await f.run();
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.equal(f.calls().length, 1);
  assert.equal(f.calls()[0][f.calls()[0].indexOf('--executor') + 1], 'runner:factory-console');
  assert.ok(pending.comments.some(c => c.body.includes(`factory-qa:start pr:90 sha:${sha} runner:console`)));
});

test('QA engine mapping uses grouped/flat builder engine labels, with Claude fallback', () => {
  for (const [engine, expected] of [['amp', 'claude'], ['chatgpt', 'claude'], ['ultra', 'claude'], ['claude', 'amp'], ['unknown', 'claude']]) {
    for (const label of [group('engine', engine), { id: engine, name: `engine/${engine}` }]) assert.equal(reviewerEngine(issue(1, { labels: [label] })), expected);
  }
  assert.equal(reviewerEngine(issue(1, { labels: [] })), 'claude');
});

test('QA launch uses high Claude features except for Claude builders, which get Amp high', { timeout: 10_000 }, async t => {
  for (const engine of ['amp', 'chatgpt', 'ultra', 'claude', 'unknown']) {
    const i = reviewable();
    i.labels.push(group('engine', engine));
    const f = await fixture(t, [i], { github: { 90: githubPR() } });
    assert.equal((await f.run()).code, 0);
    assert.equal(f.calls().length, 1);
    assert.deepEqual(f.calls()[0].slice(2, engine === 'claude' ? 4 : 6), engine === 'claude'
      ? ['--mode', 'high']
      : ['--mode', 'external-agent:claude-code', '--features', 'model:claude-opus-5-5,effort:high']);
    if (engine === 'claude') assert.ok(!f.calls()[0].includes('--features'));
  }
});

test('QA excludes drafts, old/equal attachments, foreign repos, mismatched heads and missing claims', { timeout: 10_000 }, async t => {
  for (const kind of ['draft', 'old', 'equal', 'foreign', 'mismatch', 'no-claim', 'closed']) {
    const i = reviewable();
    const pr = githubPR();
    if (kind === 'draft') pr.isDraft = true;
    if (kind === 'old') i.attachments[0].createdAt = '2020-01-01T00:00:00Z';
    if (kind === 'equal') i.attachments[0].createdAt = claimComment().createdAt;
    if (kind === 'foreign') i.attachments[0].url = 'https://github.com/other/repo/pull/90';
    if (kind === 'mismatch') pr.remoteSha = nextSha;
    if (kind === 'no-claim') i.comments.shift();
    if (kind === 'closed') pr.state = 'CLOSED';
    const f = await fixture(t, [i], { github: { 90: pr } });
    assert.equal((await f.run()).code, 0);
    assert.equal(f.calls().length, 0, kind);
    assert.equal(f.mutations.length, 0, kind);
  }
});

test('QA rejects fenced, inline, wrong-thread and conflicting verdicts; new head invalidates ready', { timeout: 10_000 }, async t => {
  for (const kind of ['fenced', 'inline', 'wrong-thread', 'conflicting', 'no-start']) {
    const i = reviewed();
    const c = i.comments.at(-1);
    if (kind === 'fenced') c.body = `\`\`\`\n${c.body}\n\`\`\``;
    if (kind === 'inline') c.body = c.body.replace('<!-- factory-qa:review ', 'quoted <!-- factory-qa:review ');
    if (kind === 'wrong-thread') c.body = c.body.replace(reviewId, threadId);
    if (kind === 'conflicting') i.comments.push(reviewed('changes').comments.at(-1));
    if (kind === 'no-start') i.comments.splice(2, 1);
    const f = await fixture(t, [i], { github: { 90: githubPR() } });
    await f.run();
    assert.equal(f.calls().filter(a => a[0] === 'threads').length, 0, kind);
  }
  const i = reviewed();
  const f = await fixture(t, [i], { github: { 90: githubPR({ headRefOid: nextSha }) }, submissionsOnly: true });
  await f.run(); await f.run();
  assert.equal(f.calls().length, 1);
  assert.equal(f.calls()[0][0], '-x');
  assert.ok(f.calls()[0][1].includes(nextSha));
});

test('QA ready authorizes only the reviewer; merge-time check independently rejects a later push', { timeout: 10_000 }, async t => {
  const i = reviewed();
  const f = await fixture(t, [i], { github: { 90: githubPR() } });
  const result = await f.run(['poll'], { DISPATCH_GITHUB_URL: undefined, AGENT_GH_TOKEN: key });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(f.calls().length, 1, 'authenticated reads must pass before the loopback-only repeat');
  await f.run();
  assert.equal(f.calls().length, 1);
  assert.deepEqual(f.calls()[0].slice(0, 4), ['threads', 'continue', reviewId, '-ox']);
  assert.ok(f.calls()[0][4].includes(`gh pr merge 90 --repo Metacomet-Technologies/factory --squash --match-head-commit ${sha}`));
  assert.ok(f.calls()[0][4].includes('inside Isolation'));
  assert.ok(f.calls()[0][4].includes('never tools from the PR'));
  assert.doesNotMatch(f.calls()[0][4], /GH_TOKEN|auth setup-git/);
  assert.ok(f.calls()[0][4].includes('GitHub auth is preconfigured for agent'));
  assert.equal((await f.check()).code, 0);
  f.setGitHub({ 90: githubPR({ headRefOid: nextSha }) });
  assert.equal((await f.check()).code, 1);
  assert.equal(f.githubCalls().some(a => a[0] === 'gh' && a[2] === 'merge'), false);
  t.diagnostic(`QA ready fake poll: ${result.durationMs.toFixed(1)} ms`);
});

test('QA merge gate refuses bad CI, skipped/missing checks, head races, drafts and unsafe file lists', { timeout: 20_000 }, async t => {
  const bad = [
    { checks: [] }, { checks: [{ name: 'rust', bucket: 'pass' }] },
    ...['pending', 'fail', 'skipping', 'cancel'].map(bucket => ({ checks: githubPR().checks.map((c: any) => c.name === 'scripts' ? { ...c, bucket } : c) })),
    { checkExit: 8 }, { pushDuringChecks: nextSha }, { remoteSha: nextSha },
    { isDraft: true }, { baseRefName: 'release' }, { files: [] },
    { files: [{ filename: 'docs/renamed.md', status: 'renamed' }] },
    { files: Array.from({ length: 3000 }, () => ({ filename: 'widgets/file.rs' })) },
  ];
  for (const overrides of bad) {
    const f = await fixture(t, [reviewed()], { github: { 90: githubPR(overrides) }, submissionsOnly: true });
    const result = await f.run();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(f.calls().length, 0, JSON.stringify(overrides).slice(0, 200));
    f.setGitHub({ 90: githubPR(overrides) });
    assert.equal((await f.check()).code, 1);
  }
  const f = await fixture(t, [reviewed()], { github: { 90: githubPR() } });
  assert.equal((await f.run()).code, 0);
  assert.equal(f.calls().length, 1);
});

test('QA self-deploying additions/deletions/renames on later file pages ping once, never merge', { timeout: 10_000 }, async t => {
  for (const path of ['scripts/dispatch/dispatch.ts', 'scripts/usage/collect.ts']) for (const status of ['modified', 'removed', 'renamed']) {
    const i = reviewed();
    const file = status === 'renamed' ? { filename: 'docs/moved.ts', previous_filename: path, status } : { filename: path, status };
    const f = await fixture(t, [i], { github: { 90: githubPR({ pages: [Array.from({ length: 100 }, (_, n) => ({ filename: `widgets/file${n}.rs` })), [file]] }) }, submissionsOnly: true });
    await f.run(); await f.run();
    assert.equal(f.calls().length, 0);
    assert.equal(i.comments.filter((c: any) => c.body.includes('ready; merging deploys it')).length, 1);
    assert.equal((await f.check()).code, 1);
  }
});

for (const step of ['start', 'review-claim', 'followup-claim', 'round', 'merge-claim', 'merge-sent', 'human', 'retired']) for (const boundary of ['before', 'after']) {
  test(`QA crash ${boundary} ${step} never duplicates submission`, { timeout: 10_000 }, async t => {
    const i = ['start', 'review-claim'].includes(step) ? reviewable() : reviewed(['followup-claim', 'round'].includes(step) ? 'changes' : 'ready');
    const f = await fixture(t, [i], { github: { 90: githubPR(step === 'human' ? { files: [{ filename: 'scripts/dispatch/qa.ts' }] } : step === 'retired' ? { headRefOid: nextSha } : {}) },
      crash: (op: string, v: any) => op === 'Comment' && v.input.body.includes(`<!-- factory-qa:${step} `) ? boundary : false, submissionsOnly: true });
    assert.equal((await f.run()).signal, 'SIGKILL');
    assert.equal((await f.run()).code, 0);
    assert.equal((await f.run()).code, 0);
    const stranded = ['start', 'followup-claim', 'merge-claim'].includes(step) && boundary === 'after';
    assert.equal(f.calls().length, step === 'human' || stranded ? 0 : 1);
  });
}

test('QA interrupted follow-up blocks later heads; failed Amp sends never retry', { timeout: 10_000 }, async t => {
  for (const i of [reviewable(), reviewed('changes'), reviewed()]) {
    const f = await fixture(t, [i], { github: { 90: githubPR() } });
    assert.equal((await f.run(['poll'], { FAKE_FAIL: '1' })).code, 1);
    await f.run();
    assert.equal(f.calls().length, 1);
    if (i.comments.some((c: any) => c.body.includes('factory-qa:followup-claim'))) {
      f.setGitHub({ 90: githubPR({ headRefOid: nextSha }) });
      await f.run();
      assert.equal(f.calls().length, 1);
    }
  }
});

test('QA dry-run previews review/follow-up/merge without Amp or Linear writes', { timeout: 10_000 }, async t => {
  for (const i of [reviewable(), reviewed('changes'), reviewed()]) {
    const f = await fixture(t, [i], { github: { 90: githubPR() } });
    const before = structuredClone(i);
    const result = await f.run(['poll', '--dry-run']);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /would-run.*\$QA_/);
    assert.deepEqual(i, before);
    assert.equal(f.calls().length, 0);
    assert.equal(f.mutations.length, 0);
    assert.ok(!result.stdout.includes('boundary handling'));
  }
});

test('playbook sync waits for wrap-up, clean updated main, then copies the checkout with merge SHA once', { timeout: 10_000 }, async t => {
  const i = reviewable();
  i.attachments[0].metadata.status = 'merged';
  i.comments.push({ body: '<!-- factory-dispatch:wrapup -->' });
  const f = await fixture(t, [i], { github: { 90: githubPR({ state: 'MERGED', mergeCommit: { oid: mergeSha }, files: [{ filename: 'docs/PLAYBOOK.md' }] }) } });
  await f.run();
  assert.equal(f.mutations.length, 0);
  i.comments.push({ body: '<!-- factory-dispatch:wrapup-done -->' });
  for (const environment of [{ FAKE_DIRTY: ' M docs/PLAYBOOK.md' }, { FAKE_BEHIND: '1' }, { FAKE_BRANCH: 'feature' }]) {
    await f.run(['poll'], environment);
    assert.equal(f.mutations.length, 0);
  }
  const preview = await f.run(['poll', '--dry-run']);
  assert.match(preview.stdout, /documentUpdate/);
  assert.equal(f.mutations.length, 0);
  const result = await f.run();
  assert.equal(result.code, 0, result.stdout);
  await f.run();
  const syncs = f.mutations.filter(m => m.operation === 'SyncPlaybook');
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].id, 'f9581006-8200-4508-8726-06350b721932');
  assert.ok(syncs[0].input.content.startsWith('> **Source of truth:**'));
  assert.ok(syncs[0].input.content.includes(`merge ${mergeSha}`));
  assert.ok(syncs[0].input.content.endsWith(playbook));
  assert.equal(f.calls().length, 0);
  t.diagnostic(`playbook fake sync: ${result.durationMs.toFixed(1)} ms`);
});

for (const step of ['SyncPlaybook', 'playbook-synced']) for (const boundary of ['before', 'after']) {
  test(`playbook crash ${boundary} ${step} retries an idempotent replacement`, { timeout: 10_000 }, async t => {
    const i = reviewable();
    i.attachments[0].metadata.status = 'merged';
    i.comments.push({ body: '<!-- factory-dispatch:wrapup -->' }, { body: '<!-- factory-dispatch:wrapup-done -->' });
    const f = await fixture(t, [i], { github: { 90: githubPR({ state: 'MERGED', mergeCommit: { oid: mergeSha }, files: [{ filename: 'docs/PLAYBOOK.md' }] }) },
      crash: (op: string, v: any) => (step === 'SyncPlaybook' ? op === step : op === 'Comment' && v.input.body.includes(`factory-qa:${step}`)) ? boundary : false });
    assert.equal((await f.run()).signal, 'SIGKILL');
    assert.equal((await f.run()).code, 0);
    assert.equal((await f.run()).code, 0);
    const syncs = f.mutations.filter(m => m.operation === 'SyncPlaybook');
    assert.equal(syncs.length, step === 'playbook-synced' && boundary === 'after' ? 1 : 2);
    assert.ok(syncs.every(m => m.input.content === syncs[0].input.content));
    assert.equal(i.comments.filter((c: any) => c.body.includes('factory-qa:playbook-synced')).length, 1);
  });
}

test('new pushes use spare review slots without losing in-flight reservations', { timeout: 10_000 }, async t => {
  const i = reviewable();
  const f = await fixture(t, [i], { github: { 90: githubPR() } });
  await f.run();
  f.setGitHub({ 90: githubPR({ headRefOid: nextSha }) });
  await f.run();
  assert.deepEqual(f.calls().map(a => a[a.indexOf('--executor') + 1]), ['runner:factory-gpu', 'runner:factory-console']);
  f.setGitHub({ 90: githubPR({ headRefOid: mergeSha }) });
  await f.run();
  assert.equal(f.calls().length, 2);
});

test('CI truncation, commit-status failure and read failure defer without claims', { timeout: 10_000 }, async t => {
  const f = await fixture(t, [reviewed()]);
  for (const overrides of [{ checkTotal: 101 }, { statuses: [{ context: 'external', state: 'failure' }] }, { publicFail: true }]) {
    f.setGitHub({ 90: githubPR(overrides) });
    assert.equal((await f.run()).code, 0);
    assert.equal(f.calls().length, 0);
    assert.equal(f.mutations.length, 0);
  }
  f.setGitHub({ 90: githubPR() });
  await f.run();
  assert.equal(f.calls().length, 1);
});

test('authenticated API quota failures defer without claims and recover on a later poll', { timeout: 15_000 }, async t => {
  const f = await fixture(t, [reviewed()]);
  const environment = { DISPATCH_GITHUB_URL: undefined };
  for (const quotaPath of ['pulls/90', 'pulls/90/files?per_page=100&page=1',
    `commits/${sha}/check-runs?per_page=100&filter=latest`, `commits/${sha}/status?per_page=100`]) {
    f.setGitHub({ 90: githubPR({ quotaPath }) });
    const result = await f.run(['poll'], environment);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /qa-pending/);
    assert.ok(!JSON.stringify(result).includes(key));
    assert.equal(f.calls().length, 0);
    assert.equal(f.mutations.length, 0);
  }
  f.setGitHub({ 90: githubPR() });
  assert.equal((await f.run(['poll'], environment)).code, 0);
  assert.equal(f.calls().length, 1);
});

test('non-playbook merge records one checked marker without updating the document', { timeout: 10_000 }, async t => {
  const i = reviewable();
  i.attachments[0].metadata.status = 'merged';
  i.comments.push({ body: '<!-- factory-dispatch:wrapup -->' }, { body: '<!-- factory-dispatch:wrapup-done -->' });
  const f = await fixture(t, [i], { github: { 90: githubPR({ state: 'MERGED', mergeCommit: { oid: mergeSha } }) } });
  assert.equal((await f.run()).code, 0);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.mutations[0].operation, 'Comment');
  assert.match(f.mutations[0].input.body, /factory-qa:playbook-checked pr:90/);
});

test('builder and QA launches label their threads; label failure retries without relaunching', { timeout: 15_000 }, async t => {
  for (const reviewer of [false, true]) {
    const i = reviewer ? reviewable() : issue();
    const f = await fixture(t, [i], { github: reviewer ? { 90: githubPR() } : {} });
    const id = reviewer ? reviewId : threadId;
    const failed = await f.run(['poll'], { FAKE_LABEL_FAIL: '1' });
    assert.equal(failed.code, 0, failed.stdout);
    assert.match(failed.stdout, /"action":"label"/);
    assert.match(failed.stdout, reviewer ? /qa-review/ : /dispatched/);
    assert.equal(reviewer || i.stateId === 'started-id', true);
    assert.ok(!f.threads().find((entry: any) => entry.id === id).labels);
    const text = f.allCalls().find(args => args[0] === '-x')[1];
    assert.match(text, /Label any scratch, probe or test threads you start with met-123/);
    assert.match(text, /amp threads label <T-id> met-123/);
    assert.match(text, /archive them before your final\s+reply; list them in your reply/);
    assert.equal((await f.run()).code, 0);
    assert.deepEqual(f.threads().find((entry: any) => entry.id === id).labels, ['met-123']);
    await f.run();
    assert.equal(f.allCalls().filter(args => args[0] === '-x').length, 1);
    assert.equal(f.allCalls().filter(args => args[1] === 'label' && args[2] === id).length, 2);
  }
});

test('backfill labels recorded open builders and legacy reviewers once, ignoring quoted markers', { timeout: 10_000 }, async t => {
  const i = issue(123, { labels: [], comments: [threadComment(), qaMarker(`review-claim pr:90 sha:${sha} thread:${reviewId}`),
    { body: `\`\`\`text\n<!-- factory-dispatch:thread T-22345678-89ab-4cde-8fab-0123456789ab -->\n\`\`\`` }] });
  const f = await fixture(t, [i], { threads: [threadId, reviewId].map(id => ({ id, updated: quietUpdated, archived: false })) });
  assert.equal((await f.run()).code, 0);
  assert.equal((await f.run()).code, 0);
  assert.ok(f.threads().every((entry: any) => entry.labels.includes('met-123')));
  assert.equal(f.allCalls().filter(args => args[1] === 'label').length, 2);
  assert.equal(f.allCalls().filter(args => args[0] === '-x').length, 0);
  const old = issue(124, { labels: [], state: { type: 'completed' }, comments: [threadComment(),
    { body: '<!-- factory-dispatch:archived -->' }, qaMarker(`review-claim pr:90 sha:${sha} thread:${reviewId}`), qaMarker(`archived pr:90 sha:${sha}`)] });
  const legacy = await fixture(t, [old], { threads: [threadId, reviewId].map(id => ({ id, updated: quietUpdated, archived: true, labels: ['met-124'] })) });
  assert.equal((await legacy.run()).code, 0);
  assert.equal(legacy.allCalls().filter(args => args[1] === 'label' || args[1] === 'archive').length, 0);
});

test('Done and Canceled groups archive probes and QA, retaining canceled builders and unrelated labels', { timeout: 15_000 }, async t => {
  const probeId = 'T-22345678-89ab-4cde-8fab-0123456789ab';
  const unrelatedId = 'T-32345678-89ab-4cde-8fab-0123456789ab';
  for (const state of ['completed', 'canceled']) {
    const i = reviewed(); i.state.type = state;
    const f = await fixture(t, [i], { threads: [threadId, reviewId, probeId, unrelatedId].map(id => ({ id,
      labels: [id === unrelatedId ? 'met-124' : 'met-123'], updated: quietUpdated, archived: false })) });
    const result = await f.run();
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(f.threads().map((entry: any) => entry.archived), [state === 'completed', true, true, false]);
    await f.run();
    assert.equal(f.calls().filter(args => args[1] === 'archive').length, state === 'completed' ? 3 : 2);
  }
});

test('probe groups share archive cap, quiet boundary, failure retry and crash repair', { timeout: 15_000 }, async t => {
  const i = issue(123, { labels: [], state: { type: 'completed' }, comments: [claimComment()] });
  const threads = Array.from({ length: 7 }, (_, n) => ({ id: `T-22345678-89ab-4cde-8fab-${String(n).padStart(12, '0')}`,
    labels: ['met-123'], updated: n === 0 ? '2026-10-13T11:55:00.001Z' : quietUpdated, archived: false }));
  const f = await fixture(t, [i], { threads });
  assert.equal((await f.run(['poll'], { FAKE_ARCHIVE_FAIL: '1' })).code, 0);
  assert.equal(f.calls().filter(args => args[1] === 'archive').length, 5);
  assert.ok(f.threads().every((entry: any) => !entry.archived));
  assert.equal((await f.run()).code, 0);
  assert.equal(f.threads().filter((entry: any) => entry.archived).length, 5);
  assert.equal(f.threads()[0].archived, false);
  assert.equal((await f.run(['poll'], { FAKE_NOW: String(now + 1) })).code, 0);
  assert.ok(f.threads().every((entry: any) => entry.archived));

  const crashIssue = issue(124, { labels: [], state: { type: 'canceled' }, comments: [claimComment()] });
  const crashThread = { ...threads[0], labels: ['met-124'], updated: quietUpdated };
  const crash = await fixture(t, [crashIssue], { threads: [crashThread],
    crash: (operation: string, v: any) => operation === 'Comment' && v.input.body.includes('factory-dispatch:archived thread:') ? 'before' : null });
  assert.equal((await crash.run()).signal, 'SIGKILL');
  assert.equal(crash.threads()[0].archived, true);
  assert.equal((await crash.run()).code, 0);
  assert.equal(crash.calls().filter(args => args[1] === 'archive').length, 1);
  assert.equal(crashIssue.comments.filter((c: any) => c.body.includes('factory-dispatch:archived thread:')).length, 1);
});

test('invalid label search fails closed for probes', { timeout: 10_000 }, async t => {
  const i = issue(123, { labels: [], state: { type: 'completed' }, comments: [claimComment()] });
  const f = await fixture(t, [i]);
  for (const output of ['not json', '{}', '[{"id":"invalid"}]']) {
    const result = await f.run(['poll'], { FAKE_BAD_SEARCH: output });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Amp label search unreadable/);
    assert.equal(f.calls().filter(args => args[1] === 'archive').length, 0);
  }
});
