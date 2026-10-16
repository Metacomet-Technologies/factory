import { useEffect, useState, type MouseEvent } from "react";
import { Activity, Cpu, Moon, Server, Sun, Terminal, Radio, Info } from "lucide-react";
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
import { VersionFooter } from "./components/version-footer";
import { UpsBadge, UpsSection } from "./components/ups";
import UpsPage from "./components/ups-page";
import DevicesPage from "./components/devices-page";
import { Card, CardContent, CardHeader } from "./components/ui/card";

function followLink(event: MouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
    return;
  event.preventDefault();
  const href = event.currentTarget.getAttribute("href");
  if (!href || href === window.location.pathname) return;
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [usageRange, setUsageRange] = useState<UsageRange>("24h");
  const [gpuRange, setGpuRange] = useState<GpuRange>("1h");
  const [deviceRange, setDeviceRange] = useState<DeviceRange>("1h");
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
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
          <a href="/devices" onClick={followLink}>
            Devices
          </a>
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
          error={collectorDown ? "Device collector unavailable" : deviceCurrent.error}
          loading={deviceCurrent.loading}
          connected={live.connected}
          live={live.connected && live.devices != null}
          now={now}
        />
      ) : path === "/devices" ? (
        <main id="main" className="dashboard devices-page">
          <div className="intro">
            <div>
              <p className="eyebrow">DEVICES</p>
              <h2>Devices</h2>
            </div>
            <p className="muted">
              <a href="/" onClick={followLink}>
                Dashboard
              </a>
            </p>
          </div>
          {devices.error && (
            <p role="alert" className="status-fail">
              {devices.error}
            </p>
          )}
          {!devices.loading && devices.data?.devices.length === 0 && (
            <p className="muted">No devices reported.</p>
          )}
          <div className="dashboard-grid">
            {devices.data?.devices.map((device) => (
              <a
                key={device.device_id}
                href={device.href}
                onClick={followLink}
                className="ups-card-link"
              >
                <Card>
                  <CardHeader>{device.device_id}</CardHeader>
                  <CardContent>{device.health}</CardContent>
                </Card>
              </a>
            ))}
          </div>
        </main>
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
            <UpsSection current={upsCurrent} now={now} warnings={upsWarnings} />
            <a href="/devices/factory-gpu" onClick={followLink} className="ups-card-link">
              <Card>
                <CardHeader>factory-gpu</CardHeader>
                <CardContent>
                  {devices.error ? devices.error : (devices.data?.devices[0]?.health ?? "—")}
                </CardContent>
              </Card>
            </a>
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
