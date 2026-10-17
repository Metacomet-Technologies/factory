import { useEffect, useState } from "react";
import { Activity, Cpu, Moon, Server, Sun, Terminal, Info } from "lucide-react";
import { useApi } from "./api/client";
import { useStream } from "./api/stream";
import { useBuildUpdate } from "./api/build-update";
import type { UsageRange, GpuRange, DeviceRange } from "./api/types";
import {
  FleetSection,
  GpuSection,
  UsageSection,
  AgentsSection,
  TickerSection,
} from "./components/sections";
import { Button } from "./components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { LiveIndicator } from "./components/ui/live-indicator";
import { PageHeader } from "./components/ui/page-header";
import { VersionFooter } from "./components/version-footer";
import { UpsBadge, UpsSection } from "./components/ups";
import UpsPage from "./components/ups-page";
import DevicesPage from "./components/devices-page";
import LlmPage from "./components/llm-page";
import NetworkPage from "./components/network-page";
import { NetworkSection } from "./components/network";

/** Same-origin links without a modifier key route in-app; everything else falls through. */
function followLink(event: globalThis.MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download"))
    return;
  if (anchor.origin !== window.location.origin || anchor.hash) return;
  event.preventDefault();
  if (anchor.pathname === window.location.pathname) return;
  window.history.pushState(null, "", anchor.pathname);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Breadcrumb segments for the top bar; every crumb except the last links to a higher level. */
export function crumbs(path: string): { label: string; href: string }[] {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return [{ label: "dashboard", href: "/" }];
  // Devices live on the dashboard fleet grid, so the "devices" crumb returns there.
  return parts.map((part, i) => ({
    label: part,
    href: i === 0 && part === "devices" ? "/" : `/${parts.slice(0, i + 1).join("/")}`,
  }));
}

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [usageRange, setUsageRange] = useState<UsageRange>("24h");
  const [gpuRange, setGpuRange] = useState<GpuRange>("1h");
  const [deviceRange, setDeviceRange] = useState<DeviceRange>("1h");
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    document.addEventListener("click", followLink);
    return () => {
      window.removeEventListener("popstate", sync);
      document.removeEventListener("click", followLink);
    };
  }, []);
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
  const ups = useApi("/v1/ups", "", live.snapshotRevision + live.upsWarningRevision);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const upsCurrent = live.upsAt > (ups.data?.generated_at_ms ?? 0) ? live.ups : ups.data?.current;
  const upsWarnings = ups.data?.warnings ?? (ups.error ? [ups.error] : []);
  const pricing = useApi("/v1/pricing", "", live.pricingRevision + live.snapshotRevision);
  const agents = useApi("/v1/agents", "", live.agentsRevision + live.snapshotRevision);
  const deviceRevision = live.devicesRevision + live.snapshotRevision;
  const devices = useApi("/v1/devices", "", deviceRevision);
  const deviceCurrent = useApi("/v1/devices/factory-gpu", "", deviceRevision);
  const deviceHistory = useApi(
    "/v1/devices/factory-gpu/history",
    `?range=${deviceRange}`,
    deviceRevision,
  );
  const collectorDown = live.connected && live.devices === null;
  const deviceView = collectorDown
    ? null
    : live.connected && live.devices
      ? live.devices
      : deviceCurrent.data;
  const deviceError = collectorDown ? "Device collector unavailable" : deviceCurrent.error;
  const network = useApi(
    "/v1/network",
    "",
    live.networkRevision + live.speedTestRevision + live.snapshotRevision,
  );
  const networkHistory = useApi("/v1/network/history", "?range=24h", live.snapshotRevision);
  useBuildUpdate(live.snapshotRevision, usage.loading || gpu.loading);
  return (
    <TooltipProvider>
      <a href="#main" className="skip-link">
        Skip to dashboard
      </a>
      <header className="topbar">
        <nav className="brand" aria-label="Breadcrumb">
          <a href="/" className="brand-home">
            <span className="brand-mark">
              <Activity aria-hidden="true" size={20} />
            </span>
            <h1>factory</h1>
          </a>
          <ol className="crumbs">
            {crumbs(path).map((crumb, i, all) => (
              <li key={crumb.href}>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
                {i === all.length - 1 ? (
                  <span aria-current="page">{crumb.label}</span>
                ) : (
                  <a href={crumb.href}>{crumb.label}</a>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <div className="header-actions">
          <LiveIndicator status={live.status} />
          <UpsBadge current={upsCurrent} now={now} warnings={upsWarnings} />
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
      {path === "/devices/factory-gpu" ? (
        <DevicesPage
          view={deviceView}
          history={deviceHistory.data}
          range={deviceRange}
          setRange={setDeviceRange}
          error={deviceError}
          loading={deviceCurrent.loading}
          connected={live.connected}
          live={live.connected && live.devices != null}
          now={now}
        />
      ) : path === "/llm" ? (
        <LlmPage usage={usage} pricing={pricing} range={usageRange} setRange={setUsageRange} />
      ) : path === "/network" ? (
        <NetworkPage
          status={network}
          now={now}
          revision={live.snapshotRevision}
          speedRevision={live.speedTestRevision}
        />
      ) : path === "/ups" ? (
        <UpsPage
          current={upsCurrent}
          now={now}
          warnings={upsWarnings}
          live={live}
          revision={live.snapshotRevision + live.upsEventRevision}
        />
      ) : (
        <main id="main" className="dashboard">
          <PageHeader
            eyebrow="Operations overview"
            title="Your local compute. In focus."
            aside="Auto-refreshes every 60s"
          />
          <div className="dashboard-grid">
            <FleetSection
              resource={fleet}
              devices={devices.data?.devices}
              icon={<Server />}
              index={0}
            />
            <GpuSection
              resource={gpu}
              live={live.gpu}
              range={gpuRange}
              setRange={setGpuRange}
              icon={<Cpu />}
              index={1}
            />
            <UpsSection current={upsCurrent} now={now} warnings={upsWarnings} index={2} />
            <NetworkSection status={network} history={networkHistory} now={now} index={3} />
            <UsageSection
              resource={usage}
              pricing={pricing}
              range={usageRange}
              icon={<Activity />}
              index={4}
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
                index={5}
              />
              <TickerSection requests={live.requests} connected={live.connected} index={6} />
            </aside>
          </div>
        </main>
      )}
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
