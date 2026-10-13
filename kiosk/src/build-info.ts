import type { Health } from "./api/types";

declare const __BUILD_INFO__: Pick<
  Health,
  "version" | "git_sha" | "git_dirty" | "built_at_ms" | "inputs_fingerprint"
> & { expected_inputs: { api: string; meter: string } };

export const BUILD_INFO = __BUILD_INFO__;
