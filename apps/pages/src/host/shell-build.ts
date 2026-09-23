/**
 * What this shell's build produced that the shared core reads through its
 * host (ADR 0133): the capability artifacts, the stamped security profile
 * (`scripts/security-profile.mjs`) and the hosted static-auth SDK release.
 */
import type { Host } from "@opensesame/app-core/host.js";
import type { SecurityProfile } from "@opensesame/app-core/lib/deployment-profile.js";
import securityProfile from "../../public/security-profile.json";
import staticAuth from "../../public/static-auth/manifest.json";
import { capabilityArtifacts } from "./capability-artifacts.js";

/* SAFETY: checked at the build boundary — scripts/security-profile.mjs
   validates this file before the build, and the checked-in copy is its
   shared-origin default. */
const stamped = securityProfile as SecurityProfile;

export const shellBuild: Omit<Host, "env"> = {
  capabilities: capabilityArtifacts,
  securityProfile: stamped,
  staticAuth: { version: staticAuth.version, sri: staticAuth.sri },
};
