import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { repos } from './repos.ts';

export const stages = ['spec', 'dispatch', 'merge', 'deploy', 'verify', 'recovery'] as const;
export const modes = ['Auto-pilot', 'Agent', 'Human'] as const;
type Stage = typeof stages[number];
type Mode = typeof modes[number];
type StageModes = Record<Stage, Mode>;
export type Policy = {
  version: 1; defaults: StageModes; repositories: Record<string, Partial<StageModes>>;
  revision: string; trustedMainSha: string;
};
const shaPattern = /^[a-f0-9]{40}$/;
const revisionPattern = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const validModes = (value: unknown, complete: boolean) => object(value)
  && Object.keys(value).every(key => stages.includes(key as Stage) && modes.includes(value[key]))
  && (!complete || stages.every(stage => Object.hasOwn(value, stage)));

export function parsePolicy(content: string, trustedMainSha: string): Policy {
  const fail = () => { throw new Error('Stage policy unavailable'); };
  if (!shaPattern.test(trustedMainSha) || Buffer.byteLength(content) > 65_536) return fail();
  let value;
  try { value = JSON.parse(content); } catch { return fail(); }
  // JSON.parse validates syntax but discards duplicate keys. Scan its valid JSON
  // tokens as well, decoding escaped keys before comparing within each object.
  const tokens = content.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token), keys = stack.at(-1)!;
      if (keys.has(key)) return fail();
      keys.add(key);
    }
  }
  if (!object(value) || Object.keys(value).sort().join(',') !== 'defaults,repositories,version'
    || value.version !== 1 || !validModes(value.defaults, true) || !object(value.repositories)
    || Object.entries(value.repositories).some(([repo, overrides]) => !repos.some(r => r.name === repo) || !validModes(overrides, false))) return fail();
  Object.freeze(value.defaults);
  Object.values(value.repositories).forEach(Object.freeze);
  Object.freeze(value.repositories);
  return Object.freeze({ ...value, trustedMainSha,
    revision: createHash('sha256').update(trustedMainSha).update('\0').update(content).digest('hex') }) as Policy;
}

function readTrustedPolicy(): Policy {
  const read = (args: string[]) => {
    const result = spawnSync('git', ['-C', '/home/agent/work/factory', ...args],
      { timeout: 5_000, maxBuffer: 65_536, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) throw new Error('Stage policy unavailable');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout);
  };
  // Pin once: neither a PR checkout, a dirty policy file, nor a moving ref can
  // change the content associated with this revision. Never fetch or write.
  const trustedMainSha = read(['rev-parse', '--verify', 'refs/heads/main^{commit}']).trim();
  if (!shaPattern.test(trustedMainSha)) throw new Error('Stage policy unavailable');
  return parsePolicy(read(['show', `${trustedMainSha}:.factory/stage-policy.json`]), trustedMainSha);
}

type Target = { id: string | null; sha: string | null };
type Binding = { repository: string; stage: Stage; target: Target; policyRevision: string };
type Evidence = Binding & { id: string; check: string; result: 'passed' | 'failed' };
export type Evaluation = Binding & {
  executorAvailable: boolean | 'unknown';
  capabilities: { approval: boolean; control: boolean; deployer: boolean };
  evidence: Evidence[];
  classification?: Binding & { kind: 'ordinary' | 'security' | 'authority' | 'irreversible' };
  newDispatch?: boolean;
  dispatchSnapshot?: { repository: string; policyRevision: string; modes: StageModes };
};
const checks: Record<Stage, string[]> = {
  spec: ['specification'], dispatch: ['task-valid', 'dependencies-clear'],
  merge: ['ci', 'independent-review'], deploy: ['immutable-artifact', 'deployment-plan'],
  verify: ['deployment-receipt', 'independent-verification'], recovery: ['reconciled-outcome', 'safe-recovery-plan'],
};
const sameTarget = (a: Target, b: Target) => a.id === b.id && a.sha === b.sha;
const sameBinding = (a: Binding, b: Binding) => a.repository === b.repository && a.stage === b.stage
  && a.policyRevision === b.policyRevision && sameTarget(a.target, b.target);

