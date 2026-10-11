import type { Health } from "./api/types";

declare const __BUILD_INFO__: Pick<Health, "version" | "git_sha" | "git_dirty" | "built_at_ms">;

export const BUILD_INFO = __BUILD_INFO__;
