import test from 'node:test';
import assert from 'node:assert/strict';
import { builderEngine, checkAccess, checkRouting, engineArgs, engineLabel, engineUsage, expectedEngine, labOf, parseRouting, pluginPins, reviewerEngines, routingRecord, selectReviewer, type Engine } from './engines.ts';
import { engineArgs as legacyEngineArgs, modes as legacyModes } from '../dispatch/dispatch.ts';
import { fakeConnections, servedBy } from './fixtures.ts';

const [openai, xai] = reviewerEngines;

test('the dispatcher keeps its engine table through the moved source of truth', () => {
  assert.equal(legacyEngineArgs, engineArgs);
  assert.deepEqual(legacyEngineArgs('claude', 'high'), ['--mode', 'external-agent:claude-code', '--features', 'model:claude-opus-5-5,effort:high']);
  assert.deepEqual(legacyEngineArgs('grok', 'medium'), ['--mode', 'grok-medium']);
  assert.equal(legacyModes.chatgpt.medium, 'gpt61s');
});

test('every role pins an explicit model and effort; the builder is Claude Code and no plugin agent bills Anthropic', () => {
  assert.deepEqual(builderEngine, { lab: 'anthropic', model: 'anthropic/claude-opus-5-5', effort: 'high', subscription: { type: 'model_provider_claude_sub', label: 'Claude Subscription' } });
  assert.deepEqual(reviewerEngines.map(engine => [engine.model, engine.effort, engine.subscription.type, engine.subscription.name]),
    [['openai/gpt-6-astra', 'high', 'model_provider_chatgpt', undefined], ['xai/grok-4.7', 'high', 'model_provider_xai_grok', 'Cursor']]);
  for (const [role, pin] of Object.entries(pluginPins)) {
    assert.match(pin.model, /^(openai|xai)\//, role);
    assert.ok(['low', 'medium', 'high'].includes(pin.effort), role);
  }
});

test('reviewer selection is weighted by live usage and never picks the builder\'s lab, even when the default builder lab changes', () => {
  // Ties keep table order; lower usage wins otherwise.
  assert.equal(selectReviewer('anthropic', {}), openai);
  assert.equal(selectReviewer('anthropic', { openai: 3, xai: 1 }), xai);
  assert.equal(selectReviewer('anthropic', { openai: 1, xai: 3 }), openai);
  // The builder's own lab is refused even when it is the least used.
  assert.equal(selectReviewer('openai', { openai: 0, xai: 9 }), xai);
  assert.equal(selectReviewer('xai', { xai: 0, openai: 9 }), openai);
  // No builder label: the configured builder lab is refused.
  assert.equal(selectReviewer(undefined, { openai: 5 }), xai);
  // Only same-lab engines left: no reviewer rather than a self-review.
  assert.equal(selectReviewer('openai', {}, [openai]), undefined);
  assert.deepEqual(engineUsage([{ labels: [engineLabel('openai')] }, { labels: ['odd-engine-openai', 'odd-role-spec'] }, { labels: ['odd-engine-xai'] }, { labels: ['odd-engine-nope'] }, { labels: [] }]), { openai: 2, xai: 1 });
  assert.equal(labOf(['odd-role-builder', 'odd-engine-anthropic']), 'anthropic');
  assert.equal(labOf(['odd-engine-other']), undefined);
});

test('a thread\'s expected engine comes from its role and lab label; an unknown pairing has none', () => {
  assert.equal(expectedEngine('builder', 'anthropic'), builderEngine);
  assert.equal(expectedEngine('reviewer', 'xai'), xai);
  assert.equal(expectedEngine('reviewer', 'anthropic'), undefined);
  assert.equal(expectedEngine('spec', 'openai'), pluginPins.spec);
  assert.equal(expectedEngine('spec', 'xai'), undefined);
  assert.equal(expectedEngine('verifier', undefined), undefined);
});

const [claude, cursor, chatgpt] = fakeConnections;
const usage = (rows: string[]) => `# Thread Usage\n\n## Models\n\n| Model | Requests |\n| --- | ---: |\n| Opus 5.5 | 3 |\n\n## Model Routing\n\n| Model ID | Purpose | Routing | Requests | Cost |\n| --- | --- | --- | ---: | ---: |\n${rows.join('\n')}\n\n## Tools\n\n| Tool | Requests | Cost |\n| --- | ---: | ---: |\n| Web Extract | 1 | $0.001 |\n`;
const via = (connection: { id: string; name: string }) => `Via [${connection.name}](https://ampcode.com/settings/model-routing#${connection.id})`;

test('routing evidence: Claude Code on the Claude Subscription matches; Via Amp, another lab\'s connection or no rows does not', () => {
  const served = parseRouting(usage([
    `| anthropic/claude-opus-5-5 | Thread Title | Via Amp | 1 | $0.006 |`,
    `| anthropic/claude-opus-5-5 | Agent | ${via(claude)} | 1,203 | $0 |`,
    `| external-agent:claude-code/claude-haiku-5-5 | Unspecified (legacy) | ${via(claude)} | 3 | $0 |`,
  ]), fakeConnections);
  assert.deepEqual(served[1], { model: 'anthropic/claude-opus-5-5', purpose: 'Agent', via: 'Subscription', connection: claude, requests: 1203 });
  assert.deepEqual(checkRouting(builderEngine, served), { result: 'match', problems: [] });

  const paid = parseRouting(usage([`| anthropic/claude-opus-5-5 | Agent | Via Amp | 15 | $1.18 |`]), fakeConnections);
  assert.equal(checkRouting(builderEngine, paid).result, 'mismatch');
  assert.match(checkRouting(builderEngine, paid).problems[0], /via Amp, expected anthropic via Claude Subscription/);
  // ChatGPT is a subscription, but not the reviewer-on-Grok's one; a Grok connection not named Cursor does not count either.
  const grokOnChatgpt = parseRouting(usage([`| xai/grok-4.7 | Agent | ${via(chatgpt)} | 4 | $0 |`]), fakeConnections);
  assert.equal(checkRouting(xai, grokOnChatgpt).result, 'mismatch');
  const otherGrok = parseRouting(usage([`| xai/grok-4.7 | Agent | ${via({ id: '00000000-0000-4000-8000-000000000009', name: 'Other' })} | 4 | $0 |`]), [...fakeConnections, { id: '00000000-0000-4000-8000-000000000009', type: 'model_provider_xai_grok', name: 'Other' }]);
  assert.equal(checkRouting(xai, otherGrok).result, 'mismatch');
  assert.equal(checkRouting(xai, parseRouting(usage([`| xai/grok-4.7 | Agent | ${via(cursor)} | 4 | $0 |`]), fakeConnections)).result, 'match');
  // The right connection serving another lab's model is still a mismatch.
  assert.equal(checkRouting(openai, parseRouting(usage([`| anthropic/claude-opus-5-5 | Agent | ${via(chatgpt)} | 2 | $0 |`]), fakeConnections)).result, 'mismatch');
  assert.deepEqual(checkRouting(openai, parseRouting(usage([`| openai/gpt-6-astra | Thread Title | Via Amp | 1 | $0 |`]), fakeConnections)), { result: 'missing', problems: ['no model routing rows'] });
  assert.deepEqual(parseRouting('no usage yet', fakeConnections), []);
});

test('check-access: the pinned subscription matches; Amp\'s upstream, another connection or a failed probe does not', () => {
  const check = (engine: Engine, output: unknown) => checkAccess(engine, output).result;
  assert.equal(check(openai, servedBy('openai/gpt-6-astra')), 'match');
  assert.equal(check(xai, servedBy('xai/grok-4.7')), 'match');
  assert.equal(check(xai, servedBy('xai/grok-4.7', { modelProviderName: 'Other' })), 'mismatch');
  // What check-access reported for anthropic/claude-opus-5-5 on 2026-10-26: Amp's paid upstream.
  assert.equal(check(builderEngine, { ok: true, modelRouting: { kind: 'upstream-model-provider', modelProviderName: 'Anthropic', connectionType: null } }), 'mismatch');
  assert.equal(check(openai, { ok: false, error: 'rate limited' }), 'missing');
  assert.equal(check(openai, undefined), 'missing');
});

test('the routing record names models, purposes and connections only', () => {
  const routes = parseRouting(usage([`| anthropic/claude-opus-5-5 | Agent | ${via(claude)} | 7 | $0 |`]), fakeConnections);
  const record = routingRecord('T-1', 'builder', builderEngine, routes, checkRouting(builderEngine, routes));
  assert.equal(record, 'odd-routing thread=T-1 role=builder engine=anthropic model=anthropic/claude-opus-5-5 result=match\n- anthropic/claude-opus-5-5 Agent: 7 via Subscription (model_provider_claude_sub)');
  assert.ok(!record.includes(claude.id) && !record.includes('$') && !record.includes('http'));
});
