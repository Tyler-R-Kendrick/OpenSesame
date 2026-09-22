import { diag, has } from "./compiler-util.js";
import type { CompilerCatalog, CompilerDiagnostic } from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

export function validatePresentationEffects(
  profile: PolicyProfile,
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
  base: string,
  effects: PolicyProfile["effects"],
  presentationNeedsKey: boolean,
): void {
  if (presentationNeedsKey) {
    if (!effects.presentationCompartmentRef) {
      diagnostics.push(
        diag(
          "independent_keys_required",
          `${base}.effects.presentationCompartmentRef`,
          "Restricted/decoy presentation requires a presentation compartment.",
        ),
      );
    } else if (
      !has(
        catalog.independentCompartmentRefs,
        effects.presentationCompartmentRef,
      )
    ) {
      diagnostics.push(
        diag(
          "independent_keys_required",
          `${base}.effects.presentationCompartmentRef`,
          "Presentation compartment must be independently keyed.",
        ),
      );
    }
    if (!effects.operationCeilingRef) {
      diagnostics.push(
        diag(
          "unsupported_factor",
          `${base}.effects.operationCeilingRef`,
          "Restricted/decoy sessions require an explicit operation ceiling.",
        ),
      );
    } else if (
      !has(catalog.operationCeilingRefs, effects.operationCeilingRef)
    ) {
      diagnostics.push(
        diag(
          "unavailable_authority",
          `${base}.effects.operationCeilingRef`,
          "Operation ceiling not in catalog.",
        ),
      );
    }
  }

  if (effects.presentation === "unchanged") {
    if (effects.presentationCompartmentRef) {
      diagnostics.push(
        diag(
          "contradictory_actions",
          `${base}.effects.presentation`,
          "presentation:unchanged cannot admit a compartment key.",
        ),
      );
    }
  }

  if (
    effects.presentation === "normal" &&
    effects.removal.kind === "local_enumerated"
  ) {
    const removed = new Set(effects.removal.resourceRefs);
    for (const c of profile.scope.compartmentRefs) {
      if (removed.has(c)) {
        diagnostics.push(
          diag(
            "contradictory_actions",
            `${base}.effects.removal`,
            "Cannot present normal access while removing its required compartment material.",
          ),
        );
      }
    }
  }
}
