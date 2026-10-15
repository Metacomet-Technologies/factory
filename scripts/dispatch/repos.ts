import { readFileSync } from 'node:fs';

export type Repo = {
  name: string; slug: string; ampProject: string; flow: 'full' | 'simple';
  defaultRunner: 'gpu' | 'console' | 'orb';
  fallbackRunners: Partial<Record<'gpu' | 'console', { checkout: string }>>;
  requiredChecks: string[]; applyWorkflow?: string; maxActiveOrbs?: number;
};

export function validateRepos(value: unknown): Repo[] {
  const fail = () => { throw new Error('Invalid scripts/dispatch/repos.json'); };
  if (!Array.isArray(value) || !value.length) return fail();
  const names = new Set(), slugs = new Set();
  for (const repo of value) {
    if (!repo || typeof repo !== 'object' || typeof repo.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(repo.name)
      || typeof repo.slug !== 'string' || !/^[\w-]+\/[\w.-]+$/.test(repo.slug)
      || typeof repo.ampProject !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.ampProject)
      || names.has(repo.name) || slugs.has(repo.slug.toLowerCase())
      || !['full', 'simple'].includes(repo.flow)
      || !['gpu', 'console', 'orb'].includes(repo.defaultRunner)
      || !repo.fallbackRunners || typeof repo.fallbackRunners !== 'object' || Array.isArray(repo.fallbackRunners)
      || Object.entries(repo.fallbackRunners).some(([runner, config]: [string, any]) =>
        !['gpu', 'console'].includes(runner) || typeof config?.checkout !== 'string'
        || !/^\/home\/agent\/work\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.checkout))
      || (repo.defaultRunner !== 'orb' && !repo.fallbackRunners[repo.defaultRunner])
      || !Array.isArray(repo.requiredChecks) || !repo.requiredChecks.length
      || repo.requiredChecks.some(check => typeof check !== 'string' || !check.trim())
      || new Set(repo.requiredChecks).size !== repo.requiredChecks.length
      || (repo.maxActiveOrbs !== undefined && (!Number.isSafeInteger(repo.maxActiveOrbs) || repo.maxActiveOrbs < 1))
      || (repo.defaultRunner === 'orb' && repo.maxActiveOrbs === undefined)
      || (repo.flow === 'simple' && (typeof repo.applyWorkflow !== 'string' || !repo.applyWorkflow.trim()))
      || (repo.flow === 'full' && (repo.name !== 'factory' || repo.defaultRunner !== 'gpu'
        || repo.applyWorkflow !== undefined || repo.maxActiveOrbs !== undefined
        || repo.slug.toLowerCase() !== 'metacomet-technologies/factory'
        || repo.fallbackRunners.gpu?.checkout !== '/home/agent/work/factory'
        || repo.fallbackRunners.console?.checkout !== '/home/agent/work/factory'))) return fail();
    names.add(repo.name);
    slugs.add(repo.slug.toLowerCase());
  }
  if (!value.some(repo => repo.name === 'factory' && repo.flow === 'full')) return fail();
  return value;
}

export const repos = validateRepos(JSON.parse(readFileSync(new URL('repos.json', import.meta.url), 'utf8')));

export function issueRepo(issue: { labels: { name: string; parent?: { name: string } | null }[] }) {
  const names = issue.labels.filter(label => label.parent?.name === 'repo' || label.name.startsWith('repo/'))
    .map(label => label.name.replace(/^repo\//, ''));
  return names.length <= 1 ? repos.find(repo => repo.name === (names[0] ?? 'factory')) : undefined;
}
