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
// MET-190 capture: auto-reload note is server-rendered and identity is redacted.
export const ampAutoReload = `Signed in as redacted@example.invalid (redacted)
**Amp Gigawatt Tier:** agent usage $170.29 of $200 remaining (85%), orb usage 997.2h of 1,000h a1.xxlarge orb hours remaining (100%) - period 2026-10-10 to 2026-11-10, resets upon renewal in 25 days
**Individual credits:** $10 remaining (set up auto-reload to avoid running out) - https://ampcode.com/settings
**Workspace metacomet:** $0 remaining - https://ampcode.com/workspaces/metacomet

# Run \`amp usage --details\` for more detailed information.
`;
export const detailsAutoReload = `# Usage

${ampAutoReload.split('\n').slice(0, 4).join('\n')}

Range: 2026-10-10T04:03:59.039Z to 2026-10-16T04:40:00.000Z (end exclusive; current tier period so far)
Total recorded cost: $29.71
Total orb usage: 2.8h

## How to Read Recorded Costs

Recorded costs describe usage within the selected range and do not change quota balances.

## Amp Tier: Agent Usage Pool

Tier agent usage drawn in the selected range, by the model or feature that consumed it.

| Source | Recorded cost |
| --- | ---: |
| **All sources** | **$29.71** |
| Opus 5.5 | $28.60 |
| Fable 5.1 | $0.92 |
| Web Extract | $0.12 |
| Web Search | $0.07 |

## Amp Tier: Orb Usage Pool

Orb hours used in the selected range.

| Source | a1.xxlarge orb hours |
| --- | ---: |
| **All sources** | **2.8h** |
| Orb | 2.8h |
`;
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
// Logged-out `agent about --format json` was captured from Cursor Agent 2026.10.16-e3cb207.
// A live signed-in tier was Ultra. This fixture stays Pro; the email must never reach a snapshot.
export const cursorAbout = {
  cliVersion: '2026.10.16-e3cb207', latestStatus: 'up_to_date', latestVersion: '2026.10.16-e3cb207', model: 'Auto',
  subscriptionTier: 'Pro', osPlatform: 'linux', osArch: 'x64', userEmail: 'redacted@example.invalid',
  terminalProgram: 'unknown', shell: 'bash', lastRequestId: 'private-request-id',
};
export const cursorLoggedOut = { ...cursorAbout, subscriptionTier: null, userEmail: null, lastRequestId: null };
// Kimi Code 2.2.0 schema. USD cents and monthTotal are reconstructed.
// A live logged-in probe returned kind ok, usages limit5h and limit7d only, and currency null.
export const kimiUsage = { code: 0, msg: 'success', request_id: 'privateRequestId0123456789', data: { kind: 'ok', quota: {
  usages: {
    limit5h: { usedRatio: 0.2, resetAt: '2026-10-17T06:00:00Z' },
    limit7d: { usedRatio: 0.08, resetAt: '2026-10-20T00:00:00Z' },
    monthTotal: { usedRatio: 0.35, resetAt: '2026-11-01T00:00:00Z' },
    monthCode: { usedRatio: 0.1, resetAt: '2026-11-01T00:00:00Z' },
  },
  extraUsage: { balanceCents: 1250, totalCents: 5000, monthlyChargeLimitEnabled: false, monthlyChargeLimitCents: 0, monthlyUsedCents: 100, currency: 'USD' },
} } };
export const kimiLoggedOut = { code: 0, msg: 'success', request_id: 'abcDEF1234567890abcdEF1234', data: { kind: 'error', message: 'No token for "kimi-code". Run /login to authenticate.' } };
// Live key set only. Ratios are synthetic; the probe printed keys and currency, not values.
export const kimiLive = { code: 0, msg: 'success', request_id: 'liveShapeRequestId012345678', data: { kind: 'ok', quota: {
  usages: {
    limit5h: { usedRatio: 0.5, resetAt: '2026-10-17T06:00:00Z' },
    limit7d: { usedRatio: 0.25, resetAt: '2026-10-20T00:00:00Z' },
  },
  extraUsage: { currency: null },
} } };
// OpenCode 1.19.3 `stats` text. Counts are shape checks only; the snapshot keeps Total Cost.
export const opencodeStats = `┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                          1,234 │
│Messages                                             56 │
│Days                                                 12 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                       $12.50 │
│Avg Cost/Day                                      $1.04 │
│Avg Tokens/Session                                 1.2K │
│Median Tokens/Session                               800 │
│Input                                             12.5K │
│Output                                             3.4K │
│Cache Read                                         1.0M │
│Cache Write                                           0 │
└────────────────────────────────────────────────────────┘
`;
// OpenCode 2.0.32 `stats --all --cost`. Rows have two leading spaces. Counts are shape checks only.
export const opencodeV2Stats = `all time · all projects

COST & TOKENS
  cost                $12.50
  input               12.5k
  output              3.4k
  reasoning           800
  cache read          1m
  cache write         0
  cached input        7.41%
`;
// Live 2.0.32 `stats --all --cost` with no activity.
export const opencodeV2Zero = `all time · all projects

COST & TOKENS
  cost                $0.00
  input               0
  output              0
  reasoning           0
  cache read          0
  cache write         0
  cached input        0.00%
`;
// Live 2.0.32 default card. It has no cost line and must not become a zero balance.
export const opencodeV2ShareCard = `opencode stats · 2026 so far · all projects

no activity in this range

opencode.ai
`;
export const versions = {
  amp: '0.0.1791763306-ged595a (released 2026-10-12T00:01:46.000Z, 1d ago)', ampAutoReload: '0.0.1792108872-gab0eb7 (released 2026-10-16T04:40:00.000Z, 1h ago)',
  claude: '2.1.296 (Claude Code)', codex: 'codex-cli 0.162.1', agent: '2026.10.16-e3cb207', kimi: '2.2.0', opencode: '1.19.3',
};
export async function fixtureRun(program: string, args: string[]) {
  if (args[0] === '--version') return versions[program];
  if (program === 'amp') return args.includes('--details') ? details : amp;
  if (program === 'claude') return claude;
  if (program === 'codex') return JSON.stringify(codex);
  if (program === 'agent') return JSON.stringify(cursorAbout);
  if (program === 'kimi') return JSON.stringify(kimiUsage);
  if (program === 'opencode') return opencodeStats;
  throw new Error('Unexpected probe');
}
