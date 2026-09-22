import { validatePresentationAndTriggerEffects } from "./compile-profile-effects-1.js";
import { validateHoldAndAlertEffects } from "./compile-profile-effects-2.js";
import { validateRemovalAndRecoveryEffects } from "./compile-profile-effects-3.js";
import type { CompilerCatalog, CompilerDiagnostic } from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

export type ProfileEffectsValidation = {
  presentationNeedsKey: boolean;
  effects: PolicyProfile["effects"];
};

export function validateProfileEffects(
  profile: PolicyProfile,
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
  base: string,
): ProfileEffectsValidation {
  const effects = profile.effects;
  const presentationNeedsKey =
    effects.presentation === "restricted" || effects.presentation === "decoy";
  validatePresentationAndTriggerEffects(
    profile,
    catalog,
    diagnostics,
    base,
    effects,
    presentationNeedsKey,
  );
  validateHoldAndAlertEffects(
    profile,
    catalog,
    diagnostics,
    base,
    effects,
    presentationNeedsKey,
  );
  validateRemovalAndRecoveryEffects(
    profile,
    catalog,
    diagnostics,
    base,
    effects,
    presentationNeedsKey,
  );
  return { presentationNeedsKey, effects };
}
