// Launching a Builder through the CLI (docs/odd/README.md §6): plugin agents cannot run Claude
// Code, so the control plane starts `amp -ox --mode external-agent:claude-code --stream-json`,
// reads the new thread's session_id, lets the caller label and record the child, and only then
// ends the local launcher. The child runs in its own orb and outlives the launcher.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { builderEngine, engineArgs, engineLabel } from './engines.ts';

/** The local `amp` process: its stdout lines, its stderr tail, and a way to end it. */
export type Launcher = { lines: AsyncIterable<string>; stderr: () => string; kill: () => void };

/** Process IO, replaced by fixtures so no test starts a live child. */
export const io = {
  start(argv: readonly string[]): Launcher {
    const child = spawn('amp', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', (error: Error) => { stderr += String(error); });
    return { lines: createInterface({ input: child.stdout }), stderr: () => stderr, kill: () => { child.kill('SIGTERM'); } };
  },
};

/** Orb project for builder threads (scripts/dispatch/repos.json `ampProject`). */
export const builderProject = 'Metacomet-Technologies/factory';

/** `amp -ox` for a Claude Code builder: pinned model and effort, labels set at creation so a crash leaves a derivable owner. */
export function builderArgs(prompt: string, labels: readonly string[], title: string): string[] {
  return ['-ox', prompt, ...engineArgs('claude', builderEngine.effort),
    '--project', builderProject, '--title', title, '--visibility', 'workspace', '--no-archive-after-execute', '--stream-json',
    ...[...labels, engineLabel(builderEngine.lab)].flatMap(label => ['--label', label])];
}

const threadPattern = /^T-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

async function sessionID(lines: AsyncIterable<string>): Promise<string | undefined> {
  for await (const line of lines) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { continue; }
    const id = (message as { session_id?: unknown } | null)?.session_id;
    if (typeof id === 'string' && threadPattern.test(id)) return id;
  }
  return undefined;
}

/**
 * Start the launcher and resolve with the child's thread ID once `own` has recorded it. The
 * launcher is ended after `own` settles, or at once when it exits, times out or prints no
 * session_id; every failure rejects so the caller reports it (no fallback engine).
 */
export async function launch(argv: readonly string[], own: (threadID: string) => Promise<void>, timeoutMs = 10 * 60_000): Promise<string> {
  const launcher = io.start(argv);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no session_id from amp within ${timeoutMs / 1000} s`)), timeoutMs); });
    const id = await Promise.race([sessionID(launcher.lines), timeout]);
    if (!id) throw new Error(`amp exited without a session_id: ${launcher.stderr().trim().slice(-300) || 'no stderr'}`);
    await own(id);
    return id;
  } finally {
    clearTimeout(timer);
    launcher.kill();
  }
}
