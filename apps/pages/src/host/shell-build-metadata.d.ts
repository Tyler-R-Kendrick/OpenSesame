/** Validated deployment metadata supplied by shell-build-metadata-plugin.mjs. */
declare module "virtual:opensesame-shell-build" {
  import type { Host } from "@opensesame/app-core/host.js";

  export const SECURITY_PROFILE: NonNullable<Host["securityProfile"]>;
  export const STATIC_AUTH: NonNullable<Host["staticAuth"]>;
}
