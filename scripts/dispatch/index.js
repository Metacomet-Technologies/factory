// Node's explicit directory test entry point: node --test scripts/dispatch.
import { describe } from 'node:test';
import { availableParallelism } from 'node:os';

describe('dispatcher', { concurrency: Math.min(2, availableParallelism()) }, async () => {
  await import('./dispatch.test.ts');
  await import('./policy.test.ts');
});
