import { validatePresentationEffects } from "./compile-profile-effects-1a.js";
import { validateTriggerKindEffects } from "./compile-profile-effects-1b.js";
import type { CompilerCatalog, CompilerDiagnostic } from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

export function validatePresentationAndTriggerEffects(
  profile: PolicyProfile,
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
  base: string,
  effects: PolicyProfile["effects"],
  presentationNeedsKey: boolean,
): void {
  validatePresentationEffects(
    profile,
    catalog,
    diagnostics,
    base,
    effects,
    presentationNeedsKey,
  );
  validateTriggerKindEffects(
    profile,
    catalog,
    diagnostics,
    base,
    effects,
    presentationNeedsKey,
  );
}
