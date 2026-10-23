/**
 * Static topology data: the boxes, the zones they sit in, the edges between them and the
 * flows that select which of them light up. Positions come from `group()`, which lays each
 * titled group out as a column or a row; the numbers are the prototype's and must not drift
 * (the router depends on them). Nothing here is live: no API calls, no status.
 */

export const NODE_W = 200;
export const NODE_H = 64;

export type NodeKind = "person" | "hub" | "cloud" | "service";
export type ZoneTone = "tailnet" | "host" | "group";

export interface Zone {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tone: ZoneTone;
}

export interface TopologyNode {
  id: string;
  title: string;
  sub: string;
  kind: NodeKind;
  x: number;
  y: number;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  dashed: boolean;
}

export interface Flow {
  id: string;
  name: string;
  intro: string;
  nodes: string[];
  edges: string[];
  steps: string[];
}

interface GroupSpec {
  id: string;
  label: string;
  dir: "col" | "row";
  nodes: string[];
}

// ---- Layout -------------------------------------------------------------------------------

const positions = new Map<string, { x: number; y: number }>();
const groups: Zone[] = [];

/** Lays the group's boxes out as a column (232 wide, 96 pitch) or a row (224 pitch). */
function group(spec: GroupSpec, x: number, y: number, tone: ZoneTone = "group"): Zone {
  spec.nodes.forEach((id, i) => {
    positions.set(
      id,
      spec.dir === "col" ? { x: x + 16, y: y + 34 + i * 96 } : { x: x + 16 + i * 224, y: y + 34 },
    );
  });
  const count = spec.nodes.length;
  const w = spec.dir === "col" ? 232 : 32 + count * 200 + (count - 1) * 24;
  const h = spec.dir === "col" ? 34 + count * 64 + (count - 1) * 32 + 16 : 114;
  const zone: Zone = { id: spec.id, label: spec.label, x, y, w, h, tone };
  groups.push(zone);
  return zone;
}

const TAILNET_X = 260;
const TOP_ROW_Y = 0;
const TAILNET_Y = 170;
const HOST_Y = TAILNET_Y + 44;
const GROUP_Y = HOST_Y + 44;

const work = group(
  {
    id: "g-work",
    label: "Work tracking and alerts",
    dir: "row",
    nodes: ["linear", "github", "slack"],
  },
  TAILNET_X,
  TOP_ROW_Y,
);
group(
  { id: "g-ai", label: "AI services", dir: "row", nodes: ["amp", "openai", "anth"] },
  work.x + work.w + 40,
  TOP_ROW_Y,
);
group(
  { id: "g-people", label: "People", dir: "col", nodes: ["devon", "chat", "david"] },
  0,
  GROUP_Y,
);

// Columns inside the factory-gpu host, left to right; each column stacks its groups.
const gpuColumns: GroupSpec[][] = [
  [
    {
      id: "g-agents",
      label: "Agents",
      dir: "col",
      nodes: ["disp", "runG", "claude", "codex", "coll"],
    },
  ],
  [
    {
      id: "g-serving",
      label: "Dashboard and data",
      dir: "col",
      nodes: ["serve", "api", "db", "backup"],
    },
  ],
  [{ id: "g-models", label: "Local models", dir: "col", nodes: ["meter", "ollama"] }],
  [{ id: "g-power", label: "Power", dir: "col", nodes: ["ups", "upsctl"] }],
];
let columnX = TAILNET_X + 20 + 16;
let gpuBottom = 0;
for (const column of gpuColumns) {
  let y = GROUP_Y;
  for (const spec of column) {
    const zone = group(spec, columnX, y);
    y += zone.h + 32;
    gpuBottom = Math.max(gpuBottom, zone.y + zone.h);
  }
  columnX += 272;
}
const GPU_RIGHT = columnX - 40 + 16;
const CONSOLE_X = GPU_RIGHT + 40;
const console_ = group(
  {
    id: "g-console",
    label: "Display and standby",
    dir: "col",
    nodes: ["kiosk", "runC", "replica", "watchdog"],
  },
  CONSOLE_X + 16,
  GROUP_Y,
);
const BOTTOM = Math.max(gpuBottom, console_.y + console_.h) + 16;

