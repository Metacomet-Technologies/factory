# MET-77: frontier CLI usage, limits, and cost collection

Research date: **2026-10-11**. All findings and source accesses below are dated
2026-10-11 unless a source snapshot has a different date. Prices exclude tax
unless noted. This is research, not a collector implementation.

## Recommendation in brief

Use vendor reporting APIs for billed usage, local supported telemetry for live
activity, and account snapshots for quota. Keep these three views separate.
Start with Amp workspace reporting, OpenAI/Anthropic API billing when applicable,
and Cursor reporting **only if Devon has Enterprise access**. Claude Code and
Codex have useful supported local interfaces, including subscription quota.
Kimi Code has a documented but experimental local quota API; the older Kimi CLI
has been archived. Do not equate subscription token estimates with money owed.
Do not scrape dashboards, terminal displays, cookies, or private web endpoints.

### Availability summary

“High” means a documented vendor contract supports the stated measurement, not
that Devon's account was tested. Account access and installed-version behavior
remain **unverified for every tool**. “Partial” identifies incomplete coverage,
not zero usage.

| Tool | Recommended source | Usage: tokens / requests / sessions | Limits or remaining | Cost | Confidence |
| --- | --- | --- | --- | --- | --- |
| Amp | External API: daily usage and thread usage | Yes / yes / thread IDs | Configured workspace entitlements; no documented balance API | Vendor USD usage; BYOK estimate separate | High for API usage; partial for quota |
| Cursor CLI | Enterprise Admin/Organization API; Enterprise server-side OTel | Tokens when reported / usage events / conversation IDs; CLI JSON alone only sessions | Spend caps; Enterprise pooled budget remaining; individual pools unavailable | Vendor `chargedCents`; BYOK provider bill separate | High with Enterprise; low for individual billing automation |
| Cursor cloud agents | Cloud Agents usage API plus Enterprise Admin/Organization API | Tokens / partial request count / agent and run IDs | Spend caps and Enterprise pooled remaining; no universal quota read | Admin API billed usage; cloud usage route has no USD cost | High for cloud tokens; cost conditional on access |
| Claude Code | OTel + status-line JSON; Anthropic reporting APIs for eligible organizations | Yes / API events / session count | Pro/Max 5h and 7d percentages via status line; API configured limits | Local estimates; API cost report for billing | High for documented telemetry; estimated local cost |
| OpenAI Codex CLI | Exec JSON / app-server; OpenAI organization APIs for API-key billing | Yes / API reporting or telemetry / thread IDs | App-server ChatGPT windows and optional credits; API rate-limit headers | API cost report; subscription per-session USD not supplied | High for public interfaces; medium for disk parser |
| Kimi CLI / Kimi Code | Version-specific wire files; replacement's local quota API; Moonshot balance API for PAYG | Tokens / partial / session index | Experimental Code quota/wallet; PAYG account balance | Token-price estimate; no verified Code per-session billing export | Medium for source-backed tokens; experimental quota |

## Evidence and boundaries

- **Documented:** read from official docs or public OpenAPI. **Source-backed:**
  read from a pinned official repository, but persistence formats can change.
  **Unverified:** runtime behavior, account entitlements, or a claim the available
  sources do not establish. Recommendations and polling intervals are proposals,
  not vendor guarantees.
- No CLI was installed, invoked, authenticated, or configured. No account usage,
  transcripts, credentials, production services, or Devon's Mac were inspected.
  Public documentation and upstream source were the evidence.
- A page's current contents are not proof that an older installed CLI supports
  them. Record CLI version and billing model before choosing an adapter.
- Absence here means **no supported contract verified in the cited sources**,
  not proof that a vendor has no internal endpoint. Where an unavailable API
  leaves only a UI, report unknown or accept a manual vendor export. Never
  recommend UI scraping.
- Subscription invoices, consumption of included allowances, credit purchases,
  incremental overages, provider bills, and cloud compute are different amounts.
  They must not share an unlabeled “cost” total.

## 1. Amp

### Billing — documented, 2026-10-11

