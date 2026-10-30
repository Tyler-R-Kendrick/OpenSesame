/**
 * What this shell's build produced that the shared core reads through its
 * host (ADR 0133): the capability artifacts, the stamped security profile
 * (`scripts/security-profile.mjs`) and the hosted static-auth SDK release.
 */
import { SECURITY_PROFILE, STATIC_AUTH } from "virtual:opensesame-shell-build";
import type { Host } from "@opensesame/app-core/host.js";
import { capabilityArtifacts } from "./capability-artifacts.js";

export const shellBuild: Omit<Host, "env"> = {
  capabilities: capabilityArtifacts,
  securityProfile: SECURITY_PROFILE,
  staticAuth: STATIC_AUTH,
};
