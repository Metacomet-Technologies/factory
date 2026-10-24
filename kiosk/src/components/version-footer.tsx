import type { Health, Service } from "../api/types";
import { BUILD_INFO } from "../build-info";

export function VersionFooter({
  api,
  meter,
  kiosk = BUILD_INFO,
}: {
  api: Health | null;
  meter: Service | undefined;
  kiosk?: typeof BUILD_INFO;
}) {
  const components = [
    { name: "api", build: api },
    { name: "kiosk", build: kiosk },
    { name: "meter", build: meter },
  ];
  // Only a contract difference is a mismatch; SHAs, versions and input fingerprints are provenance.
  const served = api?.openapi_sha256;
  const apiMismatch = Boolean(served && served !== kiosk.expected_openapi_sha256);
  const meterExpected = api?.meter_openapi_expected;
  const meterServed = api?.meter_openapi_sha256;
  const meterMismatch = Boolean(meterExpected && meterServed && meterExpected !== meterServed);
  const mismatch = apiMismatch || meterMismatch;
  const mismatchTitle = [
    apiMismatch &&
      `API contract mismatch: kiosk built against OpenAPI ${kiosk.expected_openapi_sha256}, api serves ${served}`,
    meterMismatch &&
      `API↔meter contract mismatch: api built against OpenAPI ${meterExpected}, meter serves ${meterServed}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const dirty = components.some(({ build }) => build?.git_dirty);
  const unknown = components.some(
    ({ build }) =>
      !build?.version ||
      build.version === "unknown" ||
      !build.git_sha ||
      build.git_sha === "unknown" ||
      !build.inputs_fingerprint ||
      build.inputs_fingerprint === "unknown" ||
      build.git_dirty == null,
  );
  const warning = [
    mismatch && "Build mismatch",
    dirty && "Dirty build",
    unknown && "Build identity incomplete",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <footer className="version-footer muted" aria-label="Running versions">
      <div className="version-identities">
        <span>factory v{kiosk.version ?? "unknown"}</span>
        {components.map(({ name, build }) => (
          <span
            key={name}
            title={`${name} v${build?.version ?? "unknown"} · ${build?.git_sha ?? "unknown"} · inputs ${build?.inputs_fingerprint || "unknown"} · ${build?.git_dirty == null ? "dirty status unknown" : build.git_dirty ? "dirty" : "clean"} · built ${build?.built_at_ms ? new Date(build.built_at_ms).toISOString() : "unknown"}`}
          >
            {name} {build?.git_sha || "unknown"}
            {!build?.inputs_fingerprint && " (inputs unknown)"}
          </span>
        ))}
      </div>
      {warning && (
        <p role="status" className="status-warn" title={mismatchTitle || undefined}>
          {warning}
        </p>
      )}
    </footer>
  );
}
