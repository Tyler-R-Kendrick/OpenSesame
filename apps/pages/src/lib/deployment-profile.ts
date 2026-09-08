import { isLoopbackOrigin } from "@opensesame/static-auth";
import buildProfile from "../../public/security-profile.json";

// SAFETY: the build script validates this checked-in/generated manifest before bundling.
const compiledSecurityProfile = buildProfile as SecurityProfile;
export { compiledSecurityProfile };

export type PagesDeploymentProfile =
  | "loopback_development"
  | "dedicated_origin"
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
  if (configured.version !== 1 || configured.canonicalOrigin !== origin)
    return "shared_origin_demo";
  if (configured.profile === "loopback_development" && isLoopbackOrigin(origin))
    return configured.profile;
  if (
    configured.profile === "dedicated_origin" &&
    origin !== "https://tyler-r-kendrick.github.io" &&
    configured.headerSecurity &&
    new URL(origin).protocol === "https:" &&
    !isLoopbackOrigin(origin)
  )
    return configured.profile;
  return "shared_origin_demo";
}

export function mayPairLocalAuthority(
  origin: string = location.origin,
  configured: SecurityProfile = compiledSecurityProfile,
): boolean {
  return resolveDeploymentProfile(origin, configured) !== "shared_origin_demo";
}
