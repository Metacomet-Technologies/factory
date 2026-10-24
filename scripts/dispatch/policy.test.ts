import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePolicy, evaluatePolicy, stages, modes, type Evaluation } from './policy.ts';

const mainSha = 'a'.repeat(40), actionSha = 'b'.repeat(40);
const defaults = { spec: 'Agent', dispatch: 'Auto-pilot', merge: 'Agent', deploy: 'Agent', verify: 'Agent', recovery: 'Agent' } as const;
const config = { version: 1, defaults, repositories: {} };
const policy = parsePolicy(JSON.stringify(config), mainSha);
const required = {
  spec: ['specification', 'agent-review'], dispatch: ['task-valid', 'dependencies-clear'],
  merge: ['ci', 'independent-review', 'agent-review'], deploy: ['immutable-artifact', 'deployment-plan', 'agent-review'],
  verify: ['deployment-receipt', 'independent-verification', 'agent-review'], recovery: ['reconciled-outcome', 'safe-recovery-plan', 'agent-review'],
};
function input(stage: Evaluation['stage'] = 'merge'): Evaluation {
  const binding = { repository: 'factory', stage, target: { id: 'factory#90', sha: actionSha }, policyRevision: policy.revision };
  return { ...binding, executorAvailable: true, capabilities: { approval: true, control: true, deployer: true },
    classification: { ...binding, kind: 'ordinary' },
    dispatchSnapshot: { repository: 'factory', policyRevision: policy.revision, modes: { ...defaults } },
    evidence: required[stage].map((check, i) => ({ ...binding, id: `evidence-${i}`, check, result: 'passed' })) };
}

test('stage policy defaults and explicit repo overrides inherit across all six stages', () => {
  const committed = parsePolicy(readFileSync(new URL('../../.factory/stage-policy.json', import.meta.url), 'utf8'), mainSha);
  assert.deepEqual(committed.defaults, defaults);
  for (const stage of stages) {
    assert.equal(evaluatePolicy(committed, input(stage)).requiredMode, defaults[stage]);
    const decision = evaluatePolicy(policy, input(stage));
    assert.deepEqual(decision.mandatoryChecks, required[stage]);
    assert.deepEqual(decision.blockers, []);
    assert.equal(decision.nextAction, 'would-execute');
    assert.equal(decision.authorized, false);
    assert.equal(decision.observational, true);
    for (const mode of modes) {
      const overridden = parsePolicy(JSON.stringify({ ...config, repositories: { 'factory-access': { [stage]: mode } } }), mainSha);
      for (const other of stages) {
        assert.equal(evaluatePolicy(overridden, { ...input(other), dispatchSnapshot: undefined, repository: 'factory-access' }).requiredMode,
          other === stage ? mode : defaults[other]);
        assert.equal(evaluatePolicy(overridden, { ...input(other), dispatchSnapshot: undefined }).requiredMode, defaults[other]);
      }
    }
  }
});

test('strict policy rejects malformed schemas, unknowns, task overrides and decoded duplicate keys', () => {
  for (const value of [null, [], {}, { ...config, version: 2 }, { ...config, version: '1' },
    { ...config, tasks: {} }, { ...config, defaults: { ...defaults, task: 'Human' } },
    { ...config, defaults: { ...defaults, spec: undefined } }, { ...config, defaults: { ...defaults, merge: 'auto' } },
    { ...config, repositories: [] }, { ...config, repositories: { unknown: {} } },
    { ...config, repositories: { factory: { stages: {} } } }, { ...config, repositories: { factory: { tasks: {} } } },
    { ...config, repositories: { factory: { deploy: 'human' } } }, { ...config, repositories: { factory: null } },
  ]) assert.throws(() => parsePolicy(JSON.stringify(value), mainSha), /^Error: Stage policy unavailable$/);
  const text = JSON.stringify(config);
  for (const content of ['{', `${text} trailing`, text.replace('"version":1', '"version":1,"version":1'),
    text.replace('"spec":"Agent"', '"spec":"Agent","sp\\u0065c":"Human"'),
    text.replace('"repositories":{}', '"repositories":{"factory":{},"factory":{}}'),
    text.replace('"repositories":{}', '"repositories":{"factory":{"merge":"Agent","merge":"Human"}}'),
    text.replace('"repositories":{}', '"repositories":{"__proto__":{}}'),
  ]) assert.throws(() => parsePolicy(content, mainSha), /^Error: Stage policy unavailable$/);
  for (const sha of ['', 'main', 'a'.repeat(39), 'a'.repeat(41)]) assert.throws(() => parsePolicy(text, sha));
});

test('revision binds exact content bytes and trusted-main commit, deterministically', () => {
  const text = JSON.stringify(config);
  assert.equal(parsePolicy(text, mainSha).revision, policy.revision);
  for (const other of [parsePolicy(`${text}\n`, mainSha), parsePolicy(text, actionSha),
    parsePolicy(text.replace('"merge":"Agent"', '"merge":"Human"'), mainSha)]) {
    assert.notEqual(other.revision, policy.revision);
  }
  assert.match(policy.revision, /^[a-f0-9]{64}$/);
});

