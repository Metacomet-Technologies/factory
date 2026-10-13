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
    { name: "api", build: api, expected: kiosk.expected_inputs.api },
    { name: "kiosk", build: kiosk, expected: kiosk.inputs_fingerprint },
    { name: "meter", build: meter, expected: kiosk.expected_inputs.meter },
  ];
  const versions = components
    .map(({ build }) => build?.version)
    .filter((value) => value && value !== "unknown");
  const mismatch =
    new Set(versions).size > 1 ||
    components.some(
      ({ build, expected }) =>
        build?.inputs_fingerprint &&
        build.inputs_fingerprint !== "unknown" &&
        build.inputs_fingerprint !== expected,
    );
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
        <p role="status" className="status-warn">
          {warning}
        </p>
      )}
    </footer>
  );
}
