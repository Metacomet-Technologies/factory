import type { StreamStatus } from "@/api/stream";
import { StatusChip } from "./status-chip";

const labels: Record<StreamStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
};

/** Stream connection state as a chip with a pulsing dot while live. */
export function LiveIndicator({ status }: { status: StreamStatus }) {
  return (
    <StatusChip
      role="status"
      tone={status === "live" ? "ok" : "warn"}
      dot
      pulse={status === "live"}
      className="live-indicator"
    >
      {labels[status]}
    </StatusChip>
  );
}
