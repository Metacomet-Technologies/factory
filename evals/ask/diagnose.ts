import { readFile, writeFile } from 'node:fs/promises';
import { tools, systemPrompt, validate } from './run.ts';

// These single-turn controls diagnose failures; they are not additional full-loop scores.
const baseline = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));
const scopedPrompt = systemPrompt
  .replace('You answer questions about the factory using only the provided read-only tools.', 'For live factory facts, use only the provided read-only tools. You may answer general definitions, greetings, and arithmetic directly without tools.')
  .replace('Answer from the returned snapshot, not an earlier turn or your knowledge.', 'For live factory facts, answer from the returned snapshot, not an earlier turn or your knowledge. General definitions and arithmetic do not require a snapshot.');
const controls: any[] = [];
const probes = [
  { id: 'code-baseline-nonstream', model: 'factory-code', system: systemPrompt, user: baseline.cases.find((c: any) => c.id === 'fleet-health').prompt, repeat: 1 },
  { id: 'code-explicit-tool-tags', model: 'factory-code', system: systemPrompt + '\nFor every function call, return JSON inside <tool_call></tool_call>, never bare JSON or Markdown fences.', user: baseline.cases.find((c: any) => c.id === 'fleet-health').prompt, repeat: 1 },
  ...['factory-assist', 'factory-code'].flatMap(model => [1, 2, 3].map(repeat => ({ id: 'scoped-definition', model, system: scopedPrompt, user: baseline.cases.find((c: any) => c.id === 'no-tool-definition').prompt, repeat }))),
];
for (const probe of probes) {
  const start = performance.now();
  const request = { model: probe.model, messages: [{ role: 'system', content: probe.system }, { role: 'user', content: probe.user }], tools, stream: false, options: { temperature: 0.2, seed: 1000 + probe.repeat, num_ctx: probe.model === 'factory-assist' ? 65536 : 16384, num_predict: 2048 } };
  const record: any = { ...probe, started_at: new Date().toISOString(), request };
  try {
    const response = await fetch(baseline.ollama_url + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(300_000) });
    record.http_status = response.status;
    record.response = await response.json();
    const calls = record.response.message?.tool_calls ?? [];
    record.native_calls = calls.length;
    record.valid_calls = calls.every((t: any) => validate(t.function) === null);
    if (probe.id === 'scoped-definition') record.passed = response.ok && calls.length === 0 && /memory/i.test(record.response.message?.content ?? '');
  } catch (error) { record.error = String(error); }
  record.total_ms = performance.now() - start;
  controls.push(record);
  await writeFile(new URL('./diagnostics.json', import.meta.url), JSON.stringify({ baseline_started_at: baseline.started_at, note: 'Single-turn non-streaming controls; tool calls are inspected, not executed. These results do not enter baseline scores.', controls }, null, 2) + '\n');
  console.log(`${probe.id} ${probe.model} repeat=${probe.repeat} native_calls=${record.native_calls} passed=${record.passed ?? 'n/a'} ${(record.total_ms / 1000).toFixed(1)}s`);
}
