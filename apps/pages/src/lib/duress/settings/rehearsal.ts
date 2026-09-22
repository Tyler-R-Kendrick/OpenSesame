/**
 * Isolated rehearsal before arming (INV-02 / SC-REHEARSAL).
 * Never arms production effects; never leaves half-armed destructive codes.
 */

export type RehearsalPhase =
  | "idle"
  | "running"
  | "passed"
  | "failed"
  | "aborted";

export type RehearsalResult = Readonly<{
  phase: RehearsalPhase;
  checks: readonly RehearsalCheck[];
  productionEffectsApplied: false;
  halfArmedDestructiveCode: false;
}>;

export type RehearsalCheck = Readonly<{
  id:
    | "trigger_selection"
    | "presentation_class"
    | "durable_storage"
    | "offline_assets"
    | "no_production_side_effects";
  ok: boolean;
  detail: string;
}>;

export type RehearsalEnvironment = Readonly<{
  /** Must be disposable / isolated — never production tokens. */
  disposableFixtures: boolean;
  durableStorage: boolean;
  offlineAssetsReady: boolean;
  triggerSelectsExactlyOne: boolean;
  presentationClass: string;
  expectedPresentationClass: string;
  attemptedProductionAlert: boolean;
  attemptedProductionRemoval: boolean;
}>;

export function runIsolatedRehearsal(
  env: RehearsalEnvironment,
): RehearsalResult {
  if (!env.disposableFixtures) {
    return {
      phase: "failed",
      checks: [
        {
          id: "no_production_side_effects",
          ok: false,
          detail: "Rehearsal refused: production fixtures are not allowed.",
        },
      ],
      productionEffectsApplied: false,
      halfArmedDestructiveCode: false,
    };
  }

  if (env.attemptedProductionAlert || env.attemptedProductionRemoval) {
    return {
      phase: "aborted",
      checks: [
        {
          id: "no_production_side_effects",
          ok: false,
          detail: "Rehearsal aborted before production side effects.",
        },
      ],
      productionEffectsApplied: false,
      halfArmedDestructiveCode: false,
    };
  }

  const checks: RehearsalCheck[] = [
    {
      id: "trigger_selection",
      ok: env.triggerSelectsExactlyOne,
      detail: env.triggerSelectsExactlyOne
        ? "Exactly one trigger selected."
        : "Trigger selection ambiguous or empty.",
    },
    {
      id: "presentation_class",
      ok: env.presentationClass === env.expectedPresentationClass,
      detail: `Presentation ${env.presentationClass} (expected ${env.expectedPresentationClass}).`,
    },
    {
      id: "durable_storage",
      ok: env.durableStorage,
      detail: env.durableStorage
        ? "Durable storage ready."
        : "Durable storage unavailable.",
    },
    {
      id: "offline_assets",
      ok: env.offlineAssetsReady,
      detail: env.offlineAssetsReady
        ? "Offline assets verified."
        : "Offline assets missing.",
    },
    {
      id: "no_production_side_effects",
      ok: true,
      detail: "No production alert/removal executed.",
    },
  ];

  const passed = checks.every((c) => c.ok);
  return {
    phase: passed ? "passed" : "failed",
    checks,
    productionEffectsApplied: false,
    halfArmedDestructiveCode: false,
  };
}

export function rehearsalSatisfiesArming(result: RehearsalResult): boolean {
  return (
    result.phase === "passed" &&
    !result.productionEffectsApplied &&
    !result.halfArmedDestructiveCode
  );
}