// Inputs are trusted caller evidence, not Linear comments or task overrides.
// This function does not authenticate evidence or grant execution authority.
export function evaluatePolicy(policy: Policy | undefined, input: Evaluation) {
  const blockers: string[] = [];
  const mandatoryChecks: string[] = [];
  const result = (requiredMode: Mode | 'unknown') => ({ observational: true as const, requiredMode,
    mandatoryChecks, blockers, nextAction: blockers.length ? 'blocked' : 'would-execute', authorized: false as const });
  if (!policy) { blockers.push('policy-unavailable'); return result('unknown'); }
  if (!stages.includes(input.stage) || !repos.some(repo => repo.name === input.repository)) {
    blockers.push('unknown-stage-or-repository'); return result('unknown');
  }
  let mode = policy.repositories[input.repository]?.[input.stage] ?? policy.defaults[input.stage];
  if (input.policyRevision !== policy.revision) blockers.push('policy-revision-mismatch');
  if (!input.target.id || !input.target.sha || !shaPattern.test(input.target.sha)) blockers.push('target-unknown');
  const snapshot = input.dispatchSnapshot;
  if (snapshot) {
    if (snapshot.repository !== input.repository || !revisionPattern.test(snapshot.policyRevision) || !validModes(snapshot.modes, true)) {
      blockers.push('baseline-invalid');
    } else if (modes.indexOf(snapshot.modes[input.stage]) > modes.indexOf(mode)) mode = snapshot.modes[input.stage];
  } else if (!(input.newDispatch === true && input.stage === 'dispatch')) blockers.push('baseline-missing');
  if (input.classification && sameBinding(input.classification, input)
    && ['ordinary', 'security', 'authority', 'irreversible'].includes(input.classification.kind)) {
    if (input.classification.kind !== 'ordinary') mode = 'Human';
  } else {
    blockers.push(input.classification ? 'classification-mismatch' : 'classification-unknown');
  }
  if (input.executorAvailable !== true) blockers.push(input.executorAvailable === false ? 'executor-unavailable' : 'executor-unknown');
  if (!input.capabilities.control) blockers.push('control-unavailable');
  if (mode !== 'Auto-pilot' && !input.capabilities.approval) blockers.push('approval-unavailable');
  if (input.stage === 'deploy' && !input.capabilities.deployer) blockers.push('deployer-unavailable');
  mandatoryChecks.push(...checks[input.stage]);
  if (mode !== 'Auto-pilot') mandatoryChecks.push(mode === 'Human' ? 'human-approval' : 'agent-review');
  for (const check of mandatoryChecks) {
    const evidence = input.evidence.filter(item => item.check === check);
    // Duplicate/conflicting evidence is ambiguous, never pick a convenient pass.
    if (!evidence.length) blockers.push(`evidence-missing:${check}`);
    else if (evidence.length !== 1) blockers.push(`evidence-ambiguous:${check}`);
    else if (!evidence[0].id || !sameBinding(evidence[0], input)) blockers.push(`evidence-mismatch:${check}`);
    else if (evidence[0].result !== 'passed') blockers.push(`evidence-failed:${check}`);
  }
  return result(mode);
}

export type Observation = {
  identifier: string; repository?: string; runner?: string; state: string;
  existing: boolean; pullRequests: string[];
};
type Log = (decision: string, details?: object) => void;

export function observeStagePolicy(observations: Observation[], log: Log) {
  if (!observations.length) return;
  let policy: Policy | undefined;
  try { policy = readTrustedPolicy(); }
  catch { log('policy-diagnostic', { observational: true, reason: 'policy-unavailable' }); }
  for (const observation of observations) {
    const repo = repos.find(repo => repo.name === observation.repository);
    const issue = /^[A-Z][A-Z0-9]{0,15}-[0-9]{1,10}$/.test(observation.identifier) ? observation.identifier : 'unknown';
    // Emit only canonical allowlisted identifiers, never titles, bodies, comment
    // text, arbitrary URLs, or claimed approvals from the issue's read model.
    const pullRequests = [...new Set(observation.pullRequests.flatMap(url => {
      const match = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9][0-9]{0,9})\/?$/);
      return repo && match?.[1].toLowerCase() === repo.slug.toLowerCase() ? [`${repo.slug}#${match[2]}`] : [];
    }))];
    for (const stage of stages) {
      const target = { id: ['spec', 'dispatch'].includes(stage) ? (issue === 'unknown' ? null : issue)
        : pullRequests.length === 1 ? pullRequests[0] : null, sha: null };
      const decision = evaluatePolicy(policy, {
        stage, repository: repo?.name ?? 'unknown', target, policyRevision: policy?.revision ?? 'unknown',
        executorAvailable: 'unknown', capabilities: { approval: false, control: false, deployer: false },
        evidence: [], newDispatch: !observation.existing,
      });
      log('stage-policy', { issue, repository: repo?.name ?? 'unknown',
        runner: ['gpu', 'console', 'orb'].includes(observation.runner ?? '') ? observation.runner : 'unknown',
        observedLifecycleState: ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'].includes(observation.state) ? observation.state : 'unknown',
        stage, target, evidenceIdentifiers: [], classification: 'unknown', dispatchSnapshot: 'unknown',
        policyRevision: policy?.revision ?? 'unknown', trustedMainSha: policy?.trustedMainSha ?? 'unknown', ...decision });
    }
  }
}
