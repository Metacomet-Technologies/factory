# MET-77 / MET-89: frontier CLI usage, limits, cost, and user attribution

Research date: **2026-10-11**. All findings and source accesses below are dated
2026-10-11 unless a source snapshot has a different date. Prices exclude tax
unless noted. This is research, not a collector implementation.

MET-89 adds attribution to **Devon or David**, with per-user and combined views.
Use stable internal user IDs, verified vendor-account mappings, and explicit
shared/unattributed records. An OS user named `agent` does not identify a person.

## Recommendation in brief

Use vendor reporting APIs for billed usage, local supported telemetry for live
activity, and account snapshots for quota. Keep these three views separate.
Start with Amp workspace reporting, OpenAI/Anthropic API billing when applicable,
and Cursor Admin API reporting (Teams and Enterprise; Teams verified 2026-10-17). Claude Code and
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
| Cursor CLI | Teams/Enterprise Admin API (Teams verified 2026-10-17); Enterprise Organization API and server-side OTel | Tokens when reported / usage events / conversation IDs; CLI JSON alone only sessions | Spend caps; Enterprise pooled budget remaining; individual pools unavailable | Vendor `chargedCents`; BYOK provider bill separate | High with Enterprise; low for individual billing automation |
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

### User attribution (MET-89) — 2026-10-11

