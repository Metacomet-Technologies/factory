// Test support for the control-plane fixtures: a fake `$` that answers the amp CLI calls the
// plugin makes as an account whose subscriptions serve every pin. No live process is started.

import { builderEngine, pluginPins, reviewerEngines, type Engine } from './engines.ts';

/** The account's connections, as `amp config model-providers list --json` reports them (synthetic IDs). */
export const fakeConnections = [
  { id: '00000000-0000-4000-8000-000000000001', type: 'model_provider_claude_sub', name: 'Subscription', active: true },
  { id: '00000000-0000-4000-8000-000000000002', type: 'model_provider_xai_grok', name: 'Cursor', active: true },
  { id: '00000000-0000-4000-8000-000000000003', type: 'model_provider_chatgpt', name: 'ChatGPT', active: true },
];

const pinned: Engine[] = [builderEngine, ...reviewerEngines, ...Object.values(pluginPins)];

/** `check-access` output for a model the account serves through its pinned subscription. */
export function servedBy(model: string, override?: { kind?: string; connectionType?: string | null; modelProviderName?: string | null }) {
  const engine = pinned.find(candidate => candidate.model === model);
  const connection = fakeConnections.find(candidate => candidate.type === engine?.subscription.type);
  return { ok: true, modelRouting: { kind: 'model-provider', modelProviderName: connection?.name ?? null, connectionType: connection?.type ?? null, ...override } };
}

/**
 * A plugin `$`: amp CLI calls get subscribed answers (or `cli(command)` when it returns a string),
 * every other command `fallback` (an empty JSON list, like the existing fixtures).
 */
export function fakeShell(cli: (command: string, values: unknown[]) => string | undefined = () => undefined, fallback = '[]') {
  const commands: string[] = [];
  const $ = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ''), '');
    commands.push(command);
    const custom = cli(command, values);
    if (custom !== undefined) return { exitCode: 0, stdout: custom, stderr: '' };
    if (command.startsWith('amp config model-providers check-access')) return { exitCode: 0, stdout: JSON.stringify(servedBy(String(values[0]))), stderr: '' };
    if (command.startsWith('amp config model-providers list')) return { exitCode: 0, stdout: JSON.stringify(fakeConnections), stderr: '' };
    return { exitCode: 0, stdout: fallback, stderr: '' };
  };
  return { $, commands };
}
