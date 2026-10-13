// MET-121 values. Identity redacted; Claude/Codex envelopes reconstructed from
// the documented projections. Amp pool table headings checked on GPU 2026-10-13.
export const amp = `Signed in as redacted@example.invalid (redacted)
**Amp Gigawatt Tier:** agent usage $171.27 of $200 remaining (86%), orb usage 998.1h of 1,000h a1.xxlarge orb hours remaining (100%) - period 2026-10-10 to 2026-11-10, resets upon renewal in 29 days
**Individual credits:** $0 remaining - https://ampcode.com/settings

# Run \`amp usage --details\` for more detailed information.
`;
// MET-137 capture: quota text unchanged, sign-in identity redacted.
export const ampNew = `Signed in as redacted@example.invalid (redacted)
Amp Gigawatt Tier: agent usage $170.30 of $200 remaining (85%), orb usage 997.4h of 1,000h a1.xxlarge orb hours remaining (100%) - period 2026-10-10 to 2026-11-10, resets upon renewal in 27 days
Workspace metacomet: $0 remaining - https://ampcode.com/workspaces/metacomet
`;
export const details = `# Usage

${amp.split('\n').slice(0, 3).join('\n')}

## Amp Tier: Agent Usage Pool

Tier agent usage drawn in the selected range, by the model or feature that consumed it.

| Source | Recorded cost |
| --- | ---: |
| **All sources** | **$28.75** |
| Opus 5.5 | $28.60 |
| Web Extract | $0.09 |
| Web Search | $0.06 |

## Amp Tier: Orb Usage Pool

| Source | a1.xxlarge orb hours |
| --- | ---: |
| **All sources** | **1.9h** |
| Orb | 1.9h |

## From

| Source | Tokens | Recorded cost |
| --- | ---: | ---: |
| Amp | 40,538,496 | $28.75 |
| ChatGPT | 259,800,000 | $0 |
`;
// New details retain Markdown and add report sections after the summary block.
export const detailsNew = details.replace(amp.split('\n').slice(0, 3).join('\n'),
  ampNew.trimEnd().replace('Amp Gigawatt Tier:', '**Amp Gigawatt Tier:**').replace('Workspace metacomet:', '**Workspace metacomet:**'))
  .replace('\n## Amp Tier: Agent Usage Pool', '\nRange: 2026-10-10T04:03:59.039Z to 2026-10-13T06:33:04.226Z (end exclusive; current tier period so far)\n\n## How to Read Recorded Costs\n\nReport explanations are not quota pools.\n\n## Amp Tier: Agent Usage Pool');
export const claude = [
  { type: 'assistant', usage_report: { rate_limits: { limits: [
    { kind: 'session', group: 'session', percent: 13, resets_at: '2026-10-12T03:10:00.988448+00:00', scope: null, severity: 'normal', is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 12, resets_at: '2026-10-15T23:00:00.988471+00:00', scope: null, severity: 'normal', is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: '2026-10-15T23:00:00+00:00', scope: { model: { display_name: 'Fable' }, surface: null }, severity: 'normal', is_active: false },
  ], extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 0, utilization: null, currency: 'USD' } } } },
  { type: 'result', is_error: false, num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
].map(value => JSON.stringify(value)).join('\n');
export const codex = { jsonrpc: '2.0', id: 2, result: {
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1792299781 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '62500' } },
  rateLimitResetCredits: { availableCount: 3, credits: [{ id: 'private-reset-credit-id' }] },
  accountId: 'private-account-id',
} };
export const versions = { amp: '0.0.1791763306-ged595a (released 2026-10-12T00:01:46.000Z, 1d ago)', claude: '2.1.296 (Claude Code)', codex: 'codex-cli 0.162.1' };
export async function fixtureRun(program: string, args: string[]) {
  if (args[0] === '--version') return versions[program];
  if (program === 'amp') return args.includes('--details') ? details : amp;
  if (program === 'claude') return claude;
  if (program === 'codex') return JSON.stringify(codex);
  throw new Error('Unexpected probe');
}
