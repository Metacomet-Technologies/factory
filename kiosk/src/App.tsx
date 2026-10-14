import { useEffect, useState } from "react";
import { Activity, Cpu, Moon, Server, Sun, Terminal, Radio, Info } from "lucide-react";
import { useApi } from "./api/client";
import { useStream } from "./api/stream";
import { useBuildUpdate } from "./api/build-update";
import type { UsageRange, GpuRange } from "./api/types";
import {
  FleetSection,
  GpuSection,
  UsageSection,
  AgentsSection,
  TickerSection,
} from "./components/sections";
import { Button } from "./components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { VersionFooter } from "./components/version-footer";
import { UpsBadge, UpsSection } from "./components/ups";

export default function App() {
  const [usageRange, setUsageRange] = useState<UsageRange>("24h");
  const [gpuRange, setGpuRange] = useState<GpuRange>("1h");
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark");
  const [followsSystem, setFollowsSystem] = useState(
    () => !document.documentElement.dataset.themePreference,
  );
  useEffect(() => {
    if (!followsSystem) return;
    const preference = matchMedia("(prefers-color-scheme: dark)");
    const update = (event: MediaQueryListEvent) => setDark(event.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, [followsSystem]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const live = useStream();
  const health = useApi("/v1/health");
  const fleet = useApi("/v1/fleet", "", live.fleetRevision + live.snapshotRevision);
  const usage = useApi(
    "/v1/llm/usage",
    `?range=${usageRange}`,
    live.pricingRevision + live.snapshotRevision,
  );
  const gpu = useApi("/v1/gpu", `?range=${gpuRange}`, live.snapshotRevision);
  const ups = useApi("/v1/ups", "", live.snapshotRevision);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const upsCurrent = live.upsAt > (ups.data?.generated_at_ms ?? 0) ? live.ups : ups.data?.current;
  const pricing = useApi("/v1/pricing", "", live.pricingRevision + live.snapshotRevision);
  const agents = useApi("/v1/agents", "", live.agentsRevision + live.snapshotRevision);
  useBuildUpdate(live.snapshotRevision, usage.loading || gpu.loading);
  return (
    <TooltipProvider>
      <a href="#main" className="skip-link">
        Skip to dashboard
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Activity aria-hidden="true" size={20} />
          </span>
          <div>
            <h1>
              factory<span className="muted"> / kiosk</span>
            </h1>
            <p className="muted">Private infrastructure, at a glance</p>
          </div>
        </div>
        <div className="header-actions">
          <span role="status" className={live.connected ? "status-ok" : "status-warn"}>
            <Radio aria-hidden="true" size={14} />
            {live.connected ? "Live" : "Reconnecting"}
          </span>
          <UpsBadge current={upsCurrent} now={now} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" aria-label="API health details">
                  <Info />
                </Button>
              }
            />
            <TooltipContent>
              {health.error
                ? `API health: ${health.error}`
                : health.data
                  ? `API ${health.data.version} · uptime ${Math.round(health.data.uptime_ms / 60000)} min`
                  : "Checking API health…"}
            </TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? "Use light theme" : "Use dark theme"}
            onClick={() => {
              const preference = dark ? "light" : "dark";
              const followsSystem = !dark === matchMedia("(prefers-color-scheme: dark)").matches;
              if (followsSystem) delete document.documentElement.dataset.themePreference;
              else document.documentElement.dataset.themePreference = preference;
              setFollowsSystem(followsSystem);
              setDark(!dark);
              try {
                if (followsSystem) localStorage.removeItem("factory-theme");
                else localStorage.setItem("factory-theme", preference);
              } catch {}
            }}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>
      <main id="main" className="dashboard">
        <div className="intro">
          <div>
            <p className="eyebrow">OPERATIONS OVERVIEW</p>
            <h2>Your local compute. In focus.</h2>
          </div>
          <p className="muted">Auto-refreshes every 60s</p>
        </div>
        <div className="dashboard-grid">
          <FleetSection resource={fleet} icon={<Server />} />
          <GpuSection
            resource={gpu}
            live={live.gpu}
            range={gpuRange}
            setRange={setGpuRange}
            icon={<Cpu />}
          />
          <UpsSection
            current={upsCurrent}
            now={now}
            warnings={
              live.upsAt > (ups.data?.generated_at_ms ?? 0)
                ? []
                : (ups.data?.warnings ?? (ups.error ? [ups.error] : []))
            }
          />
          <UsageSection
            resource={usage}
            pricing={pricing}
            range={usageRange}
            setRange={setUsageRange}
            icon={<Activity />}
          />
          <aside className="sidebar" aria-label="Frontier tools and live requests">
            <AgentsSection
              resource={
                live.agents && !agents.data
                  ? { data: live.agents, loading: false, error: null }
                  : agents
              }
              icon={<Terminal />}
              revision={live.agentsRevision}
            />
            <TickerSection requests={live.requests} connected={live.connected} />
          </aside>
        </div>
      </main>
      <VersionFooter
        api={health.data}
        meter={fleet.data?.nodes
          .flatMap((node) => node.services)
          .find(
            (service) =>
              service.name === "meter-http" ||
              (service.kind === "http" &&
                URL.canParse(service.target) &&
                new URL(service.target).pathname === "/meter/health"),
          )}
      />
    </TooltipProvider>
  );
}
