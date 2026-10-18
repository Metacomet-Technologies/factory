import type { Resource } from "../api/client";
import type { StreamStatus } from "../api/stream";
import type { Agents, DeviceList, Fleet, Gpu, Pricing, Usage, UpsCurrent } from "../api/types";
import type { VerdictIssue } from "../components/ui/verdict";
import type { NetworkBadge } from "./network";
import type { UpsLabel } from "../components/ups";

export type VerdictInput = {
  fleet: Resource<Fleet>;
  gpu: Resource<Gpu>;
  usage: Resource<Usage>;
  pricing: Resource<Pricing>;
  agents: Resource<Agents>;
  devices: Resource<DeviceList>;
  network: Resource<unknown>;
  networkBadge: NetworkBadge;
  ups: UpsLabel;
  upsCurrent: UpsCurrent | null | undefined;
  stream: StreamStatus;
};

/**
 * Every signal the overview panels show, reduced to one list. A check is one of: a section
 * loading (fail when it errors), a fleet node, a service, a host's health, the UPS, the
 * network link, pricing freshness and the stream. Sections still loading count as neither.
 */
export function verdict(input: VerdictInput): { issues: VerdictIssue[]; okCount: number } {
  const issues: VerdictIssue[] = [];
  let okCount = 0;
  const check = (ok: boolean, tone: VerdictIssue["tone"], label: string) => {
    if (ok) okCount += 1;
    else issues.push({ tone, label });
  };
  const section = (name: string, resource: Resource<unknown>) => {
    if (resource.loading) return false;
    check(!resource.error, "fail", `${name} unavailable`);
    return !resource.error;
  };

  if (section("Fleet", input.fleet)) {
    for (const node of input.fleet.data?.nodes ?? []) {
      check(node.online, "fail", `${node.name} offline`);
      if (!node.online) continue;
      for (const service of node.services)
        check(service.ok, "fail", `${service.name} failing on ${node.name}`);
    }
  }
  if (section("Hosts", input.devices)) {
    for (const device of input.devices.data?.devices ?? []) {
      if (device.health === "unknown") continue;
      check(
        device.health === "healthy",
        device.health === "critical" ? "fail" : "warn",
        `${device.device_id} host ${device.health}`,
      );
    }
  }
  section("GPU", input.gpu);
  section("Local LLM", input.usage);
  if (section("Pricing", input.pricing)) {
    const pending = input.pricing.data?.families.filter((family) => family.pending).length ?? 0;
    check(
      pending === 0,
      "warn",
      `${pending} pricing ${pending === 1 ? "family" : "families"} pending`,
    );
  }
  section("Frontier CLIs", input.agents);
  if (section("Network", input.network) && input.networkBadge.tone !== "neutral")
    check(
      input.networkBadge.tone === "ok",
      input.networkBadge.tone === "fail" ? "fail" : "warn",
      `Network ${input.networkBadge.label.charAt(0).toLowerCase()}${input.networkBadge.label.slice(1)}`,
    );
  if (input.ups !== "No data" || input.upsCurrent)
    check(
      input.ups === "Online",
      input.ups === "On battery" || input.ups === "Low battery" ? "fail" : "warn",
      `UPS ${input.ups.toLowerCase()}`,
    );
  if (input.stream !== "connecting") check(input.stream === "live", "warn", "Stream reconnecting");
  return { issues, okCount };
}