/** Tailnet, the two hosts, then every titled group. */
export const ZONES: Zone[] = [
  {
    id: "tailnet",
    label: "Metacomet tailnet",
    x: TAILNET_X,
    y: TAILNET_Y,
    w: console_.x + console_.w + 16 + 20 - TAILNET_X,
    h: BOTTOM + 20 - TAILNET_Y,
    tone: "tailnet",
  },
  {
    id: "gpu",
    label: "factory-gpu: wired, on the UPS, all services and data",
    x: TAILNET_X + 20,
    y: HOST_Y,
    w: GPU_RIGHT - TAILNET_X - 20,
    h: BOTTOM - HOST_Y,
    tone: "host",
  },
  {
    id: "console",
    label: "factory-console",
    x: CONSOLE_X,
    y: HOST_Y,
    w: console_.w + 32,
    h: BOTTOM - HOST_Y,
    tone: "host",
  },
  ...groups,
];

// ---- Data ---------------------------------------------------------------------------------

const nodeList: Omit<TopologyNode, "x" | "y">[] = [
  { id: "devon", title: "Devon", sub: "Linear, deploys, Done", kind: "person" },
  { id: "chat", title: "Claude chat", sub: "escalated reviews, Linear", kind: "person" },
  { id: "david", title: "David", sub: "co-admin", kind: "person" },
  { id: "linear", title: "Linear", sub: "work queue: issues, markers", kind: "hub" },
  { id: "github", title: "GitHub", sub: "public repo, PRs, CI", kind: "cloud" },
  { id: "slack", title: "Slack", sub: "#factory-alerts", kind: "cloud" },
  { id: "amp", title: "ampcode.com", sub: "threads, routing, MCP", kind: "cloud" },
  { id: "openai", title: "OpenAI", sub: "GPT, ChatGPT Only preset", kind: "cloud" },
  { id: "anth", title: "Anthropic", sub: "Claude Max, Opus 5.5", kind: "cloud" },
  { id: "disp", title: "Dispatcher", sub: "polls Linear every 60 s", kind: "service" },
  { id: "runG", title: "Amp runner", sub: "builders cap 2 + 1 QA", kind: "service" },
  { id: "claude", title: "claude CLI", sub: "Claude engine, /usage", kind: "service" },
  { id: "codex", title: "codex CLI", sub: "quota read only", kind: "service" },
  { id: "coll", title: "Usage collector", sub: "every 15 min", kind: "service" },
  { id: "serve", title: "Tailscale Serve", sub: ":443 dashboard, /control", kind: "service" },
  { id: "api", title: "factory-api", sub: "127.0.0.1:8080, REST + SSE", kind: "service" },
  { id: "db", title: "SQLite + usage.json", sub: "requests, pricing, quota", kind: "service" },
  { id: "backup", title: "Nightly backup", sub: "~03:19, four DBs", kind: "service" },
  { id: "meter", title: "meter", sub: ":11434 metering proxy", kind: "service" },
  { id: "ollama", title: "Ollama", sub: "RTX 3060", kind: "service" },
  { id: "ups", title: "UPS + NUT", sub: "CP1000PFCLCDa, USB", kind: "service" },
  { id: "upsctl", title: "factory-ups-control", sub: "127.0.0.1:8090, audit", kind: "service" },
  { id: "kiosk", title: "Kiosk display", sub: "Chrome on the GPU URL", kind: "service" },
  { id: "runC", title: "Amp runner", sub: "overflow, same caps", kind: "service" },
  { id: "replica", title: "Backup replicas", sub: "7 daily + 4 weekly", kind: "service" },
  { id: "watchdog", title: "factory-watchdog", sub: "/v1/health every 60 s", kind: "service" },
];

/** Every box with its position; a box that is in no group is a build error. */
export const NODES: TopologyNode[] = nodeList.map((node) => {
  const at = positions.get(node.id);
  if (!at) throw new Error(`node ${node.id} is in no group`);
  return { ...node, ...at };
});

const edge = (id: string, from: string, to: string, dashed = false): Edge => ({
  id,
  from,
  to,
  dashed,
});

