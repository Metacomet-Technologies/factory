// Run the harness's smallest case against this worktree's sandbox only (MET-119).
// The harness itself is copied unchanged, so its production defaults are never used.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
// fleet-health: one expected call, and get_fleet_status is the first offered tool.
const caseId = 'fleet-health';

export function loopback(name: string, url: string | undefined): string {
  if (!url) throw new Error(`Sandbox status did not report ${name}; is it running?`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`Refusing non-loopback ${name} URL: ${url}`);
  }
  return parsed.origin;
}

async function main() {
  const status = execFileSync(join(directory, '../../scripts/sandbox'), ['status'], { encoding: 'utf8' });
  if (!status.startsWith('Sandbox running')) throw new Error('Sandbox is not running; start it with scripts/sandbox up');
  const url = (service: string) => status.match(new RegExp(`^${service}: (\\S+)$`, 'm'))?.[1];
  // Meter fronts the fake Ollama, as the deployed meter fronts real Ollama.
  const ollama = loopback('meter', url('meter'));
  const api = loopback('factory-api', url('factory-api'));
  const cases = JSON.parse(await readFile(join(directory, 'cases.json'), 'utf8'));
  const output = await mkdtemp(join(tmpdir(), 'ask-sandbox-'));
  await copyFile(join(directory, 'run.ts'), join(output, 'run.ts'));
  await writeFile(join(output, 'cases.json'), JSON.stringify(cases.filter((c: any) => c.id === caseId)));
  console.log(`OLLAMA_URL=${ollama} FACTORY_API_URL=${api} case=${caseId} output=${output}/results.json`);
  const started = performance.now();
  execFileSync(process.execPath, [join(output, 'run.ts'), 'run', join(output, 'results.json')],
    { stdio: 'inherit', env: { ...process.env, OLLAMA_URL: ollama, FACTORY_API_URL: api } });
  console.log(`runtime_s=${((performance.now() - started) / 1000).toFixed(1)}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], 'file://' + process.cwd() + '/'))) await main();
