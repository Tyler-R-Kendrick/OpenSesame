import { has } from "./compiler-util.js";
import type { CompilerCatalog, EffectAssurance } from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

function presentationAssuranceLevel(
  effects: PolicyProfile["effects"],
  catalog: CompilerCatalog,
  presentationNeedsKey: boolean,
): EffectAssurance["level"] {
  if (
    effects.presentation === "locked" ||
    effects.presentation === "unchanged"
  ) {
    return "configured";
  }
  if (
    presentationNeedsKey &&
    effects.presentationCompartmentRef &&
    has(catalog.independentCompartmentRefs, effects.presentationCompartmentRef)
  ) {
    return "configured";
  }
  if (effects.presentation === "normal") {
    return "configured";
  }
  return "unavailable";
}

export function buildEffectAssurances(
  profile: PolicyProfile,
  catalog: CompilerCatalog,
  presentationNeedsKey: boolean,
  effects: PolicyProfile["effects"],
): EffectAssurance[] {
  return [
    {
      effect: "presentation",
      level: presentationAssuranceLevel(effects, catalog, presentationNeedsKey),
    },
    {
      effect: "hold",
      level:
        effects.hold.kind === "none"
          ? "configured"
          : effects.hold.kind === "independent_authority"
            ? has(catalog.authorityRefs, effects.hold.authorityRef)
              ? "configured"
              : "unavailable"
            : "configured",
      detail:
        effects.hold.kind === "local_application"
          ? "Local application clock only; not tamper-resistant."
          : undefined,
    },
    {
      effect: "alert",
      level: effects.alert
        ? has(catalog.routeRefs, effects.alert.routeRef)
          ? "configured"
          : "unavailable"
        : "configured",
    },
    {
      effect: "quarantine",
      level: effects.quarantinePeerRefs.every((p) => has(catalog.peerRefs, p))
        ? "configured"
        : "unavailable",
    },
    {
      effect: "provider_revocation",
      level:
        effects.providerRevocationRefs.length === 0
          ? "configured"
          : effects.providerRevocationRefs.every((p) =>
                has(catalog.providerActionRefs, p),
              )
            ? "configured"
            : "unsupported",
    },
    {
      effect: "removal",
      level: "configured",
      detail:
        effects.removal.kind === "local_enumerated"
          ? "Application-scoped removal only; not forensic erasure."
          : undefined,
    },
    {
      effect: "recovery",
      level: effects.recoveryPolicyRef
        ? has(catalog.recoveryPolicyRefs, effects.recoveryPolicyRef)
          ? "configured"
          : "unavailable"
        : "configured",
    },
  ];
}