/** Solid: a request or data. Dashed: a person acting, or a scheduled job. */
export const EDGES: Edge[] = [
  edge("issue", "devon", "linear", true),
  edge("ping", "linear", "devon"),
  edge("review", "chat", "linear", true),
  edge("readdiff", "chat", "github", true),
  edge("merge", "devon", "github", true),
  edge("deploy", "devon", "gpu", true),
  edge("watch", "devon", "kiosk", true),
  edge("upsTap", "devon", "upsctl", true),
  edge("claim", "linear", "disp"),
  edge("wrap", "disp", "linear"),
  edge("start", "disp", "amp"),
  edge("toRunG", "amp", "runG"),
  edge("toRunC", "amp", "runC"),
  edge("pr", "runG", "github"),
  edge("qaMerge", "runG", "github"),
  edge("link", "github", "linear"),
  edge("mcpdiff", "runG", "linear"),
  edge("viaAmp", "runG", "amp"),
  edge("ampOpenai", "amp", "openai"),
  edge("ampAnth", "amp", "anth"),
  edge("engine", "runG", "claude"),
  edge("cliAnth", "claude", "anth"),
  edge("local", "runG", "meter"),
  edge("ollama", "meter", "ollama"),
  edge("qCodex", "coll", "codex"),
  edge("codexAi", "codex", "openai"),
  edge("qClaude", "coll", "claude"),
  edge("qAmp", "coll", "amp"),
  edge("snap", "coll", "db"),
  edge("apiDb", "api", "db"),
  edge("serveApi", "serve", "api"),
  edge("kioskServe", "kiosk", "serve"),
  edge("apiMeter", "api", "meter"),
  edge("serveCtl", "serve", "upsctl"),
  edge("upsNut", "upsctl", "ups"),
  edge("apiSlack", "api", "slack"),
  edge("wdHealth", "watchdog", "gpu"),
  edge("wdSlack", "watchdog", "slack"),
  edge("backup", "backup", "replica", true),
];

