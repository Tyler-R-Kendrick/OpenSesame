import { diag, has } from "./compiler-util.js";
import type { CompilerCatalog, CompilerDiagnostic } from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

function validateHoldEffects(
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
  base: string,
  effects: PolicyProfile["effects"],
): void {
  if (effects.hold.kind === "local_application") {
    if (
      effects.hold.durationMs === "indefinite" &&
      !effects.recoveryPolicyRef
    ) {
      diagnostics.push(
        diag(
          "recovery_required",
          `${base}.effects.hold`,
          "Indefinite local hold requires an independent recovery mechanism.",
        ),
      );
    }
  }

  if (effects.hold.kind === "independent_authority") {
    if (!has(catalog.authorityRefs, effects.hold.authorityRef)) {
      diagnostics.push(
        diag(
          "unavailable_authority",
          `${base}.effects.hold.authorityRef`,
          "Independent hold authority not in catalog.",
        ),
      );
    }
    const bypass = catalog.alternateUnlockPaths.filter((p) => p.bypassesClaim);
    if (bypass.length > 0) {
      diagnostics.push(
        diag(
          "alternate_unlock_bypass",
          `${base}.effects.hold`,
          "Independent hold claim has admitted alternate unlock paths.",
        ),
      );
    }
  }

  if (effects.hold.kind === "custodial_reenrollment") {
    if (!has(catalog.recoveryPolicyRefs, effects.hold.recoveryPolicyRef)) {
      diagnostics.push(
        diag(
          "unavailable_authority",
          `${base}.effects.hold.recoveryPolicyRef`,
          "Custodial hold recovery policy missing from catalog.",
        ),
      );
    }
  }
}

function validateAlertEffects(
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
  base: string,
  effects: PolicyProfile["effects"],
): void {
  if (!effects.alert) {
    return;
  }
  if (!has(catalog.routeRefs, effects.alert.routeRef)) {
    diagnostics.push(
      diag(
        "unapproved_route",
        `${base}.effects.alert.routeRef`,
        "Alert route not approved.",
      ),
    );
  }
  if (effects.alert.retainOutboxAcrossRemoval && !catalog.durableStorage) {
    diagnostics.push(
      diag(
        "undurable_storage",
        `${base}.effects.alert`,
        "Cannot claim durable post-removal delivery without durable storage.",
      ),
    );
  }
  if (
    effects.alert.retainOutboxAcrossRemoval &&
    effects.removal.kind === "local_enumerated" &&
    !effects.removal.preserveSealedOutbox
  ) {
    diagnostics.push(
      diag(
        "contradictory_actions",
        `${base}.effects.alert`,
        "Alert claims retained outbox but removal does not preserve sealed outbox.",
      ),
    );
  }
}

export function validateHoldAndAlertEffects(
  _profile: PolicyProfile,
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
  base: string,
  effects: PolicyProfile["effects"],
  _presentationNeedsKey: boolean,
): void {
  validateHoldEffects(catalog, diagnostics, base, effects);
  validateAlertEffects(catalog, diagnostics, base, effects);
}
