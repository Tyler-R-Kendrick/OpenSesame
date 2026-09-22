import { diag, has } from "./compiler-util.js";
import type { CompilerCatalog, CompilerDiagnostic } from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

export function validateTriggerKindEffects(
  profile: PolicyProfile,
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
  base: string,
  effects: PolicyProfile["effects"],
  presentationNeedsKey: boolean,
): void {
  if (
    presentationNeedsKey &&
    effects.presentationCompartmentRef &&
    effects.removal.kind === "local_enumerated" &&
    effects.removal.resourceRefs.includes(effects.presentationCompartmentRef)
  ) {
    diagnostics.push(
      diag(
        "contradictory_actions",
        `${base}.effects.removal`,
        "Cannot remove the presentation compartment's only key path.",
      ),
    );
  }

  if (
    profile.triggerKind === "canary_activation" ||
    profile.triggerKind === "delegated_peer_request"
  ) {
    if (effects.removal.kind !== "none") {
      diagnostics.push(
        diag(
          "contradictory_actions",
          `${base}.effects.removal`,
          "Canary/peer triggers cannot perform destructive removal.",
        ),
      );
    }
    if (presentationNeedsKey || effects.presentation === "normal") {
      diagnostics.push(
        diag(
          "contradictory_actions",
          `${base}.effects.presentation`,
          "Canary/peer events cannot mint a normal or keyed presentation session.",
        ),
      );
    }
  }

  if (profile.triggerKind === "prf_and_code") {
    const bypass = catalog.alternateUnlockPaths.filter((p) => p.bypassesClaim);
    if (bypass.length > 0) {
      diagnostics.push(
        diag(
          "alternate_unlock_bypass",
          `${base}.triggerKind`,
          "Claimed PRF-and-code path has admitted alternate wrappers.",
        ),
      );
    }
  }
}