export const FLOWS: Flow[] = [
  {
    id: "people",
    name: "People",
    intro: "Where you and Claude chat touch the system. Everything else runs on its own.",
    nodes: ["devon", "chat", "linear", "github", "kiosk", "upsctl", "gpu"],
    edges: ["issue", "review", "readdiff", "merge", "deploy", "watch", "upsTap"],
    steps: [
      "You write an Agent task in Linear and add the dispatch label last.",
      "QA merges clean PRs itself; you’re pinged for self-deploying paths and deploys.",
      "Claude chat reviews when QA escalates, on self-deploying PRs, or when you ask.",
      "Self-deploying PRs merge only after your explicit yes.",
      "You run installers from your Mac with gpu-ssh / console-ssh, verify, and mark Done.",
      "You watch the kiosk and use /ups from a personal device.",
    ],
  },
  {
    id: "dispatch",
    name: "Linear dispatch",
    intro: "Linear is the queue: a label starts work, markers track it, Done ends it.",
    nodes: ["linear", "disp", "amp", "runG", "runC", "github"],
    edges: ["claim", "start", "toRunG", "toRunC", "pr", "link", "mcpdiff", "wrap"],
    steps: [
      "Every 60 s the dispatcher claims a dispatch-labeled issue, skipping blocked ones.",
      "It creates the branch and worktree, then starts a private Amp thread.",
      "Builders run on factory-gpu and overflow to the console at 2 active per runner.",
      "The builder pushes and opens a PR as you, using the preconfigured gh login.",
      "Through Linear MCP it posts the PR URL, head SHA and file list on its issue.",
      "GitHub links the PR back to the issue.",
      "After merge the same thread does the wrap-up; the playbook syncs to Linear; threads archive after 5 quiet minutes.",
    ],
  },
  {
    id: "qa",
    name: "QA review",
    intro: "Every PR head gets an independent reviewer before anything merges.",
    nodes: ["disp", "amp", "runG", "runC", "github", "linear", "devon", "chat"],
    edges: ["start", "toRunG", "toRunC", "pr", "mcpdiff", "qaMerge", "ping", "review"],
    steps: [
      "Each open PR head gets a fresh QA thread, GPU then console, one review slot per runner.",
      "The reviewer uses the opposite engine: Claude for amp, chatgpt or ultra builders; GPT for claude builders.",
      "It reads the full diff and deploy scripts, checks Isolation, and requires green rust, kiosk and scripts on the current head.",
      "It posts one verdict on the issue; changes go straight back to the builder.",
      "On ready it re-runs the gate from trusted main and squash-merges pinned to the SHA.",
      "Self-deploying paths ping you instead; after 2 rounds without ready it mentions you and Claude chat reviews.",
    ],
  },
  {
    id: "models",
    name: "Models and engines",
    intro: "Which model a thread uses depends on its engine label.",
    nodes: ["runG", "amp", "openai", "anth", "claude", "meter", "ollama"],
    edges: ["viaAmp", "ampOpenai", "ampAnth", "engine", "cliAnth", "local", "ollama"],
    steps: [
      "engine/amp (default): GPT under the ChatGPT Only preset, on your ChatGPT subscription.",
      "engine/claude: Amp runs the local claude CLI on your Max plan, Opus 5.5, effort from the label.",
      "engine/ultra: Amp credits, only for genuinely high-complexity work, chosen deliberately.",
      "engine/chatgpt: mapping still unverified.",
      "Local models (factory-assist, factory-code) go through meter to Ollama on the GPU.",
      "Check usage metadata for the real model; a thread’s self-report doesn’t count.",
    ],
  },
  {
    id: "usage",
    name: "Quota and usage",
    intro: "Each tool reports its own quota; nothing runs inference to find out.",
    nodes: ["coll", "codex", "claude", "openai", "anth", "amp", "db", "api", "serve", "kiosk"],
    edges: [
      "qAmp",
      "qClaude",
      "cliAnth",
      "qCodex",
      "codexAi",
      "snap",
      "apiDb",
      "serveApi",
      "kioskServe",
    ],
    steps: [
      "Every 15 minutes the collector runs amp usage for credits and orb hours.",
      "claude /usage reads the Max 5-hour and weekly windows with zero tokens.",
      "The codex app-server reads the ChatGPT weekly window and credits.",
      "It writes one sanitized usage.json; factory-api serves it at /v1/agents.",
      "The kiosk shows it live through Serve.",
    ],
  },
  {
    id: "dashboard",
    name: "Dashboard",
    intro: "Every screen reads one API on factory-gpu.",
    nodes: ["kiosk", "serve", "api", "db", "meter", "ollama"],
    edges: ["kioskServe", "serveApi", "apiDb", "apiMeter", "ollama"],
    steps: [
      "The kiosk and your browsers open the factory-gpu dashboard URL.",
      "Tailscale Serve forwards :443 to factory-api on loopback.",
      "factory-api reads SQLite and the usage snapshot.",
      "It syncs requests and GPU samples from meter every 30 seconds.",
    ],
  },
  {
    id: "alerts",
    name: "Alerts",
    intro: "Problems post to Slack; a watchdog on the console covers the GPU going dark.",
    nodes: ["api", "slack", "watchdog", "gpu"],
    edges: ["apiSlack", "wdHealth", "wdSlack"],
    steps: [
      "factory-api evaluates alerts every 30 s: nodes, services, GPU temperature, backups, clock, dispatch timer, stale usage.",
      "It posts one message per alert to #factory-alerts and replies in that thread when it clears.",
      "factory-watchdog on the console checks /v1/health every 60 s, because factory-api can’t report its own node going down.",
      "GET /v1/alerts feeds the kiosk too.",
    ],
  },
  {
    id: "ups",
    name: "UPS",
    intro: "The UPS carries factory-gpu, the fiber modem and the main eero.",
    nodes: ["devon", "serve", "upsctl", "ups"],
    edges: ["upsTap", "serveCtl", "upsNut"],
    steps: [
      "NUT reads the UPS over USB; factory-api shows its state on the dashboard card.",
      "On battery, NUT starts clean shutdown below 30% charge or 300 s runtime.",
      "/ups controls accept only your or David’s personal device; tagged nodes are refused.",
      "Serve /control forwards to factory-ups-control, which audits each request and calls upscmd.",
      "power.cycle drops house internet and the tailnet; factory-gpu won’t auto-boot until MET-179.",
      "Self-test runs the first Saturday of each month at 11:00.",
    ],
  },
  {
    id: "backups",
    name: "Backups",
    intro: "All databases live on factory-gpu; the console keeps the copies.",
    nodes: ["backup", "db", "upsctl", "replica"],
    edges: ["backup"],
    steps: [
      "Around 03:19 the GPU snapshots meter, requests, pricing and the UPS-control audit DB, and checks integrity.",
      "Verified archives go to the console over Tailscale SSH as factory-backup.",
      "The console prunes only when all four current copies are verified: 7 daily + 4 weekly.",
    ],
  },
];