[Pricing docs](https://ampcode.com/docs/pricing),
[pricing page](https://ampcode.com/pricing), and [terms](https://ampcode.com/terms)
describe Hobby/free, paid individual tiers (Megawatt/Gigawatt), shared workspace
credits, custom Enterprise terms, PAYG paid credits, BYOK, and linked ChatGPT or
Claude subscriptions. Included agent usage resets monthly without rollover;
purchased credits expire after twelve months. Model/tool usage can consume
credits; orb compute has a separate allowance and per-minute charges.

The public page extraction shows **$20/month** for the selected individual tier
and **45,000 orb minutes**, but does not unambiguously expose both tier prices or
their numeric agent allowances. Those details are **unverified**; obtain Devon's
plan/contract instead of hardcoding them. The same pages advertise “No Amp token
fees or limits” for externally supplied tokens: that is not unlimited underlying
provider subscription quota. Non-Enterprise managed model usage is described as
provider API pricing without markup. Enterprise contracts can add platform fees.
BYOK provider charges and linked-subscription allowances belong to the provider;
other Amp services can still consume credits.

### Machine-readable sources — documented, 2026-10-11

Source of truth: [External API](https://ampcode.com/api/external) and
[OpenAPI](https://ampcode.com/api/v2/openapi.json). Base URL:
`https://ampcode.com/api/v2` (use the workspace's required custom domain instead
when configured).

- `GET /workspace/analytics/daily-usage?endDate=YYYY-MM-DD&lookbackDays=N&userID=...`:
  daily, workspace-attributed records, including former members with usage.
  OpenAPI allows 1–365 lookback days. Fields: `data[].date`, `users[].user.id`,
  `metrics.usage` in USD, `models[model].requests`, `inputTokens`, `outputTokens`,
  `cacheReadInputTokens`, `cacheCreationInputTokens`, `totalTokens`, `usage`.
  Model keys identify models. Dates have no epoch unit; confirm reporting-day
  timezone before translating them into timestamps. No publication-lag SLA was
  found. Treat the current day as provisional.
- `GET /threads` returns IDs, `createdAt`, `updatedAt`, `firstSyncedAt` (ISO
  timestamps), creator, and parent/subthread relationships. Pagination uses
  `nextCursor`; `after`/`before` filter **initial sync time**, not later activity.
  Revisit old active threads rather than assuming a created-since watermark
  captures their new usage.
- `GET /threads/{threadID}/usage`: available only for threads **less than 90 days
  old**. Returns `threadID`, `subThreadIDs`, total USD `usage`, and
  `models[]` with `provider`, `model`, `requests`, uncached `inputTokens`,
  `outputTokens`, cache read/write fields, and per-model USD `usage`. It is a
  lifetime thread snapshot, not timestamped per-request history. Included child
  threads are identified explicitly; do not sum parent-inclusive and child totals.
- Both reporting routes expose `estimatedProviderCostAtListPriceUSD` separately.
  This is **experimental**, excludes requests before **2026-08-26**, excludes
  subscription connections, and does not know negotiated prices. Router requests
  can contribute zero because Amp cannot price them. Zero is not evidence of free
  provider usage. Contact Amp before using this estimate for chargeback.
- `GET /workspace/entitlements` (and `/{entitlementID}`) exposes configured
  `type: paid_credits`, `usageLimitUSD`, `windowDays` (1, 7, 30), and user/group/
  default assignments. This is a cap, **not balance or remaining allowance**.
  No consumed amount or window anchor is supplied by that schema. Do not subtract
  generic daily spend and label the result authoritative remaining credits.

[Streaming JSON](https://ampcode.com/docs/cli/streaming-json) documents
`amp --execute <prompt> --stream-json`: NDJSON with `session_id`, optional
`message.usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, and
`cache_creation_input_tokens`. Result `usage` is optional. No billed-cost,
request timestamp, or resolved per-request model field is guaranteed by that
schema; attach collector time and prefer the reporting API. Agent mode is not
necessarily a model. Never run a prompt merely to measure usage.

`amp usage` is officially documented for balance inspection in pricing docs.
A JSON balance option/schema was **not verified**; do not invent `--json` or
parse its terminal layout as a stable API. No supported OTel accounting export or
local session-file accounting schema/path was verified. Prefer the official
remote API, not reverse-engineered CLI storage.

### Auth, freshness, limits, gaps — 2026-10-11

The External API requires a workspace **machine-to-machine application**, OAuth
client-credentials token from `https://auth.ampcode.com/oauth2/token`, and Bearer
authentication. It is workspace-wide, not personal CLI `AMP_API_KEY` auth.
Minimum scopes: `amp.api:workspace.analytics:view` for daily reporting,
`amp.api:workspace.threads.meta:view` for listing/thread usage,
`amp.api:workspace.entitlements:view` for caps. Add
`amp.api:workspace.members:view` only if email attribution is needed. Thread
contents access is unnecessary for accounting; hostname metadata requires the
contents scope, so omit it unless node attribution warrants that broader access.
No numeric reporting-API rate limit or update SLA was verified. Proposed start:
hourly daily-report refresh, daily historical reconciliation, conservative active
thread polling with backoff. Personal balance, included agent/orb remaining, and
exact per-request billing times remain gaps without a supported additional API.

**Placement:** server-side on factory-console with a scoped workspace credential.
Optional stream capture runs beside each existing agent invocation, as that
runner's agent user or on Devon's Mac. It cannot discover unrelated personal
accounts or unsynced local activity.

## 2. Cursor: CLI and cloud agents

### Billing — documented, 2026-10-11

[Models & Pricing](https://cursor.com/docs/models-and-pricing) lists individual
Pro **$20/month**, Pro Plus **$60/month**, Ultra **$200/month**; India-only Start
**₹649/month including tax**. Pro and above have separate monthly **Cursor Models**
and **Other Models** pools. Numeric pool sizes are not specified on that page;
do not reuse older dollar allowances as current facts. Start excludes the Other
Models pool and on-demand usage. Teams has Standard **$40/user/month** and Premium
**$120/user/month**, with Premium 5× Standard Agent limits; Enterprise is custom.
Legacy request-based accounts have different accounting.

Additional usage is metered; third-party models draw at API rates. Teams and
Enterprise add a **$0.25/million-token Cursor Token Rate** on third-party models,
including applicable BYOK and Auto requests; first-party models are exempt.
BYOK provider costs require provider reporting, not Cursor's fee alone. A Cursor
CLI/API key authenticates Cursor; it is **not automatically BYOK inference**.
Do not assume a provider key supported in the editor works identically in CLI or
cloud agents; Devon's routing is unverified.

[Cloud Agents](https://cursor.com/docs/cloud-agent) states selected-model API
pricing, context-size-dependent consumption, and a configured spend limit. Paid
plan eligibility is stated there; the API overview separately labels Cloud Agents
API “Beta (All Plans)”. Resolve Devon's actual eligibility rather than promising
free cloud execution from API availability.

### Machine-readable sources — documented, 2026-10-11

[API overview](https://cursor.com/docs/api) currently lists Admin/Analytics APIs
as **Enterprise**, not universally available to individual or Teams plans.
[Admin API](https://cursor.com/docs/account/teams/admin-api), base
`https://api.cursor.com`:

- `POST /teams/filtered-usage-events`: paginate `page`/`pageSize` (max 1000),
  filter millisecond `startDate`/`endDate`, email/user/service account/cloud agent.
  Both date bounds are **inclusive**; translate an exclusive normalized end to
  `endDate = period_end_ms - 1`. Fields: string epoch-ms `timestamp`, `model`,
  `conversationId` when available, `cloudAgentId` when available,
  `tokenUsage.{inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,totalCents}`
  for token-based calls, `chargedCents`, optional `cursorTokenFee`, `kind`,
  `isChargeable`, `isHeadless`, `requestsCosts`. `requestsCosts` is weighted billing
  units, **not an integer model-request count**. Count raw usage events separately
  and label their semantics. Absence of `cloudAgentId` does not prove CLI origin;
  these routes can include editor activity too.
- Reconcile **`chargedCents / 100`**, not only `tokenUsage.totalCents`, with spend
  reporting. Preserve included-vs-on-demand billing category; included
  consumption is not an extra cash payment.
- `POST /teams/spend`: current cycle `subscriptionCycleStart` (epoch ms),
  `spendCents` (on-demand only), `overallSpendCents` (included plus on-demand),
  `effectivePerUserLimitDollars`, `monthlyLimitDollars`,
  `hardLimitOverrideDollars`. Preserve decimal-cent precision. This exposes
  configured spend limits, not a universal token quota or both included-pool
  balances. Only compute remaining spend when the applicable cap and spend basis
  are confirmed; it remains a derived value.
- `POST /teams/daily-usage-data`: `day`, epoch-ms `date`, per-user activity and
  `agentRequests`, `subscriptionIncludedReqs`, `usageBasedReqs`, `apiKeyReqs`.
  Those are raw usage-event counts, not weighted legacy billable units. Max
  30-day ranges; paginate to include inactive/removed-period members.

[Organization API](https://cursor.com/docs/account/organizations/organization-admin-api.md)
adds a supported Enterprise pooled-budget read:
`POST /organizations/pooled-usage` with `organizationId`. Response
`pool.{limitCents,usedCents,remainingCents,contractStartDate,contractEndDate}`
reports the current contract period; dates are nullable ISO timestamps.
`teams[].{teamId,usedCents,budgetLimitCents?}` gives attribution and optional team
caps. Divide cents by 100; this is organization budget remaining, not individual
Cursor Models/Other Models token allowance. Corresponding
`/organizations/filtered-usage-events`, `/organizations/daily-usage-data`, and
`/organizations/spend` cover linked teams. Organization `spendCents` means
included pool consumption over the contract window, unlike team `spendCents`
(on-demand consumption over a billing cycle). Do not interchange them.

[Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints):
`GET /v1/agents/{id}/usage[?runId=...]` supplies
`totalUsage` and `runs[].{id,usageUuid?,usage}` with `inputTokens`, `outputTokens`,
`cacheWriteTokens`, `cacheReadTokens`, `totalTokens`. Agent/run details supply
`createdAt`/`updatedAt`; usage itself has no timestamp/model/USD amount or request
count. Read run metadata separately, and do not sum `totalUsage` and run totals.
Zero usage may mean **not recorded yet**, not a completed free run.

[CLI output](https://cursor.com/docs/cli/reference/output-format) supports
`agent --print --output-format json|stream-json`. JSON result fields include
`session_id`, optional `request_id`, durations, and text. Stream init has `model`;
some partial assistant events have `timestamp_ms` and `model_call_id`.
**The published schema has no token counts, billed cost, or quota.** Failure can
end without a terminal JSON result. Count sessions from IDs, not lines or tool
calls; optional request ID does not establish all underlying LLM requests.
`agent ls` is session discovery, not a verified JSON billing export.
No supported local CLI accounting-file path/format was verified. Editor databases
are not a documented CLI accounting interface; do not invent a parser for them.

[Enterprise OTel export](https://cursor.com/docs/enterprise/opentelemetry-export)
is **server-side**, covers surfaces including CLI/cloud, and sends OTLP/HTTP binary
protobuf metrics/logs to a team-managed HTTPS destination. Metrics:
`cursor.token.usage` by `cursor.token.type` (input/output/cache_read/cache_creation),
`cursor.cost.usage` (best-effort estimate). Logs: `cursor.api.request`,
`cursor.api.error`, `cursor.api.correction`, with `cursor.conversation.id`,
`cursor.request.id`, `cursor.usage_event.id` where present; dedupe
`cursor.event.id`. Request logs provide token fields under
`cursor.api.request.*`; use the [wire reference](https://cursor.com/docs/enterprise/opentelemetry-export/wire)
for the installed contract. Metrics have delta temporality, at-most-once delivery;
logs are at-least-once. No pre-enable backfill. Corrections can mark matching
usage-event groups not billed. BYOK cost telemetry represents Cursor's fee only.
Use billing APIs for reconciliation. Keep conversation-content export off.

### Auth, freshness, limits, gaps — 2026-10-11

Admin reads use a team administrator-created API key, documented overview scope
`admin:*`, Basic auth with key as username and empty password. This is a powerful
org/team credential; keep it server-side. Do not assume narrower scopes accepted
on other routes cover these usage routes. Cloud API accepts user or service-account
keys with Basic or Bearer auth and visibility tied to that principal.

Organization routes require a separate **Organization API key**, Basic auth,
and `usage:*` scope (`admin:*` also works). Prefer `usage:*` for reporting when
Devon's Enterprise organization supports these routes. Team keys cannot call
organization routes, or vice versa. Pool reads aggregate hourly; poll at most
hourly, within **20 requests/minute**. Organization filtered events have an
explicit **60/minute** override in the API overview.

Daily usage/events aggregate hourly: poll **at most hourly**. Filtered events:
**60 requests/minute/team**; daily usage and most Admin routes: **20/minute**.
Honor 429 and `Retry-After: 60`. Cloud usage has no verified publication SLA;
overview documents default **20/minute** unless overridden. OTel starts about a
minute after enable; delivery is streaming without an accounting completeness SLA.

**Placement:** server-side factory-console for Admin/cloud polling; an approved
public HTTPS OTel receiver if Enterprise telemetry is chosen (do not expose the
existing unauthenticated factory API). Capture CLI session IDs locally on runner
nodes as agent, or Devon's Mac. For individual CLI accounts, automated billing
and included-pool remaining are gaps in the verified interfaces. Manual official
exports are acceptable; authenticated UI/private-endpoint scraping is not.

## 3. Claude Code

### Billing — documented, 2026-10-11

[Pricing](https://claude.com/pricing) and [cost guidance](https://code.claude.com/docs/en/costs)
describe paid Pro/Max/Team/Enterprise subscriptions and separate API/Console or
cloud-provider billing. Pro is **$20/month**, or **$200/year**; Max starts at
**$100/month**, with 5×/20× Pro usage options. Paid app activity and Claude Code
share rolling five-hour and weekly usage; token counts do not translate into a
fixed allowed message count. Team has Standard/Premium seats; Enterprise pricing
page states **$20/seat/month plus API-rate usage, billed annually**. Exact Team
seat prices and Devon's contract are unverified here. Extra usage/API credits are
distinct from included subscription use. Current Max pages also advertise API
credits: do not confuse that separate API allowance with Claude app quota.

### Local machine-readable sources — documented, 2026-10-11

[Monitoring](https://code.claude.com/docs/en/monitoring-usage) is the preferred
prospective collector: opt-in `CLAUDE_CODE_ENABLE_TELEMETRY=1` and OTLP exporters.
It works across subscription/API/cloud-provider setups. Proposed future changes
require Devon's approval; nothing was configured in this research.

- Metrics `claude_code.token.usage` with `type=input|output|cacheRead|cacheCreation`
  and `model`; `claude_code.cost.usage` USD estimate;
  `claude_code.session.count`. Input excludes cache; add all three input categories
  for inclusive normalized input. Session count measures starts, not necessarily
  unique resumed conversation IDs.
- Log event `claude_code.api_request`: `event.timestamp` ISO time, `model`,
  `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
  estimated `cost_usd`/`cost_usd_micros`, duration. Retain `session.id`, process/
  event identity and `event.sequence` for ordering/deduplication. Count successful
  model usage separately from request attempts and API errors.
- Default export intervals: **60,000 ms metrics**, **5,000 ms logs**; default OTLP
  metric temporality **delta**, optional cumulative. Never sum repeated cumulative
  samples. CLI versions before **2.1.214** can overcount some progressively
  reported streaming usage. Costs remain estimates even with managed contracted
  `modelPricing`. Do not enable prompt/tool/raw-body logging for accounting.

[Status-line JSON](https://code.claude.com/docs/en/statusline) gives a supported
local quota feed after the first response for **claude.ai Pro/Max**:
`rate_limits.five_hour` and `seven_day`, each `used_percentage` and Unix-second
`resets_at`. Windows may be independently absent and disappear after expiry.
Record observation time; remaining percentage is 100 minus used percentage,
**not remaining tokens**. This is a local callback, not a remote polling API.
`model.id`, `session_id`, `transcript_path`, `cost.total_cost_usd` are also supplied.
**`context_window.*` is latest context capacity, not cumulative consumption or
subscription remaining.** Behind a Claude apps gateway, optional spend-limit
fields include `used_usd`, `limit_usd`, `period`; those dollar snapshots may be
about five minutes old and are estimated.

[Headless output](https://code.claude.com/docs/en/headless) documents
`claude -p <prompt> --output-format json`, or
`--output-format stream-json --verbose`. Result includes session/usage metadata,
`total_cost_usd`, per-model `modelUsage`. [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
documents model-map `inputTokens`, `outputTokens`, `cacheReadInputTokens`,
`cacheCreationInputTokens`, `costUSD`. Use `modelUsage` for whole-tree tokens:
result `usage` excludes subagents, while `modelUsage` and total cost include them.
Resumes restore earlier spend, so upsert/difference snapshots instead of summing
each result. Per-assistant `output_tokens` can be a **placeholder**; parallel
tool messages can repeat the same API message ID. Prefer finalized results or
OTel rather than adding assistant messages. Crashes can produce zeroed result
fields: mark incomplete, not free.

[Hooks](https://code.claude.com/docs/en/hooks) documents transcript discovery via
`transcript_path`, usually `~/.claude/projects/<project-key>/<session-id>.jsonl`,
and subagents under `<session-id>/subagents/agent-<id>.jsonl`. Files are written
asynchronously; a Stop hook does not guarantee the latest turn is on disk.
The conventional assistant-record fields `timestamp`, `sessionId`, `message.id`,
`message.model`, `message.usage` are an **unverified persistence contract** here,
not a guaranteed complete accounting schema. Use only a version-tested fallback;
dedupe message IDs, include subagents once, and do not export transcript content.

### Organization APIs — documented, 2026-10-11

[Usage & Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)
on `https://api.anthropic.com`:

- `GET /v1/organizations/usage_report/messages`: 1m/1h/1d buckets, ISO
  `starting_at`/`ending_at`, model/API-key/workspace grouping. Token fields in the
  [reference](https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages)
  include `uncached_input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation` components; preserve cache TTL categories. This is org API
  traffic, not a personal Pro/Max quota read or CLI session count.
- `GET /v1/organizations/cost_report`: daily-only buckets; USD **decimal strings
  in cents**, grouped by workspace/description. Divide by 100 using decimal
  arithmetic. Includes token/server-tool charges; **Priority Tier costs excluded**.
  Data typically arrives within **5 minutes**, sometimes longer. Vendor supports
  sustained polling **once/minute**, faster short pagination bursts.
- [Claude Code Analytics](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api):
  `GET /v1/organizations/usage_report/claude_code?starting_at=YYYY-MM-DD`, UTC
  daily records with `actor`, `core_metrics.num_sessions`,
  `model_breakdown[].model`, `tokens.{input,output,cache_read,cache_creation}`,
  `estimated_cost.{amount,currency}` (USD cents). Only activity older than one
  hour is included. These costs are **estimates**, not the cost report.
- [Rate Limits API](https://platform.claude.com/docs/en/manage-claude/rate-limits-api):
  `GET /v1/organizations/rate_limits` and
  `/v1/organizations/workspaces/{id}/rate_limits?include_inherited=true` return
  grouped configured `limits[].{type,value}` for RPM/input/output TPM and other
  resources. They do not supply live token-bucket remaining. Use observed
  `anthropic-ratelimit-*` [response headers](https://platform.claude.com/docs/en/api/rate-limits)
  for that snapshot, if already available; do not generate inference to sample it.

Admin API is unavailable to individual accounts. Auth: Admin key (`x-api-key`)
plus `anthropic-version: 2023-06-01`, OAuth `org:admin`, or eligible non-workspace
personal/service-account key. Workspace API keys do not work. Claude Enterprise
uses a **different Analytics key/API**, not a Console Admin key; see
[Analytics APIs](https://platform.claude.com/docs/en/manage-claude/analytics-api).
Do not promise the Console route for Enterprise subscription users or treat the
response's `customer_type=subscription` as proof of individual API access.
Bedrock/Vertex/Foundry billing comes from their provider; Console reporting does
not cover it. No numeric limit for the Code analytics/rate-limit reporting routes
was verified; use hourly/daily collection and backoff.

**Placement:** OTel and status-line callback on each used runner as agent and on
Devon's Mac if he codes there; central authenticated receiver. Org reporting
server-side on factory-console. No remote individual Pro/Max billing/remaining
API was verified. Status-line percentages provide supported local remaining;
they do not reveal exact token allowance or extra-usage cash bill.

## 4. OpenAI Codex CLI

### Billing — documented, 2026-10-11

[Codex pricing](https://learn.chatgpt.com/codex/pricing) distinguishes ChatGPT
subscription/credits from API-key PAYG. Plus **$20/month**; Pro **$100/$200/$500
per month**; Business/Edu/Enterprise depend on seats/credit or contracted billing.
Free/Go availability has surface/rollout restrictions; inclusion does not promise
CLI access. Local/cloud activity shares subscription allowance and currently
shares with ChatGPT Work. Plus/Standard Business have five-hour usage estimates
and possible weekly limits; Pro currently has **no five-hour limit**. Never
hardcode the historical 5h/7d pair for every account.

Additional ChatGPT credits have a separate per-model token rate card and speed
multipliers. **API token prices are not a way to price included subscription
tasks**. Use the account's credit purchase price/contract for actual money, not
a universal USD-per-credit assumption. API-key use is ordinary model token
billing, with API limits and no ChatGPT cloud features.

### Supported local interfaces — documented, 2026-10-11

[Non-interactive mode](https://learn.chatgpt.com/codex/non-interactive-mode):
`codex exec --json <prompt>` emits JSONL; `thread.started.thread_id` identifies
session; `turn.completed.usage` contains `input_tokens`, `cached_input_tokens`,
`output_tokens`, `reasoning_output_tokens` in the current example. Input includes
cached tokens; do not add cached input twice. Completed turn usage is not a
request count or billed cost. Capture only existing invocations, not new paid
prompts. `--ephemeral` deliberately omits persistent rollouts.

[App-server](https://learn.chatgpt.com/codex/app-server) provides JSON-RPC over
local stdio. After `initialize` and `initialized`, read-only methods include:

- `account/read`: account/auth/plan context.
- `account/rateLimits/read`: current ChatGPT `rateLimits`, optional
  `rateLimitsByLimitId`; each window `primary`/`secondary` supplies `usedPercent`,
  `windowDurationMins`, `resetsAt` (**Unix seconds**), plus optional `planType`,
  `credits` (`balance`, `hasCredits`, `unlimited`), server limit state and earned
  reset credits. Preserve bucket IDs. Credit balance is not USD, and reset
  credits are not spend credits. `ordinaryUsageAllowed` is separately authoritative
  when supplied; do not infer permission from percentages alone.
- `account/rateLimits/updated`: observed updates, not a historical usage export.
  Source-backed sparse updates require merging/refetching rather than erasing
  omitted data. Percentages are rounded on the app-server interface.
- `account/usage/read`: `summary.lifetimeTokens`, `peakDailyTokens`, activity
  fields, optional `dailyUsageBuckets[].{startDate,tokens}`. This is aggregate
  token activity, not a per-model input/output bill. Requires Codex-services-backed
  auth; API-key-only and Bedrock auth do not work.
- `thread/tokenUsage/updated`: thread usage notifications for controlled agent
  integrations. Never add snapshots as if they were per-request deltas.

Use already authenticated Codex under the same OS user. This is not an Admin API
or a reason to copy `auth.json` to the collector server. Local/open-source
integrations are documented; app-server auth is not permitted for commercial or
hosted services without the appropriate Sign in with ChatGPT arrangement. Keep
the proposed account collector local. No quota-read publication SLA or numeric
rate limit was verified; proposed cadence is 5 minutes plus updates/backoff.
No inference is required for the account read. Never call reset-consume, login,
logout, or owner-email methods as part of measurement.

[Advanced configuration](https://developers.openai.com/codex/config-advanced)
documents opt-in `[otel]` OTLP log export, with prompts redacted by default.
Events include `codex.api_request`, `codex.sse_event` (token counts on
`response.completed`), websocket events, conversation/model/version metadata.
Optional metrics count transport attempts/errors; those differ from billed model
requests. Export batches asynchronously and flushes on shutdown; no export-lag
SLA or USD billing metric is established. Verify websocket and auxiliary/subagent
coverage against the installed version before treating it as complete.

### Local files — source-backed, inspected 2026-10-11

Official [source snapshot](https://github.com/openai/codex/commit/8c0f7011674145da7e10627769fb221c74fbf7a0)
dated **2026-10-11**. Root `$CODEX_HOME`, default `~/.codex`.
`sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl` and
`archived_sessions/` contain internal JSONL envelopes with `timestamp`, `type`,
`payload`, optional `ordinal`. Reverted-thread filenames can have an extra
rollout ID; use logical IDs from contents, not filename alone.

- `type=event_msg`, `payload.type=token_count`:
  `info.total_token_usage` cumulative, `last_token_usage` last incorporated
  usage, `model_context_window`, optional `rate_limits`. These can include
  synthetic context-fill updates; they are **not exact request accounting**.
- New `type=token_usage_record`, `payload.usage` is best-effort one-response usage;
  `response_id`, `thread_id`, `turn_id`, `session_id` permit deduplication.
  `turn_token_usage`/`thread_token_usage` are cumulative snapshots.
- Token objects: `input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`,
  `total_tokens`. Preserve components; never add reasoning output blindly on top
  of output without confirming inclusion semantics for that provider/version.
- Model attribution comes from surrounding `turn_context`/settings (`model`,
  `model_provider_id`), not quota `normal_model_slug`. Envelope timestamp gives
  event time. Disk rate-limit windows use `used_percent`, `window_minutes`,
  `resets_at` (seconds); stale observations do not equal a live read.

Sources: [rollout formats](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/history/src/rollout_payload.rs),
[token and quota structures](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/protocol/src/protocol.rs),
[app-server account types](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/app-server-protocol/src/protocol/v2/account.rs),
[rollout recorder](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/rollout/src/recorder.rs).
Pin/version-test parsers. Current diagnostics can use bounded local stores;
`<log_dir>/codex-tui.log` requires explicit logging configuration. Do not assume
an old default plaintext log path or use prompt history as a usage ledger.

### Server reporting — documented, 2026-10-11

For **API-key billing only**, OpenAI organization APIs, base
`https://api.openai.com/v1`, authenticated with an organization **Admin API key**:

- [Usage completions](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions):
  `GET /organization/usage/completions`, Unix-second `start_time` inclusive /
  `end_time` exclusive, 1m/1h/1d buckets, group by `model`, `project_id`,
  `api_key_id`, `user_id`, service tier. Results include `input_tokens` (cache
  inclusive), `input_cached_tokens`, cache-write fields, `output_tokens`,
  `num_model_requests`, bucket `start_time`/`end_time`, cursor pagination.
- [Costs](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs):
  `GET /organization/costs`, daily buckets, `amount.value` and
  `amount.currency` (`usd` in example), dimensions such as project/line item.
  `amount.value` is currency units, **not Anthropic-style cents**. Model attribution
  may be absent: do not spread org cost among models without marking it estimated.
- [API rate limits](https://platform.openai.com/docs/guides/rate-limits/overview)
  are org/project/model scoped. Existing responses can supply
  `x-ratelimit-limit-*`, `x-ratelimit-remaining-*`, `x-ratelimit-reset-*` for requests
  and tokens. They describe short-term rate buckets, not ChatGPT subscription
  quota or prepaid cash balance.

Use dedicated CLI API keys/projects for attribution; shared keys also bill other
apps. No reporting publication-lag SLA or numeric polling rate was verified in
these references. Proposed hourly usage and daily cost reconciliation, with
backfill and 429 handling. These endpoints do **not** report ChatGPT subscription
usage. API-key response usage remains useful without an Admin credential, but
bill reconciliation is then unavailable.

[ChatGPT Analytics API](https://learn.chatgpt.com/codex/enterprise/analytics-api)
documents separate workspace daily ChatGPT/Codex/Work reporting with Admin scope
`enterprise.analytics.usage.read`; `codex.enterprise.analytics.read` does not
grant that unified endpoint. Confirm workspace enablement. The linked
[Admin reference](https://chatgpt.com/public/admin/api-reference) exposes a shell
through the reader, while direct fetch returned 403. Exact routes, schema,
freshness/rate limits and cost/remaining coverage are **unverified** here; do not
invent endpoints. This is a possible later Enterprise reporting path, not the
personal-plan default.

**Placement:** exec/OTel/disk collectors on each runner as agent and Devon's Mac
where used; local app-server account reads on one existing authenticated node
per account. API usage/cost or eligible workspace reporting runs server-side.
Personal subscription per-session USD cost and dollar conversion of included
quota remain unavailable without account-specific billing data.

## 5. Kimi CLI and its replacement, Kimi Code CLI

### Product and billing — documented, 2026-10-11

The official [legacy repository](https://github.com/MoonshotAI/kimi-cli) and
[migration notice](https://moonshotai.github.io/kimi-cli/en) say Python Kimi CLI is
**archived** and replaced by [Kimi Code](https://github.com/MoonshotAI/kimi-code).
The PyPI name `kimi-code` can refer to the legacy alias, so ask for implementation
and version, not command name alone. Do not install or migrate anything for this
task. Original data survives migration; avoid counting migrated history twice.

[Membership](https://www.kimi.com/code/docs/en/kimi-code/membership.html) describes
new Plus-and-above coding access; Go has no coding quota. New plans retain rolling
5h and monthly total quota, **no weekly cap**; legacy subscribers retain weekly
and 5h rules. Devices and coding keys share account quota, also used by other
Kimi surfaces. [Global plan page](https://www.kimi.ai/code/) displays Plus/Pro/
Max/Ultra monthly **$19/$39/$99/$199**, with annual effective monthly
**$15/$31/$79/$159**. Exact token allowances, regional terms, and Devon's legacy
status are unverified; do not derive allowance from price.

Extra Usage is a prepaid wallet shared with Kimi web, consumed after included
quota, with optional monthly spending cap. The mainland membership docs describe
**RMB**; always read returned currency, never assume USD. This is different from
[Kimi Open Platform](https://platform.kimi.ai/docs/guide/product-plans.md), which
has **API-key PAYG/top-ups, not a subscription**. Provider endpoint/account region
determines its billing. A Code API key is not an Open Platform billing key.

### Replacement local records — source-backed, inspected 2026-10-11

[Official snapshot](https://github.com/MoonshotAI/kimi-code/commit/c9f01f07388abc2cdca40c9c5267f58c65086710)
dated **2026-10-10**. [Data locations](https://github.com/MoonshotAI/kimi-code/blob/c9f01f07388abc2cdca40c9c5267f58c65086710/docs/en/configuration/data-locations.md):
root `$KIMI_CODE_HOME` or `~/.kimi-code`; `session_index.jsonl` indexes
`sessionId`, `sessionDir`, `workDir`.
`sessions/<workDirKey>/<sessionId>/agents/<agentId>/wire.jsonl` holds main and
subagent events. `workDirKey` is `wd_<slug>_<12-char-sha256-prefix>`.
Session `state.json` carries metadata; per-session/global `logs/kimi-code.log`
are diagnostics, not a billing ledger.

Durable JSONL `type: usage.record` includes `agentId`, `model`,
`usage.{inputOther,output,inputCacheRead,inputCacheCreation}`, optional
`usageScope` (`turn`/`session`), and `time` (**Unix ms**; may be missing in older
records). These are **additive contributions**, not cumulative simply because
scope says session. Live status `byModel`, `total`, `currentTurn` are cumulative:
choose one representation, not both. `usage.raw` may carry provider-native data.
Sum three input components for inclusive input. No request ID/turn ID is guaranteed
on durable usage records; exact model-request counts cannot be established merely
by counting them. Use session identity plus file offsets for ingestion idempotency.
Read every agent wire file once; avoid adding parent rollups again.

Sources: [usage record schema](https://github.com/MoonshotAI/kimi-code/blob/c9f01f07388abc2cdca40c9c5267f58c65086710/packages/agent-core-v2/src/agent/usage/usageOps.ts),
[serialization/time](https://github.com/MoonshotAI/kimi-code/blob/c9f01f07388abc2cdca40c9c5267f58c65086710/packages/agent-core-v2/src/app/event/event2.ts),
[accumulation](https://github.com/MoonshotAI/kimi-code/blob/c9f01f07388abc2cdca40c9c5267f58c65086710/packages/agent-core-v2/src/session/usage/usageAgentModel.ts).

[Current command docs](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
document `kimi -p <prompt> --output-format stream-json`, assistant/tool transcript
events, and `kimi export <sessionId> -o <file.zip> --no-include-global-log`.
Export includes session files and, by default, global logs containing other
projects. Do not upload raw ZIPs. JSON output is not a guaranteed cost/quota
report; `kimi provider list --json` can expose raw provider configuration, so do
not ingest it as usage or copy secrets. No supported OTel accounting export was
verified for either Kimi implementation.

### Replacement quota — documented experimental, 2026-10-11

[Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
documents `GET /api/v1/oauth/usage` on an **existing** local `kimi web` instance,
default loopback **58627**, with Bearer local-server token. Do not start a server
or change configuration during research. A future local adapter must keep it
loopback-only and not use `--dangerous-bypass-auth`.

The response envelope is `{code,msg,data,request_id}`. Successful
`data={kind:"ok",quota}` contains `quota.usages` entries `limit5h`, `limit7d`,
`monthTotal`, `monthCode`, each optional `{usedRatio,resetAt?}` (0–1 ratio,
RFC3339 reset). `extraUsage` may contain `balanceCents`, `totalCents`,
`monthlyChargeLimitEnabled`, `monthlyChargeLimitCents`, `monthlyUsedCents`,
`currency`. Remaining ratio is 1 minus used ratio, not tokens. Currency-aware
wallet amounts are account-wide, not Kimi CLI session costs. Errors can return
HTTP success but `data.kind="error"`; inspect both layers.

Quota is fetched live from the managed account service. The REST/WebSocket API is
explicitly **experimental**; use the installed server's `/openapi.json` and
`/asyncapi.json` as version-specific contracts. No numeric quota-read rate limit
or freshness SLA was verified. Proposed cadence: 5 minutes with backoff, once per
account, not each session. Auth requires both an already logged-in managed Kimi
account and the local server token. The source's upstream `/coding/v1/usages`
endpoint is internal implementation evidence, **not a verified public cloud API**;
do not call it directly by extracting OAuth credentials. [Quota implementation](https://github.com/MoonshotAI/kimi-code/blob/c9f01f07388abc2cdca40c9c5267f58c65086710/packages/oauth/src/managed-usage.ts).

### Archived Python CLI — source-backed, inspected 2026-10-11

[Legacy snapshot](https://github.com/MoonshotAI/kimi-cli/commit/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82)
dated **2026-09-22** uses `~/.kimi/sessions/<work-dir-md5>/<session-id>/` with
`context.jsonl`, `wire.jsonl`, `state.json`. Wire files begin with a
`type=metadata` protocol-version header, then records
`{timestamp,message:{type,payload}}`; `timestamp` is floating Unix **seconds**.
`StatusUpdate.payload.token_usage` is current-step usage, `message_id` can
correlate it, and `context_tokens`/`max_context_tokens` describe context, not quota.
Token fields come from its provider library; the exact installed serialization
and repeated-step/subagent completeness are **unverified** here. Model attribution
is not guaranteed by that StatusUpdate schema. Do not apply the replacement's
camelCase `usage.record` parser to legacy files.

Sources: [legacy wire types](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/wire/types.py),
[wire file envelope](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/wire/file.py),
[session layout](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/session.py).
Legacy `kimi --print --output-format stream-json`/Wire mode and `/usage` are
historical interfaces; no stable legacy JSON account-quota command was verified.
Keep a legacy parser lower priority unless Devon actually uses it.

### Open Platform PAYG — documented, 2026-10-11

[Balance API](https://platform.kimi.ai/docs/api/balance):
`GET https://api.moonshot.ai/v1/users/me/balance`, Bearer `MOONSHOT_API_KEY`, returns
`code`, `status`, `data.available_balance`, `voucher_balance`, `cash_balance`,
**USD** on the global platform. This is the account wallet, not Code subscription
quota. Mainland accounts use their matching endpoint/key; regional keys are
independent. Mainland currency and exact endpoint contract must be confirmed
against Devon's platform rather than converted implicitly.

[Chat API](https://platform.kimi.ai/docs/api/chat) provides response `id`, `model`,
`created` (Unix seconds), and usage token counts; [streaming](https://platform.kimi.ai/docs/guide/utilize-the-streaming-output-feature-of-kimi-api)
describes final usage. Read already retained provider usage or CLI records; do
not instrument inference by changing routing for this task. Estimate token cost
using dated [pricing](https://platform.kimi.ai/docs/pricing/chat), preserving cache
and tool charges. No historical account cost/usage Admin API or CLI-attributed
cash bill was verified in the official [index](https://platform.kimi.ai/docs/llms.txt).
**Balance changes are not spend**: top-ups, voucher expiry, refunds, and other
clients confound subtraction.

[Rate limits](https://platform.kimi.ai/docs/pricing/limits) depend on cumulative
recharge/account tier: published global Tier0 has **3 RPM / 500,000 TPM /
1,500,000 TPD**, Tier1 **100 RPM / 2,000,000 TPM / unlimited TPD**; higher/custom
tiers differ. These are inference capacity, not a verified balance-read limit.
No live remaining-inference-quota API or balance publication SLA was verified.
Search 429 response headers have their own separate limits. Do not reuse them
as chat-model quota.

**Placement:** wire readers on each used runner as agent and on Devon's Mac;
experimental Code quota reads on one already authenticated local node per
account. Global PAYG balance polling can run server-side with a dedicated key.
Code session USD cost remains estimated/unknown; RMB wallet values need explicit
currency/FX handling, never silent coercion to `cost_usd`.

## Normalized record and accounting rules

Proposed minimum shape (synthetic example, not an observed account):

```json
{
  "tool": "codex",
  "source": "codex.exec.turn.completed",
  "period_start_ms": 1791676800000,
  "period_end_ms": 1791680400000,
  "model": null,
  "input_tokens": 12000,
  "output_tokens": 900,
  "requests": null,
  "cost_usd": null,
  "limit": null,
  "remaining": null,
  "confidence": "reported_usage"
}
```

1. `tool`: `amp`, `cursor`, `claude-code`, `codex`, `kimi`. `source` identifies
   interface and record grain, not merely vendor. Model is nullable when source
   does not report it. Keep Kimi implementation/version and billing model in
   source metadata.
2. UTC Unix milliseconds; periods are **start-inclusive/end-exclusive**. Convert
   provider seconds explicitly. Preserve vendor bucket timezone; display in
   America/New_York only at presentation. A daily total cannot establish
   millisecond event times. A thread lifetime snapshot cannot establish historical
   daily deltas: differences describe an observation interval and stay provisional.
3. `input_tokens` means total input **including cache read/write once**;
   `output_tokens` follows provider output semantics. Unknown token/request counts
   remain null, not zero. Keep cache/uncached/reasoning components as metadata so
   cost estimates remain possible. Do not add cache to OpenAI's inclusive input.
4. `requests` means reported model requests when available. Otherwise null, with
   separately labeled observed usage-event/attempt counts. Sessions are a distinct
   metric: preserve `session_id`/`thread_id`, and report unique sessions separately.
   This minimum shape cannot encode session counts on its own; keep them in
   companion summaries, never overload `requests`.
5. `cost_usd` is a known USD usage amount or an explicitly labeled estimate, never
   a subscription fee silently divided among sessions. Preserve `cost_basis`
   (`billed_usage`, `included_consumption`, `list_price_estimate`, `contract_estimate`)
   and billing category. Monthly subscriptions belong in a separate billing
   ledger. Unsupported currency or missing price keeps `cost_usd=null`; preserve
   original amount/currency and optional dated FX as metadata.
6. `limit`/`remaining` are nullable **objects**, not unlabeled scalars. For example:
   `limit={"kind":"subscription_window","unit":"percent","value":100,
   "window_ms":18000000,"reset_at_ms":...}` and
   `remaining={"unit":"percent","value":76.5}`. For Kimi ratio convert to percent;
   for spend caps use USD; for credit wallets use credits and account scope. Emit
   one quota snapshot per independent window/pool, with null usage/cost fields;
   it is not additive. No numeric token maximum is implied by “100%”.
7. `confidence`: `billed_report`, `reported_usage`, `estimated`, `partial`,
   `unknown`. It applies to that record's claim. A record with reported tokens
   and estimated cost should be split or keep per-field confidence in metadata;
   never badge estimated cost as billed because tokens are reliable.
8. Required sidecar metadata: account/workspace/user identity (nonsecret IDs),
   host, CLI version, billing model, provider, observation time, freshness/coverage,
   source row ID or file offset, session lineage, cache fields, cost basis, and
   whether amount/remaining is derived. The requested flat fields alone cannot
   safely distinguish multiple accounts, dedupe, or represent corrections.
9. Upsert stable IDs or replace whole aggregate buckets. Never add successive
   cumulative snapshots. Do not sum local usage plus vendor reporting for the
   same activity; reporting reconciles/replaces it. Keep provider bills from
   BYOK distinct from host-tool fees, and avoid counting linked subscriptions
   under both Amp and native CLI. Where attribution is impossible, expose a
   shared-account total rather than inventing tool attribution.
10. Ingest only complete JSONL lines; checkpoint file identity/offset, detect
    truncation/rotation and migrations, handle unknown fields and missing terminal
    events. Keep stale last-good data with its age; failed auth is unknown, not
    zero. Fetch paginated reports with overlap and reconcile late corrections.

## Collector placement

- **Every used runner node, agent user:** Claude/Codex OTel or existing-run output;
  optional version-pinned Claude/Codex/Kimi file readers. That user's home is the
  visibility boundary. Root is unnecessary. Collect usage metadata locally and
  forward only normalized records, never prompts/transcripts/provider secrets.
- **Devon's Mac, Devon's user:** the same adapters for sessions that actually run
  there; it is not a proxy for sessions on runners. Use local status-line/app-server
  quota where that account is already authenticated. Poll shared accounts from
  one selected node, not every node.
- **Server-side API calls, factory-console:** Amp workspace reporting, entitled
  Cursor Admin/cloud reads, OpenAI/Anthropic org reporting, and Moonshot PAYG
  balance. Keep privileged credentials outside the kiosk/agent-controlled repo.
  Central APIs cover cloud agents; there is no need to read a cloud VM's home.
- **OTel receiver:** authenticated TLS endpoint. Claude/Codex can use a private
  tailnet receiver; Cursor Enterprise requires public reachable HTTPS. Do not
  expose factory-api's unauthenticated listener to satisfy Cursor delivery.

## Phased plan

### Phase 0: choose sources, no deployment

Devon supplies the account/tool inventory below. Check installed versions and
read-only eligibility with approved credentials. Do not request all-vendor Admin
keys or enable telemetry until a used billing model needs them. Save a redacted
fixture for each selected contract, including missing usage, resumes, subagents,
late corrections, currency, and multiple quota windows.

### Phase 1: reliable vendor numbers first

1. Amp workspace daily/model usage and paid-credit USD usage. Prefer daily
   reports for historical windows; use thread reports for drilldown and sessions.
   Archive reports before the thread endpoint's 90-day cutoff matters.
2. OpenAI/Anthropic org usage and billing reports **if Devon pays through those
   API organizations**. Separate CLI key/workspace/project makes attribution
   reliable. Reconcile bills daily; do not replace them with local estimates.
3. Cursor Enterprise usage/spend and organization pooled remaining if entitled;
   independently, cloud agent API token totals if Devon uses cloud agents.
   Without Enterprise, show cloud tokens and unknown money rather than
   reverse-engineer personal billing endpoints.
4. Moonshot PAYG balance if used: reliable wallet snapshot, not spend history.

### Phase 2: live usage and subscription quota

Add Claude OTel + supported status-line quota, Codex existing-run JSON/OTel +
local app-server quota/account activity. These provide useful current counters
and quota without UI scraping. Reconcile API-paid usage against Phase 1.
For subscriptions display quota, measured usage, and fixed plan fee separately;
per-session dollar cost stays null or plainly estimated. Cursor Enterprise OTel
is optional when hourly reporting is too slow, not a prerequisite for billing.

### Phase 3: experimental and historical fallbacks

Only if used: Kimi Code wire parsing and experimental local quota/wallet read;
legacy Kimi and Claude/Codex disk parsers for missing history. Pin versions, test
fixtures, document partial coverage, and disable unsupported formats rather than
emit incorrect zeros. Missing individual billing or included-pool balance remains
unknown; a manually supplied official export can supplement it. No UI scraping.

## Decisions Devon needs to make

1. Which tools actually run: Amp, Cursor CLI/editor/cloud agents, Claude Code,
   Codex CLI/cloud, legacy Kimi CLI or replacement Kimi Code? Which runner nodes
   and which Mac user/home? Which versions and existing ephemeral sessions?
2. For **each tool/account**, subscription tier and legacy/new status, personal
   vs workspace/org ownership, billing-cycle start, currency, included pools,
   overage/Extra Usage settings, spend caps, BYOK/provider/region, discounts and
   linked subscriptions. Amp/Cursor can route to several billing sources.
3. Does Devon have Amp workspace M2M access, Cursor **Enterprise** reporting,
   Anthropic Console org Admin/Enterprise Analytics access, OpenAI API Admin or
   ChatGPT workspace Analytics access? Who can issue appropriately scoped keys?
4. Does “cost” mean cash billed, included-quota consumption, list-price equivalent,
   or total monthly subscription plus overage? Are orb/cloud compute and paid
   tools included? May non-USD costs be converted, using which FX/date policy?
5. Is scope only agent-user work on runners, or Devon's personal editor/web usage
   too? Shared quota can include non-CLI activity; should dashboard show account
   remaining beside tool-attributed tokens without claiming they reconcile?
6. Is hourly/daily reporting enough, or are live limits needed? Approve local
   telemetry/status callbacks and experimental Kimi service access separately.
   Choose data retention, allowed identity fields, and private vs public receiver.

## Verification status

Official docs/public schemas and pinned upstream source were inspected on
2026-10-11. Runtime fields, credentials, plan access, exact local installed
versions, billing reconciliation, and vendor reporting lags were **not tested**.
Research is ready for source/architecture review, not a claim that collectors
already exist or that Devon's accounts expose every documented interface.