test('changed target, revision and evidence cannot reuse a successful observation', () => {
  const changed: [Evaluation, string][] = [
    [{ ...input(), target: { id: 'factory#91', sha: actionSha } }, 'evidence-mismatch:ci'],
    [{ ...input(), target: { id: 'factory#90', sha: 'c'.repeat(40) } }, 'evidence-mismatch:ci'],
    [{ ...input(), target: { id: 'factory#90', sha: null } }, 'target-unknown'],
    [{ ...input(), policyRevision: 'd'.repeat(64) }, 'policy-revision-mismatch'],
    [{ ...input(), executorAvailable: false }, 'executor-unavailable'],
    [{ ...input(), executorAvailable: 'unknown' }, 'executor-unknown'],
    [{ ...input(), dispatchSnapshot: undefined }, 'baseline-missing'],
    [{ ...input(), dispatchSnapshot: { ...input().dispatchSnapshot!, repository: 'factory-access' } }, 'baseline-invalid'],
    [{ ...input(), classification: undefined }, 'classification-unknown'],
    [{ ...input(), classification: { ...input().classification!, policyRevision: 'e'.repeat(64) } }, 'classification-mismatch'],
  ];
  for (const [value, reason] of changed) {
    const result = evaluatePolicy(policy, value);
    assert.ok(result.blockers.includes(reason), `${reason}: ${JSON.stringify(result)}`);
    assert.equal(result.nextAction, 'blocked');
    assert.equal(result.authorized, false);
  }
  for (const [change, reason] of [
    [{ id: '' }, 'mismatch'], [{ result: 'failed' }, 'failed'], [{ repository: 'factory-access' }, 'mismatch'],
    [{ stage: 'deploy' }, 'mismatch'], [{ policyRevision: 'f'.repeat(64) }, 'mismatch'],
  ] as const) {
    const value = input(); Object.assign(value.evidence[0], change);
    assert.ok(evaluatePolicy(policy, value).blockers.includes(`evidence-${reason}:ci`));
  }
  const ambiguous = input(); ambiguous.evidence.push({ ...ambiguous.evidence[0], result: 'failed' });
  assert.ok(evaluatePolicy(policy, ambiguous).blockers.includes('evidence-ambiguous:ci'));
  assert.deepEqual(evaluatePolicy(undefined, input()).blockers, ['policy-unavailable']);
  assert.deepEqual(evaluatePolicy(policy, { ...input(), repository: 'unknown' }).blockers, ['unknown-stage-or-repository']);
});

test('protected actions require Human; unknown deployment classification and unavailable capabilities block', () => {
  for (const kind of ['security', 'authority', 'irreversible'] as const) for (const stage of stages) {
    const value = input(stage); value.classification!.kind = kind;
    const result = evaluatePolicy(policy, value);
    assert.equal(result.requiredMode, 'Human');
    assert.ok(result.mandatoryChecks.includes('human-approval'));
    if (stage !== 'spec') assert.ok(result.blockers.includes('evidence-missing:human-approval'));
  }
  const value = input('deploy');
  value.classification = undefined;
  value.capabilities = { approval: false, control: false, deployer: false };
  assert.deepEqual(evaluatePolicy(policy, value).blockers,
    ['classification-unknown', 'control-unavailable', 'approval-unavailable', 'deployer-unavailable']);
  const verify = input('verify'); verify.evidence = [];
  assert.deepEqual(evaluatePolicy(policy, verify).blockers,
    ['evidence-missing:deployment-receipt', 'evidence-missing:independent-verification', 'evidence-missing:agent-review']);
});

test('next gates use stricter current/snapshot mode; only new dispatch sees loosened defaults without a baseline', () => {
  for (const previous of modes) for (const current of modes) for (const stage of stages) {
    const updated = parsePolicy(JSON.stringify({ ...config, defaults: { ...defaults, [stage]: current } }), actionSha);
    const value = input(stage);
    value.policyRevision = updated.revision;
    value.dispatchSnapshot!.modes[stage] = previous;
    const result = evaluatePolicy(updated, value);
    const expected = previous === 'Human' || current === 'Human' ? 'Human'
      : previous === 'Agent' || current === 'Agent' ? 'Agent' : 'Auto-pilot';
    assert.equal(result.requiredMode, expected);
    assert.ok(!result.blockers.includes('baseline-missing'));
  }
  const tightened = parsePolicy(JSON.stringify({ ...config, defaults: { ...defaults, dispatch: 'Human' } }), mainSha);
  const legacy = { ...input('dispatch'), dispatchSnapshot: undefined };
  assert.ok(evaluatePolicy(policy, legacy).blockers.includes('baseline-missing'));
  const fresh = { ...legacy, newDispatch: true };
  assert.equal(evaluatePolicy(policy, fresh).requiredMode, 'Auto-pilot');
  assert.deepEqual(evaluatePolicy(policy, fresh).blockers, []);
  assert.equal(evaluatePolicy(tightened, { ...fresh, policyRevision: tightened.revision }).requiredMode, 'Human');
  const old = { ...input('dispatch'), dispatchSnapshot: { repository: 'factory', policyRevision: tightened.revision, modes: { ...defaults, dispatch: 'Human' as const } } };
  assert.equal(evaluatePolicy(policy, old).requiredMode, 'Human');
  assert.ok(evaluatePolicy(policy, old).blockers.includes('evidence-missing:human-approval'));
});