The [External API](https://ampcode.com/api/external) daily report's
`users[].user.id` is the strongest per-user usage/cost dimension. Map vendor IDs
to `devon` or `david`; optional email needs `workspace.members:view`. The M2M
credential identifies the workspace application, not the person consuming usage.
`creatorUserID` from thread listing identifies the creator, not necessarily every
participant or billing account on a shared thread. Prefer daily per-user rows;
do not assign an entire parent/subthread usage total to its creator when identity
can differ. Streaming JSON session IDs need a trusted invocation/account mapping.
Shared credits and group/default entitlements remain workspace/group scoped;
do not duplicate their limits under both people. Amp user attribution alone does
not identify the owner of a linked Claude/ChatGPT subscription or workspace BYOK
key; preserve a separately confirmed billing-account mapping, otherwise unknown.

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

[API overview](https://cursor.com/docs/api) labels the Admin/Analytics APIs
“Enterprise teams”, but **Teams has the Admin API: verified 2026-10-17**. On
Devon's Teams plan an Admin API key (`admin:*`, Settings → Advanced → Admin API
Keys) returned 200 for `GET /teams/members`, `POST /teams/spend` and
`POST /teams/filtered-usage-events`. That spend response also carried
undocumented `maxUserSpendCents` and `limitedUsersCount`. The MET-221 collector
reads spend and events hourly; see `scripts/usage/README.md`. Individual plans
remain without it.
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

### User attribution (MET-89) — 2026-10-11

[Admin usage events](https://cursor.com/docs/account/teams/admin-api) expose
`userEmail` for human activity and optional `serviceAccountId`/`serviceAccountName`.
Daily rows and spend rows also provide user attribution; organization variants
add `teamId`. Map these identities to Devon/David, not the admin-key creator.
Organization pooled budget is shared and cannot be split into individual quota.
For [cloud agents](https://cursor.com/docs/cloud-agent/api/endpoints),
`GET /v1/me` returns `userId`/`userEmail` for user-scoped keys; these fields are
absent for service-account/team keys. `GET /v1/agents` lists the authenticated
user's agents; bind usage to that verified principal, or join `cloudAgentId` to
Admin usage events. A key name or ability to read an agent does not prove human
ownership. Shared service-account activity stays unattributed unless a trusted
per-run launch record identifies the person. CLI JSON session IDs alone lack
account identity; use invocation/account mapping, not runner hostname. BYOK
provider account ownership remains separate from Cursor's consuming user.

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

### User attribution (MET-89) — 2026-10-11

[OTel standard attributes](https://code.claude.com/docs/en/monitoring-usage)
include authenticated `user.account_uuid`, `user.account_id`, `user.email`, and
`organization.id` when available. Map account IDs to Devon/David; account metrics
can be disabled via `OTEL_METRICS_INCLUDE_ACCOUNT_UUID`. Ordinary `user.id` is an
anonymous installation ID, **not a Claude account ID**; gateway-authenticated
sessions instead use the IdP subject. Direct API-key/cloud-provider sessions lack
Claude account identity: use a trusted per-user launch mapping or approved custom
`OTEL_RESOURCE_ATTRIBUTES` (for example `enduser.id`), not shared `agent` home.
Status-line/transcript session IDs do not independently identify a subscription;
bind quota to the authenticated account at observation time. Do not infer owners
of historical sessions from the account currently logged in.

[Code Analytics](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api)
identifies `actor.type=user_actor` through `email_address`, or `api_actor` through
`api_key_name`. A shared API key does not identify either human. API usage can be
grouped by dedicated `api_key_id`/workspace; map only exclusive keys/workspaces.
The org cost report groups by workspace/description, not individual actors: a
dedicated workspace can support per-user cost; shared workspace cost cannot be
split authoritatively. Any allocation by token share remains an estimate.

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

### User attribution (MET-89) — 2026-10-11

[App-server `account/read`](https://learn.chatgpt.com/codex/app-server), with
`refreshToken:false`, reports ChatGPT `account.type`, nullable `email`, and
`planType`; map the verified account to Devon/David and bind quota snapshots to
it. API-key mode reports `type=apiKey` without a human owner. Exec JSON and rollout
thread IDs are not proof of account ownership; retain identity at invocation time
or an exclusive, time-bounded home/account mapping. Current account info cannot
establish whose subscription paid for historical files after an account switch.

OpenAI [usage reporting](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions)
supports `user_id`, `api_key_id`, and `project_id` grouping. Map returned IDs to
people; shared/service keys require trusted launch attribution and must not be
assigned to the key creator. [Cost reporting](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs)
has project/line-item dimensions, not a guaranteed per-human cost breakdown.
Dedicated projects allow per-user billing attribution; shared project costs stay
shared, or receive an explicitly estimated allocation. ChatGPT workspace Analytics
per-user schema remains unverified here; do not assume it can split the workspace.

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

### User attribution (MET-89) — 2026-10-11

[Kimi Code local API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
`GET /api/v1/oauth/userinfo` identifies the managed account with `userId`,
`globalId?`, `region`, and optional email. Use nonsecret IDs plus region to map
the subscription to Devon/David; check envelope and `data.kind` as with quota.
Fetch identity alongside quota, rather than assuming the local Bearer token names
the user. Wire `agentId` is an agent identity, not a human/account ID. Both new
and legacy files need trusted invocation or time-bounded home/account mapping;
their documented usage fields do not identify the subscription owner.
Moonshot PAYG balance is account-wide and has no per-user usage split. Map a
credential reference to its confirmed billing account without copying the key.
Dedicated keys plus local launch attribution can distinguish activity, but do
not create separate balances when keys share one wallet. Shared wallet/subscription
remaining stays shared; no verified org API splits it by Devon and David.

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
  "user": "devon",
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
   Include `account_owner`, `attribution_basis`, and time-bounded identity mappings
   so the human using a shared account is not confused with its billing owner.
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

### Per-user and combined views (MET-89)

`user` is `"devon"`, `"david"`, or `null`, using stable internal IDs rather than
display names or vendor emails. It identifies the person to whom this record's
claim can be attributed. Documented account identity is the default basis;
trusted per-run launch identity can attribute shared-account activity to David
while `account_owner` remains Devon. Record that distinction, never infer it.
Shared or unidentified activity, org bills, and shared quota have `user=null`
with metadata distinguishing `shared` from `unknown`; they are not zero usage.

- **Devon / David:** filter attributed usage by `user`. Show coverage gaps and
  shared-account context separately; a person's activity is not necessarily
  charged to their own subscription. Unknown billed cost remains null even if
  local tokens are attributable. Include a subscription fee only once per account.
- **Combined:** sum reconciled additive Devon/David usage and include disjoint
  shared/unattributed usage once, labeled separately. Org totals that overlap
  per-user rows are reconciliation totals, not additional usage. Report sessions
  using account/tool/session identity, not session ID alone.
- **Limits/remaining:** show snapshots by billing account and quota window, not
  sums across users. If both people use one pool, link the same snapshot in their
  views and display it once in combined view. Never split a percentage/budget
  equally or add snapshots from two nodes. Do not imply missing user coverage is
  complete merely because an organization total is available.

## Collector placement

- **Every used runner node, agent user:** Claude/Codex OTel or existing-run output;
  optional version-pinned Claude/Codex/Kimi file readers. That user's home is the
  visibility boundary, not Devon/David identity. Preserve per-invocation identity
  when both people share `agent`; otherwise report unattributed activity.
  Root is unnecessary. Collect usage metadata locally and
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

Devon and David supply the account/tool inventory below, including vendor-ID,
credential-reference, home, and subscription-owner mappings with effective dates.
Check installed versions and
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
   For Devon and David, which vendor IDs/emails, keys/projects/workspaces, and
   subscriptions are exclusive or shared? Can launches identify the initiating
   person on shared runner accounts? Who owns each billing account?
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

## Verified on the runners (MET-121, 2026-10-12)

Contributes MET-77. These observations supplement, rather than rewrite, the
2026-10-11 research above. Checks ran as `agent` on **factory-console**, around
2026-10-12 02:31–02:33 UTC (2026-10-11 evening America/New_York). They do not
by themselves establish factory-gpu's installation, login, or environment.
The follow-up incorporates Devon's verified Mac/GPU results and his 2026-10-12
collector decision from [MET-121's comments](https://linear.app/metacomet/issue/MET-121/verify-amp-and-claude-code-usage-and-quota-sources-on-the-runners).
Devon's checks are attributed below; this thread did not repeat them remotely.

Installed versions: Amp `0.0.1791763306-ged595a`, released
`2026-10-12T00:01:46.000Z`; Claude Code `2.1.296`.
No production endpoint, running runner configuration, persistent Amp/Claude
setting, login/logout, credential creation, or authenticated settings page was
changed. Exactly **three `claude -p` invocations** ran: two tiny inference prompts
and one local `/usage` command. No Amp inference probe, new runner, or orb ran.

### Summary

“Verified” distinguishes observed account behavior from a documented contract.
Freshness is observation granularity, not a vendor latency guarantee.

| Source | Verified yes/no/partial | Evidence | Freshness | Works headless? | Recommended for the collector? |
| --- | --- | --- | --- | --- | --- |
| Amp account / plan | Yes, console | `account list --json`; `usage` | Command-time snapshot | Yes | Identity inventory only |
| Amp workspace / M2M eligibility | No workspace membership on console | CLI membership error; Devon decides no workspace | Command-time check | CLI check yes; creation UI only | No; not pursued |
| Amp balance CLI | Yes, text only | Exact `amp usage` output below; Devon's Mac result agrees | Poll every 15 min; current tier period | Yes | Yes; strict versioned parser, explicit exception |
| Amp account detail CLI | Yes, text only | `amp usage --details` here and in Devon's comments | Hourly; range totals | Yes | Yes; strict patterns, unknown on format mismatch |
| Amp thread detail CLI | Yes, text only | B's detailed report; Devon confirms real-thread reports | Hourly, at most 10 dispatched threads; lifetime totals | Yes | Yes; `--details`, strict patterns, transient unavailability stays unknown |
| Amp External API | Partial, docs only | Official reference/OpenAPI; Devon declines workspace/API | Daily buckets / lifetime totals | Documented yes | No; not pursued |
| Claude `/usage` structured report | Yes, console; experimental schema | Third invocation emits `assistant.usage_report` | Server quota snapshot on command | **Yes**, `-p --output-format stream-json --verbose` | **Yes for Max quota**, version-pin and validate nullable fields |
| Claude status-line JSON | Partial | Official 5h/7d schema; callback absent in both print probes | After response / UI update | **Not observed in `-p`** | No for Amp's headless launches |
| Claude result / stream usage | Yes, console | `usage`, `modelUsage`; stream also has rate-limit event | Per response / run totals | Yes | Existing-launch capture if available; never send inference to poll usage |
| Claude OTel | Partial | Official schema/config; console-export attempts produced no telemetry records | Default metrics 60s, logs 5s | Documented programmatic support; export unverified here | Preferred supported source for future usage, after approval and delivery test |
| Claude local transcripts | Partial | Metadata-only inspection of existing MET-116 SDK sessions | Appended messages; cumulative cost-state checkpoints | Reader yes | Not primary: disk accounting format is not a stable public contract |
| Claude installation/login on factory-gpu | Yes, Devon verified | MET-121 comment: agent, 2.1.296, claude.ai, Max | 2026-10-12 check | Auth status yes; Amp launch unprobed | GPU local sources available; launch/export coverage still needs verification |
| ChatGPT quota via Codex app-server | Yes, Devon verified on GPU; same account on both nodes | codex-cli 0.162.1; `account/rateLimits/read` | Poll every 15 min; live account snapshot | Yes; keep stdin open until id 2 response | Yes on GPU; whether Amp uses this same limit remains unverified |

### Official sources and modified dates

Fetched live on 2026-10-12 UTC. Amp dates are HTML `article:modified_time`.
“Not published” means the fetched page supplied neither that metadata nor an
HTTP `Last-Modified` date in the checks; it does **not** mean last modified today.
Claude's public Markdown and HTML were read; no undocumented service was called.

| Official source | Published modified date |
| --- | --- |
| [Amp CLI](https://ampcode.com/docs/cli) | 2026-09-25 |
| [Amp Pricing](https://ampcode.com/docs/pricing) | 2026-09-14 |
| [Amp Workspaces](https://ampcode.com/docs/collaborate/workspaces) | 2026-10-07 |
| [Amp External API](https://ampcode.com/api/external), [OpenAPI](https://ampcode.com/api/v2/openapi.json) | Not published / no dated schema revision verified |
| [Claude status line](https://code.claude.com/docs/en/statusline) | Not published |
| [Claude monitoring](https://code.claude.com/docs/en/monitoring-usage) | Not published |
| [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) | Not published |
| [Claude commands](https://code.claude.com/docs/en/commands), [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless](https://code.claude.com/docs/en/headless) | Not published; fetch date only recorded |
| [Claude data usage](https://code.claude.com/docs/en/data-usage), [application data](https://code.claude.com/docs/en/claude-directory#application-data) | Not published; fetch date only recorded |

### 1. Amp account, plan, workspace and API eligibility

Actually run, read-only:

```sh
amp --version
amp --help
amp account list --help
amp account list
amp account list --json
amp usage --help
amp usage
amp projects list --help
amp projects list
amp plugins repositories
amp skill repositories
amp secrets list --help
amp secrets list --workspace --json
amp oauth-clients list --help
amp oauth-clients list
```

`amp account list --json` returns:

```json
{"accounts":[{"userID":"user_01M4HXF8RNSZZXSS3AY4S99W2G","email":"devon@metacomet.tech","active":true}]}
```

`amp usage` names `dgarbs51` and **Gigawatt**. The workspace query returns
`Error: You are not a member of any workspace`. This is stronger evidence than
inferring membership from credits or projects. The repository listings show only
personal repositories, and projects list only `dgarbs51/contextward`; neither
alone would prove absence of a workspace. `account list` does not expose a plan,
workspace name, or workspace ID. `oauth-clients list` requires an explicit
namespace and, without it, fails with
`Error: error: required option '--workspace <namespace>' not specified`.
It is not an automatic workspace-discovery or M2M-provisioning command.

Thus this console CLI account currently has **no workspace in which to create
an External API application**. No conclusion about GPU's saved account follows.
Gigawatt is an individual tier, not proof of workspace membership or Enterprise.
The official External API is workspace-scoped M2M, not a personal `AMP_API_KEY`
reporting API. **Devon's decision, 2026-10-12: no workspace and no External API.**
The historical provisioning steps below are not next steps for this collector.

### 2. Amp balance and archived thread usage

Exact stdout from `amp usage` (exit 0, non-TTY):

```text
Signed in as devon@metacomet.tech (dgarbs51)
**Amp Gigawatt Tier:** agent usage $171.26 of $200 remaining (86%), orb usage 998.1h of 1,000h a1.xxlarge orb hours remaining (100%) - period 2026-10-10 to 2026-11-10, resets upon renewal in 29 days
**Individual credits:** $0 remaining - https://ampcode.com/settings

# Run `amp usage --details` for more detailed information.
```

Help advertises only `--details`, `--start <timestamp>`, `--end <timestamp>`
as usage-specific options. **No machine-readable flag is advertised.** The global
`--stream-json` flag is documented for execute-mode conversations, not accounting
commands. It is not evidence of a JSON balance export; no guessed flag was tried.

The detailed account report was also read. It distinguishes net current balance
from gross range costs before restored credits, and normalizes included orb hours
to the tier's default size. It includes a terminal comment saying account/thread
usage lookups share **60 requests/hour**. That observed limit is not a verified
External API limit. Devon deliberately approves strict parsing of these CLI
outputs for MET-77; see the versioned exception and shared polling budget below.
This does not make the terminal layout a supported vendor schema.

Actually run on existing archived [MET-116 probe B](https://ampcode.com/threads/T-01a12dac-9d56-736b-b4c1-a3e5d1a4da79), without resuming or waking an executor:

```sh
amp usage --details
amp threads usage --help
amp threads usage T-01a12dac-9d56-736b-b4c1-a3e5d1a4da79
amp threads usage T-01a12dac-9d56-736b-b4c1-a3e5d1a4da79 --details
```

Exact plain thread stdout (exit 0):

```text
MET-116 probe B
Usage information is currently unavailable for this thread.
Details: https://ampcode.com/threads/T-01a12dac-9d56-736b-b4c1-a3e5d1a4da79/usage

# Run `amp threads usage <thread-id> --details` for more detailed information.
```

Exact detailed thread stdout (exit 0):

```text
# Thread Usage

## MET-116 probe B

Scope: Entire lifetime of this thread, including 0 subagent threads.

Cost: $0
Total tokens: 47,230
Input tokens: 47,130 (23,473 cache reads)
Output tokens: 100
Requests: 2
ChatGPT was used for some inference, with an estimated token list price of $0.01.
This cost reflects only Amp credits consumed. It does not include any model provider usage billed directly to customer-managed model provider keys.
This estimate uses public list prices. It does not include provider discounts, commitments, router fees, or subscription usage. Amp does not bill it.

## Credits

| Type | Cost |
| --- | ---: |
| Amp paid tier (covered) | $0 |

## Models

| Model | Requests | Input | Output | Amp cost | Est. list price |
| --- | ---: | ---: | ---: | ---: | ---: |
| GPT-5.6 Luna | 2 | 47,130 | 100 | $0 | $0.01 |

## Model Routing

| Model ID | Purpose | Routing | Requests | Cost |
| --- | --- | --- | ---: | ---: |
| openai/gpt-5.6-luna | Agent | Via [ChatGPT](https://ampcode.com/settings/model-routing#c374519b-deee-4eb1-b39c-aade32fbdeac) | 2 | $0 |
```

Thread help advertises `--details`, `--start`, and exclusive `--end`; no JSON
option. The contradictory plain/detailed availability results mean a successful
exit and “unavailable” text cannot establish absence of accounting records.

**Documented machine fields:** External API `threadID`, `subThreadIDs`, `usage`
(USD), `models[].provider`, `model`, `requests`, uncached `inputTokens`,
`outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, and experimental
`estimatedProviderCostAtListPriceUSD`. Daily reports expose dates, user IDs,
metrics and per-model counts. Entitlements expose configured caps, not remaining.
Thread reporting is limited to threads less than 90 days old.

**Terminal-only observations, not an API schema:** personal tier name, remaining
agent dollars, normalized orb-hour allowance, renewal text, individual credits,
covered-credit rows, routing links, role labels, and account range tables.
CLI “Input” here includes cache reads; API `inputTokens` excludes them. Do not
copy terminal arithmetic into API normalization. The displayed ChatGPT estimate
also differs from the public API description, which excludes subscription
connections from BYOK list-price estimates. No API response was obtained to
reconcile that difference; subscription inference is not a per-token bill.

### 3. Claude Code Max quota and headless checks

`claude --version`, `--help`, `auth --help`, `auth status --help`, and
`claude auth status` actually ran. Status returns `loggedIn: true`,
`authMethod: "claude.ai"`, `apiProvider: "firstParty"`,
`email: "devon@metacomet.tech"`, `subscriptionType: "max"`, and
`projectsDirectory: "/home/agent/.claude/projects"`. It does not expose quota
or distinguish Max 5× from 20×. No auth file or token was read.

Supported interfaces and their boundaries:

1. **`/usage` / `/cost`:** official commands describe plan limits; `/cost` is now
   an alias. The SDK reference explicitly documents sending `/usage` as a
   prompt and receiving `assistant.usage_report`. The experimental structured
   type requires Agent SDK v0.3.273+, a claude.ai credential with a known plan
   or `user:profile` scope, and no usage-based billing. A setup-token credential
   with only `user:inference` does not qualify by default. The installed CLI
   **successfully exposes this in print mode**, without model inference.
2. **Status-line JSON:** documents `rate_limits.five_hour` and `seven_day`, each
   with `used_percentage` (0–100) and `resets_at` (epoch seconds), available
   after the first response for Pro/Max. Missing windows are valid; expired
   windows are dropped. In both successful print probes below, the configured
   callback never created its output file. This investigation does not establish
   an interactive callback's actual values; it establishes no callback in those
   headless cases. Do not use a TUI or terminal scraper to work around this.
3. **Print JSON / stream:** the final result has `usage` and `modelUsage`, not
   5h/7d quota. The second probe's stream emits `rate_limit_event`, including
   observed `rate_limit_info.unifiedWindows.five_hour` and `.seven_day` with
   fractional `utilization` and epoch-second `resetsAt`. Values were 0.13 / 0.11.
   The public SDK rate-limit type documents status and optional utilization/reset
   but **does not document `unifiedWindows`** in the fetched reference. Preserve
   such events for diagnostics; prefer the documented `/usage` report contract
   over those extra runtime fields.
4. **OTel:** documents tokens, costs, events and sessions, not a Max 5h/7d quota
   metric. Do not infer quota from context percentage or token totals. The
   Anthropic API's rate limits and organization reporting are not Devon's Max
   subscription allowance. Claude's usage settings UI is a manual interface,
   not a supported headless collector endpoint.

Third invocation, actually run (02:32:40 UTC):

```sh
claude -p '/usage' --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources '' --no-session-persistence --output-format stream-json --verbose --prompt-suggestions false > .amp/in/evidence/usage-stream.txt 2> .amp/in/evidence/usage-stream.err
```

Exit 0; `result.is_error=false`, `num_turns=0`, all input/output/cache token
counts 0, `total_cost_usd=0`. The assistant's **structured metadata**, not
terminal text, contains:

```json
{
  "rate_limits": {
    "limits": [
      {"kind":"session","group":"session","percent":13,"resets_at":"2026-10-12T03:10:00.988448+00:00","scope":null,"severity":"normal","is_active":true},
      {"kind":"weekly_all","group":"weekly","percent":12,"resets_at":"2026-10-15T23:00:00.988471+00:00","scope":null,"severity":"normal","is_active":false},
      {"kind":"weekly_scoped","group":"weekly","percent":0,"resets_at":"2026-10-15T23:00:00+00:00","scope":{"model":{"display_name":"Fable"},"surface":null},"severity":"normal","is_active":false}
    ],
    "extra_usage":{"is_enabled":true,"monthly_limit":2000,"used_credits":0,"utilization":null,"currency":"USD"}
  }
}
```

The session row describes the 5-hour meter; `weekly_all` is the account weekly
meter. Preserve `kind`, `group` and scoped rows rather than assuming exactly two
windows. These `resets_at` values are **ISO timestamps**, unlike status-line
epoch seconds. Extra-usage amounts are currency minor units: 2000 USD cents is
$20, not $2,000. Session cost is a local estimate, not extra-usage spend.
The weekly report differs from the earlier response-header snapshot (12% versus
11%); neither is a token-derived value. Record observation time and source.

First two invocations, actually run, with per-invocation status-line settings:

```sh
claude -p 'Reply OK only.' --tools '' --disable-slash-commands --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources '' --no-session-persistence --output-format json --settings '{"statusLine":{"type":"command","command":"jq -c \u0027{session_id, rate_limits}\u0027 >> /home/agent/work/factory-met-121-usage-sources/.amp/in/evidence/statusline.jsonl"},"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"1","OTEL_METRICS_EXPORTER":"console","OTEL_LOGS_EXPORTER":"console","OTEL_TRACES_EXPORTER":"none","OTEL_LOG_USER_PROMPTS":"0","OTEL_LOG_ASSISTANT_RESPONSES":"0","OTEL_LOG_TOOL_DETAILS":"0","OTEL_LOG_TOOL_CONTENT":"0","OTEL_LOG_RAW_API_BODIES":"0"}}' > .amp/in/evidence/print-json.txt 2> .amp/in/evidence/print-json.err
CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=console OTEL_LOGS_EXPORTER=console OTEL_TRACES_EXPORTER=none OTEL_LOG_USER_PROMPTS=0 OTEL_LOG_ASSISTANT_RESPONSES=0 OTEL_LOG_TOOL_DETAILS=0 OTEL_LOG_TOOL_CONTENT=0 OTEL_LOG_RAW_API_BODIES=0 claude -p 'Reply OK only.' --tools '' --disable-slash-commands --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources '' --no-session-persistence --output-format stream-json --verbose --prompt-suggestions false --settings '{"statusLine":{"type":"command","command":"jq -c \u0027{session_id, rate_limits}\u0027 >> /home/agent/work/factory-met-121-usage-sources/.amp/in/evidence/statusline.jsonl"}}' > .amp/in/evidence/print-stream.txt 2> .amp/in/evidence/print-stream.err
```

Both exit 0 and report success. Status-line output is absent; stderr is empty.
Neither capture contains console OTel exports, despite per-invocation opt-in.
This is not a successful OTel delivery test, nor proof that headless telemetry
cannot work. No fourth invocation, persistent telemetry setting, receiver,
runner restart, or debug-log/content inspection was attempted.

### 4. Claude usage in Amp-launched sessions and transcripts

Metadata-only projection read existing
`~/.claude/projects/-tmp-met116-probe/*.jsonl`, never printing or copying
`message.content`, attachments, prompts, responses, tool arguments/results or
titles. MET-116 probe H's timing and two-message SDK session match
`e20899c2-200f-4055-ad97-bbc6770782fe.jsonl`; the sibling session
`8772ef3b-3364-49f9-95ee-22c1cc4df56b.jsonl` has one assistant message.
Both record `entrypoint: "sdk-ts"`, version `2.1.296` and model
`claude-opus-5-5`. This ties the two-message session to the earlier probe by
timing/cwd, **not by a documented Amp-thread-to-Claude-session ID mapping**.

Observed accounting metadata:

* Top-level `sessionId`, `timestamp` (ISO), `uuid`, `parentUuid`, `requestId`,
  `apiBlockIndex`, `isSidechain`, `version`, `cwd`, `entrypoint`.
* Assistant `message.id`, `message.model`, `message.usage.input_tokens`,
  `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
  Additional usage keys include `cache_creation`, `output_tokens_details`,
  `server_tool_use`, `service_tier`, `speed`, `iterations`, `inference_geo`,
  and `fallback_credit`; their presence is not a promise of an accounting schema.
* `type: "cost-state"` checkpoints contain `modelUsage` keyed by model, including
  Opus and Haiku entries, with `inputTokens`, `outputTokens`,
  `cacheReadInputTokens`, `cacheCreationInputTokens`, `thinkingTokens`,
  `webSearchRequests`, `costUSD`; also `totalCostUSD`, `startTime`, duration and
  line totals. These are **cumulative checkpoints**, not additive request rows.
  They can include auxiliary model activity absent from main assistant messages.
* Official application-data docs describe per-session JSONL and subagent files
  under `<session-id>/subagents/`. No such subagent JSONL
  files were found in the inspected console projects tree. No subagent was
  launched to manufacture evidence; actual subagent deduplication remains untested.

The public SDK warns that several assistant records can share one `message.id`.
A disk reader must not sum every block or add checkpoints to message totals.
The SDK documents message/output usage, but the local JSONL accounting format
is not a stable collector contract. Default local retention is 30 days and
session persistence can be disabled. A central GPU service also cannot read
console's home by magic. Never copy whole transcripts to factory-api.

**Prefer OTel for future runs:** documented `claude_code.token.usage` by model
and `type` (`input`, `output`, `cacheRead`, `cacheCreation`),
`claude_code.session.count`, and `claude_code.api_request` events carrying
`session.id`, model, request identifiers, timestamps and component token counts.
Input excludes cache: add input + cache read + cache creation once. API-event
counts are distinct from prompts and sessions. Cost metrics/event USD values
are list-price estimates, not Max bills. Use request/event identity to deduplicate
and respect metric temporality; never add snapshots and event totals together.
Do not enable prompt/response, raw API, tool-detail/content or beta tracing export
for kiosk accounting. OTel delivery through Amp's launcher needs a separate
approved end-to-end test; this investigation changed no launch environment.

### 5. factory-gpu installation and login

**Verified by Devon, 2026-10-12**, in MET-121's 02:29:50 UTC comment: as GPU's
`agent`, Claude is installed at `/home/agent/.local/bin/claude`, version
`2.1.296`, logged in via `claude.ai`, `apiProvider: "firstParty"`,
`subscriptionType: "max"`, with projects at `/home/agent/.claude/projects`.
His 02:34:23 UTC comment confirms the same Claude account on Mac, console and
GPU. The collector can read GPU's local Claude sources beside factory-api.
**Amp-launched Claude execution on factory-gpu remains unprobed**, including
the running Amp service's environment and telemetry propagation.

### 6. ChatGPT quota via Codex app-server

Devon verified `codex-cli 0.162.1`, **Logged in using ChatGPT**, as `agent` on
both factory-gpu and factory-console (MET-121 comments at 02:42:14 and
02:42:49 UTC, 2026-10-12). Both nodes use the same ChatGPT account. He installed
Codex for read-only quota collection, **not coding or inference**. His earlier
02:35:05 comment saying Codex was absent on runners is superseded by these checks.

On his Mac, an initial app-server attempt returned initialization metadata but
closed stdin before the quota response arrived. Keeping stdin open fixed it
(02:36:17 UTC comment). On GPU as `agent`, the live read returned the same
values as his Mac. Session-file `token_count.rate_limits` snapshots were stale
(0–1%); use the live read, not rollout files or new inference.

Exact method sequence: start `codex app-server` with piped stdin/stdout; send
`initialize` with id 1; wait for its successful id 1 response; send the
`initialized` notification; send `account/rateLimits/read` with id 2; keep stdin
open and read through notifications until the **id 2 response** arrives. Only
then close stdin and stop the disposable app-server. Do not substitute a fixed
sleep or let a short input pipe reach EOF before the response.

Reproduction messages, based on the [official app-server protocol](https://learn.chatgpt.com/codex/app-server)
and Devon's method sequence; **not run by this thread**. The `clientInfo` label
below is for reproduction, not a claimed capture of Devon's original bytes.
The wire format is newline-delimited JSON-RPC with the `jsonrpc` header omitted:

```jsonl
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"factory_usage_collector","title":"Factory Usage Collector","version":"0.1.0"}}}
{"method":"initialized","params":{}}
{"id":2,"method":"account/rateLimits/read"}
```

Observed response fields reported by Devon, not a complete raw response:

* `ordinaryUsageAllowed: true`, `planType: "pro"`, limit ID `codex`.
* `primary.usedPercent: 17`, `primary.windowDurationMins: 10080` (seven days),
  `primary.resetsAt: 1792299781` (**Unix epoch seconds**).
* `secondary: null`: this Pro snapshot has no secondary/five-hour window.
  Do not invent a 5h limit or treat null as zero usage.
* `credits: {"hasCredits":true,"unlimited":false,"balance":"62500"}`.
  Balance is a credit quantity, **not USD**; preserve its units and string value.
* Three available **rate-limit reset credits**, distinct from spend credits.
  The documented response field is `rateLimitResetCredits.availableCount`;
  detailed credit rows can be null or capped, so use the count, not array length.

Preserve `rateLimits` and, when supplied, `rateLimitsByLimitId` bucket identity;
do not add overlapping single-bucket and multi-bucket snapshots. Record account,
CLI version, host and observation time. Collector methods are read-only:
**never call `account/rateLimitResetCredit/consume`, login, or logout methods**.
Do not send a thread/turn request or generate inference to measure quota.

**Unverified:** whether Amp's ChatGPT mode draws on this same `codex` limit.
Show it as the ChatGPT/Codex account quota, not a proven Amp-specific remaining
allowance. The shared `agent` login is Devon's accepted single-user arrangement;
MET-120 addresses access when David joins.

### Recommended collector sources

Collector placement for MET-77 is **factory-gpu beside factory-api**, superseding
the earlier console-placement proposal for these sources. Sources remain
server-side; no credentials reach the kiosk.

**Amp — Devon's decision, 2026-10-12:** no workspace, M2M credential, or External
API. Use the following CLI sources on factory-gpu with one shared account poller:

* `amp usage` every **15 minutes**: 4 requests/hour for plan and remaining pools.
* `amp usage --details` **hourly**: 1 request/hour for account usage breakdowns.
* `amp threads usage <id> --details` **hourly for at most 10 dispatched threads**:
  at most 10 requests/hour. Substitute recorded dispatcher thread IDs only.

These commands ran here for the account and probe B; Devon also verified them
on his Mac. The scheduling is a collector decision, not a deployed job. Budget
is **at most 15 scheduled requests/hour**, below the shared **60 requests/hour**
account/thread lookup limit. Coordinate all readers and count retries/manual
drilldowns against that same budget; stagger polls and back off on failure.

**Deliberate exception to the no-terminal-parsing rule:** strict patterns built
only from the exact outputs captured above and Devon's MET-121 evidence, with
the CLI version recorded (`0.0.1791763306-ged595a` for these captures). Recognize
the supported summary and table shapes, their units and billing scope; do not
guess new labels, column positions, missing rows, or values after an update.
On **any mismatch**, emit **“unknown, format changed”**, never a guessed value.
Keep stale last-good data with its age, but do not present it as a current sample.
An unavailable thread report or failed lookup remains unknown, not zero.

Devon's 02:31:13 UTC comment reports summary agent balance $171.27 of $200
remaining (86%) and orb balance 998.1h of 1,000h in `a1.xxlarge` hours. His
02:32:41 UTC comment confirms the detailed markdown tables, recorded cost $28.75
including Web Search $0.06, and ChatGPT $0 for about 259.8M tokens. Its MET-80
thread example reports cost $0.007, 1,367,739 tokens and 26 requests; the $3.79
list-price estimate is not billed by Amp. These comment extracts supplement,
not replace, the exact console stdout above; changing numbers and decimal
precision are not themselves format changes. The comment also confirms earlier
probe unavailability was transient.

Preserve net balance versus gross recorded usage, included orb-hour normalization,
cache-inclusive CLI input and billed versus estimated cost. Account totals and
thread drilldowns overlap; do not add them together. Parent thread details include
subthreads, so reconcile lineage rather than summing parent and child snapshots.
This parser is a consciously versioned fallback, **not a supported vendor JSON
schema**, and the exception applies only to these Amp usage commands.

**Claude quota:** use the exact successful third command above as GPU's already
authenticated `agent` (login verified by Devon in section 5; quota probe ran on
console). Keep slash commands enabled;
`--disable-slash-commands` would defeat `/usage`. Project/user setting sources
are excluded per invocation; OAuth is still available, unlike `--bare`.
Consume only the assistant's `usage_report.rate_limits`, not the text report or
the final result's session cost. This projection actually ran on the capture:

```sh
jq -c 'select(.type == "assistant" and .usage_report != null) | {session_id, rate_limits: .usage_report.rate_limits}' .amp/in/evidence/usage-stream.txt
```

The headless command polls quota without inference. The report type is
experimental; pin the CLI, validate it, keep unknown/null distinct from zero,
preserve scopes/currency/reset units, and attach UTC observation time. Start with
one designated account poller every five minutes (proposal, rate limit/lag not
verified), keep stale last-good values on failures, and never sum shared quota
from two nodes. No app, private endpoint, cookie or terminal scraper is needed.

**Claude usage:** approved future OTel exports from each runner that launches
Claude to a metadata-only receiver feeding the GPU collector. Exact documented
configuration variables (from docs, **not deployed**):
`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`,
`OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, and an
approved `OTEL_EXPORTER_OTLP_ENDPOINT`. Keep content gates at `0`; add account,
host and trusted launch attribution without assuming OS `agent` means Devon.
Do not reconfigure/restart the current runners to enable it in MET-121.
Until delivery is verified, usage coverage is partial/unknown; existing-launch
stream capture is an alternative supported interface if the launcher exposes it.
Local `~/.claude/projects/<project>/<session-id>.jsonl` and subagent files are
version-pinned historical fallback evidence, not the supported primary collector.

**ChatGPT quota:** every **15 minutes on factory-gpu**, as its authenticated
`agent`, use `codex app-server` and the section 6 handshake/read sequence. Keep
stdin open until id 2 completes. This reads account quota without inference;
do not poll stale session files, redeem resets, or change authentication. Both
nodes share the account, so use one GPU poller rather than duplicate collection.
Display the source as ChatGPT/Codex quota until its relationship to Amp usage is
verified. Preserve weekly window/reset units and keep spend/reset credits distinct.

### Not pursued (Devon decided against a workspace)

**Historical UI steps only; not next steps.** Devon decided on 2026-10-12 not to
create/join a workspace or use the External API. Nothing below was performed;
no app or credential was created. Retained for reference if that decision changes.

1. Open [Workspace Settings](https://ampcode.com/workspace) as the same Amp account,
   `devon@metacomet.tech`. If it shows **Create a Workspace**, there is currently
   no workspace. Creating/joining one is Devon's decision, not a collector setup
   side effect: joining/creating moves personal paid credits and changes billing
   and thread ownership/visibility rules. Read the Workspaces docs first.
   To create one, use the documented **Create a Workspace** form, supply display
   name and short name, and review the existing-thread sharing choice. To join
   one, ask its admin for an invitation. Do not automatically share old threads.
2. Once in the intended workspace as an admin, open
   [External API Applications](https://ampcode.com/workspace/applications), the
   exact page linked by the official External API reference. Use the action to
   create an **External API Application**, choose **machine-to-machine**, and name
   it `factory-usage-collector`. **The authenticated page's button label and
   creation-dialog layout were not observable:** a public unauthenticated GET
   shows Sign in to Amp. The reference specifies the page and application type
   but not a button caption; Devon must confirm the actual create button rather
   than this document inventing “New” or “Add”. Do not use a workspace App
   deployment or a Sign in with Amp OAuth client as a substitute.
3. Grant only `workspace.analytics:view` and `workspace.threads.meta:view`
   (full OAuth names `amp.api:workspace.analytics:view` and
   `amp.api:workspace.threads.meta:view`). Optionally add
   `workspace.entitlements:view` (`amp.api:workspace.entitlements:view`) to show
   configured caps; it does not unlock balances. Do not grant thread contents
   or manage scopes. Add members-view only if email mapping is truly needed.
4. Complete creation **yourself**, store the client ID/secret in the Factory vault,
   and arrange scoped service access outside the kiosk/repository. Never paste
   credentials into this thread. Confirm the application belongs to the intended
   workspace and that usage covers the intended account activity before wiring
   `/v1/agents`. No credential creation or application eligibility was live-tested.

### Unverified / risks

* No Amp workspace/API is pursued. Automated CLI parsing is not implemented here;
  strict versioned patterns must fail closed as “unknown, format changed”. The
  historical M2M UI button caption and authenticated API remain unverified, not
  pending collector setup steps.
* GPU's Claude installation/login and same-account mapping are verified by Devon;
  its Amp-launched execution/environment, Max tier multiplier and long-lived
  OAuth refresh remain untested. No credentials/settings were read or modified
  by this investigation.
* Codex's live ChatGPT quota is verified by Devon on GPU, with 0.162.1 installed
  and logged in as agent on both nodes. Whether Amp's ChatGPT mode uses that same
  `codex` limit is unverified; do not label it as Amp-specific quota.
* `/usage` works headless in 2.1.296 with this saved Max login. Its experimental
  schema and credential requirements can change. The test used a new session,
  not a continuation of a running Amp Claude session; account quota is the useful
  snapshot, not that empty session's token totals.
* OTel is documented but not delivered in these console-export probes. Its
  production receiver, shutdown flush, launcher propagation, auxiliary/subagent
  coverage, retention and deduplication require approved verification. No export
  failure cause is established here. No extra inference was spent investigating it.
* Subagent transcript layout is documented but actual subagent files were absent.
  Cost-state fields and response-header `unifiedWindows` are observations, not
  stable supported schemas. No prompt/response content was copied from transcripts.
* Quota is account-wide and may include other devices/surfaces. Percent used is
  not a token budget or subscription invoice. Missing fields are unknown, not zero.
  Report freshness and preserve raw units; do not imply usage/quota reconcile.

Validation: Markdown rendered with the existing `markdown-it-py` workflow;
JSON fences parsed, shell fences checked with `bash -n`, and the diff remained
confined to this MET-121 section (the initial addition was append-only).
The follow-up also parses each JSONL protocol message. `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, and `cargo test --workspace` passed
(one existing ignored test).
Sandbox: none (docs-only). Deploy artifacts/steps: none. Disposable help/docs/
probe captures are local scratch, not deployed or committed.

## Collector (MET-125)

The [collector](../scripts/usage/README.md) implements the selected GPU sources
at 15-minute cadence, including Cursor plan (`agent about --format json`),
OpenCode local session cost (`opencode stats` on 1.19.3, or
`opencode stats --all --cost` on 2.0.32, including a live `$0.00` reading), and Kimi Code quota
from the existing or collector-started loopback `GET /api/v1/oauth/usage`.
It does not scrape Cursor's interactive `/usage`, call provider dashboards
with extracted tokens, or persist emails, bearer tokens, request ids or token
counts. A live Cursor tier `Ultra` maps to `ultra` with the email dropped.
A live Kimi ok body had `limit5h` and `limit7d` only and a null currency, so
no monthly window and no wallet; the ratios themselves were not captured.
Hourly Amp pool-table validation, independent errors,
45-minute freshness, atomic sanitized snapshots and `/v1/agents` plus
`agents.usage` SSE. Deployment remains Devon's gate. No new inference, auth,
reset consumption, transcript harvesting or runner configuration is required.

The Codex implementation uses Devon's verified `jsonrpc: "2.0"` message form,
superseding the header-omitted reproduction above. Its reset-credit count is
`result.rateLimitResetCredits.availableCount`, beside `result.rateLimits`.
Codex credits retain decimal string precision and are never USD. Amp exposes
separate USD and normalized orb-hour balances; the date-only period end becomes
UTC midnight, not a claim of exact renewal time. Claude's usage report does not
identify Max versus Pro, so the normalized plan stays null. Scoped weekly limits
remain separate. Extra-usage billing and Amp per-thread/token accounting are not
part of this quota contract. See the README for parser/version boundaries,
fixture provenance, stale/error semantics and deploy/rollback steps.
