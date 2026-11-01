import { isLoopbackOrigin } from "@opensesame/static-auth";
import { host } from "../host.js";
import { maybePage } from "../ports.js";

/** What a host that stamped no profile gets: nothing may pair locally. */
const SHARED_ORIGIN_DEMO: SecurityProfile = {
  version: 1,
  profile: "shared_origin_demo",
  canonicalOrigin: "https://opensesame-labs.github.io",
  headerSecurity: false,
};

/** The profile the shell's build stamped, read when asked (ADR 0133). */
export function compiledSecurityProfile(): SecurityProfile {
  return host().securityProfile ?? SHARED_ORIGIN_DEMO;
}

export type PagesDeploymentProfile =
  | "loopback_development"
  | "dedicated_origin"
  | "isolated_web_app"
  | "shared_origin_demo";
export type SecurityProfile = {
  version: 1;
  profile: PagesDeploymentProfile;
  canonicalOrigin: string;
  headerSecurity: boolean;
};

/** Build configuration is the authority; endpoint settings cannot promote it. */
export function resolveDeploymentProfile(
  origin: string,
  configured: SecurityProfile,
): PagesDeploymentProfile {
  if (configured.version !== 1) return "shared_origin_demo";
  if (configured.profile === "isolated_web_app") {
    // The bundle ID is the signing key's hash and is not known when the
    // profile is stamped. The profile is inside the signed bundle, so the
    // scheme prefix and the IWA context are the authority here.
    return configured.canonicalOrigin === "isolated-app:" &&
      origin.startsWith("isolated-app://")
      ? configured.profile
      : "shared_origin_demo";
  }
  if (configured.canonicalOrigin !== origin) return "shared_origin_demo";
  if (configured.profile === "loopback_development" && isLoopbackOrigin(origin))
    return configured.profile;
  if (
    configured.profile === "dedicated_origin" &&
    origin !== "https://opensesame-labs.github.io" &&
    configured.headerSecurity &&
    new URL(origin).protocol === "https:" &&
    !isLoopbackOrigin(origin)
  )
    return configured.profile;
  return "shared_origin_demo";
}

export function mayPairLocalAuthority(
  origin?: string,
  configured: SecurityProfile = compiledSecurityProfile(),
): boolean {
  const current = origin ?? maybePage()?.location.origin;
  if (!current) return false;
  return resolveDeploymentProfile(current, configured) !== "shared_origin_demo";
}
