import { diag, elevateAssurance, has } from "./compiler-util.js";
import type {
  CompilerCatalog,
  CompilerDiagnostic,
  EffectAssurance,
  ExposureSummary,
} from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

import { validateProfileEffects } from "./compile-profile-effects.js";
import { validateProfileScope } from "./compile-profile-scope.js";
import {
  type CompileProfileResult,
  buildProfileExposureAndAssurances,
} from "./compile-profile-summary.js";

export type { CompileProfileResult } from "./compile-profile-summary.js";

export function compileProfile(
  profile: PolicyProfile,
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
): CompileProfileResult {
  const base = `profiles.${profile.profileId}`;
  validateProfileScope(profile, catalog, diagnostics, base);
  const { presentationNeedsKey, effects } = validateProfileEffects(
    profile,
    catalog,
    diagnostics,
    base,
  );
  return buildProfileExposureAndAssurances(
    profile,
    catalog,
    presentationNeedsKey,
    effects,
  );
}
