import { buildEffectAssurances } from "./compile-profile-assurances.js";
import { elevateAssurance } from "./compiler-util.js";
import type {
  CompilerCatalog,
  EffectAssurance,
  ExposureSummary,
} from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

export type CompileProfileResult = {
  exposure: ExposureSummary;
  assurances: EffectAssurance[];
};

export function buildProfileExposureAndAssurances(
  profile: PolicyProfile,
  catalog: CompilerCatalog,
  presentationNeedsKey: boolean,
  effects: PolicyProfile["effects"],
): CompileProfileResult {
  const scope = profile.scope;
  const admitted =
    presentationNeedsKey && effects.presentationCompartmentRef
      ? [effects.presentationCompartmentRef]
      : effects.presentation === "normal"
        ? [...scope.compartmentRefs]
        : [];

  const denied = scope.compartmentRefs.filter((c) => !admitted.includes(c));

  const exposure: ExposureSummary = {
    profileId: profile.profileId,
    admittedCompartmentRefs: admitted,
    deniedCompartmentRefs: denied,
    unlockPathLabels: [
      profile.triggerKind,
      ...catalog.alternateUnlockPaths.map((p) => p.label),
    ],
    alternateWrapperWarnings: catalog.alternateUnlockPaths
      .filter((p) => p.bypassesClaim)
      .map((p) => p.label),
    historicalCopyDisclosure: true,
  };

  const assurances = buildEffectAssurances(
    profile,
    catalog,
    presentationNeedsKey,
    effects,
  );

  const verified = catalog.verifiedReadyEffects ?? [];
  const elevated = assurances.map((a) => ({
    ...a,
    level: elevateAssurance(a.level, a.effect, verified),
  }));

  return { exposure, assurances: elevated };
}
