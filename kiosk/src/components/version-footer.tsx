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
  // ponytail: factory-api has no meter contract check yet, so only the kiosk↔API pair is compared.
  const served = api?.openapi_sha256;
  const mismatch = Boolean(served && served !== kiosk.expected_openapi_sha256);
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
        <p
          role="status"
          className="status-warn"
          title={
            mismatch
              ? `API contract mismatch: kiosk built against OpenAPI ${kiosk.expected_openapi_sha256}, api serves ${served}`
              : undefined
          }
        >
          {warning}
        </p>
      )}
    </footer>
  );
}
