/**
 * Hosted SIOP challenge profile resolution (ADR 0117).
 *
 * Pure allowlist + profile selection for the Identity link bridge.
 * Mutated at break:100 — orchestration (take/restore/audit) stays in the
 * control-plane service and is held by PACT.
 */

import { refuse } from "./errors.js";
import {
  STATIC_SELF_ISSUED_ISSUER,
  type SiopIssuerProfile,
  assertAllowedIssuer,
} from "./issuer.js";

export type ResolveSiopLinkProfileInput = {
  readonly expectedIssuer?: string;
  readonly requireDynamicSiopMarker?: boolean;
};

export function resolveSiopLinkProfile(
  input: ResolveSiopLinkProfileInput,
): SiopIssuerProfile {
  if (input.requireDynamicSiopMarker === true) {
    const issuer = input.expectedIssuer?.trim();
    if (!issuer || issuer === STATIC_SELF_ISSUED_ISSUER) {
      refuse("issuer_mismatch", "issuer_profile");
    }
    assertAllowedIssuer(issuer);
    return { kind: "dynamic", issuer };
  }
  const issuer = input.expectedIssuer ?? STATIC_SELF_ISSUED_ISSUER;
  if (issuer !== STATIC_SELF_ISSUED_ISSUER) {
    assertAllowedIssuer(issuer);
    return { kind: "dynamic", issuer };
  }
  return { kind: "static" };
}

export function challengeIssuerFromProfile(profile: SiopIssuerProfile): string {
  return profile.kind === "static" ? STATIC_SELF_ISSUED_ISSUER : profile.issuer;
}

export function bodyOffersEmailJoin(input: {
  readonly email?: unknown;
  readonly emailNormalized?: unknown;
}): boolean {
  return input.email !== undefined || input.emailNormalized !== undefined;
}
