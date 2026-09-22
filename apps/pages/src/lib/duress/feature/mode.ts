/**
 * Opt-in duress feature gate (BUILD).
 * Off ⇒ no network adapters / heavy UI fetch via dynamic import.
 */

import { type DuressCapability, capabilitiesForMode } from "./registry.js";
import type { DuressFeatureMode } from "./types.js";

export {
  DURESS_READER_VERSION,
  type DuressFeatureMode,
  isDuressFeatureEnabled,
} from "./types.js";

export {
  assertReadableDuressHeader,
  explainFormatRefusal,
  refuseUnsupportedDuressFormat,
  type DuressFormatHeader,
  type FormatRefusal,
} from "./format.js";

export {
  DuressOfflineAssetCache,
  evaluateOfflineAssetReadiness,
  type AssuranceLevel,
  type AssetProbe,
  type OfflineReadinessReport,
} from "./assets.js";

export type DuressAssetReadiness = Readonly<{
  modulesCached: boolean;
  durableStorage: boolean;
  offlineBootOk: boolean;
  swMismatch: boolean;
}>;

export function resolveDuressMode(
  env: Record<string, string | undefined> = {},
): DuressFeatureMode {
  const raw = (env.VITE_DURESS_MODE ?? env.DURESS_MODE ?? "off")
    .trim()
    .toLowerCase();
  if (raw === "local_only" || raw === "optional_peer") return raw;
  return "off";
}

/** Capability-registry style registration — off builds list no UI/adapters. */
export type DuressFeatureRegistration = Readonly<{
  mode: DuressFeatureMode;
  uiSurfaces: readonly string[];
  adapters: readonly string[];
  capabilityIds: readonly string[];
  networkAllowed: boolean;
}>;

export function registerDuressFeature(
  mode: DuressFeatureMode,
): DuressFeatureRegistration {
  if (mode === "off") {
    return {
      mode,
      uiSurfaces: [],
      adapters: [],
      capabilityIds: [],
      networkAllowed: false,
    };
  }
  const caps = capabilitiesForMode(mode);
  return {
    mode,
    uiSurfaces: caps.filter((c) => c.kind === "ui").map((c) => c.id),
    adapters: caps
      .filter((c) => c.kind !== "ui")
      .map((c) => c.id.replace(/^duress\./, "")),
    capabilityIds: caps.map((c) => c.id),
    networkAllowed: mode === "optional_peer",
  };
}

export type LoadDuressRuntimeResult = Readonly<{
  mode: DuressFeatureMode;
  loaded: boolean;
  modules: readonly string[];
  unsupported: readonly string[];
}>;

/**
 * Actually dynamic-import admitted modules. Off returns without fetching
 * UI/peer/core adapters (INV-01).
 */
type LoadDuressRuntimeOpts = Readonly<{ includeUi?: boolean }>;
const defaultLoadDuressRuntimeOpts = {} satisfies LoadDuressRuntimeOpts;

export async function loadDuressRuntime(
  mode: DuressFeatureMode,
  opts: LoadDuressRuntimeOpts = defaultLoadDuressRuntimeOpts,
): Promise<LoadDuressRuntimeResult> {
  if (mode === "off") {
    return {
      mode,
      loaded: false,
      modules: [],
      unsupported: capabilitiesForMode("optional_peer").map((c) => c.id),
    };
  }

  const admitted = capabilitiesForMode(mode).filter((c) =>
    opts.includeUi ? true : c.kind !== "ui",
  );
  const modules: string[] = [];

  for (const cap of admitted) {
    await importCapability(cap);
    modules.push(cap.id);
  }

  const unsupported = (
    mode === "local_only"
      ? capabilitiesForMode("optional_peer").filter(
          (c) => !c.modes.includes("local_only"),
        )
      : []
  ).map((c) => c.id);

  return { mode, loaded: true, modules, unsupported };
}

/**
 * The settings panel is UI, and the shared core never imports UI (ADR 0133).
 * The shell that renders it registers how to load its chunk; a shell that
 * registers nothing cannot load `duress.ui`, and says so rather than
 * pretending the asset is warm (INV-30).
 */
let duressUiModule: (() => Promise<unknown>) | null = null;

export function registerDuressUiModule(load: () => Promise<unknown>): void {
  duressUiModule = load;
}

async function importDuressUi(): Promise<void> {
  if (!duressUiModule) {
    throw new Error("duress.ui: no settings panel registered by this shell");
  }
  await duressUiModule();
}

async function importCapability(cap: DuressCapability): Promise<void> {
  switch (cap.id) {
    case "duress.access":
      await import("../access/context.js");
      return;
    case "duress.session":
      await import("../session/fence.js");
      return;
    case "duress.crypto":
      await import("../crypto/slots.js");
      return;
    case "duress.trigger":
      await import("../trigger/enrollment.js");
      return;
    case "duress.alert":
      await import("../alert/outbox.js");
      return;
    case "duress.incident":
      await import("../incident/activate.js");
      return;
    case "duress.store":
      await import("../store/compartment-guard.js");
      return;
    case "duress.settings":
      await import("../settings/arming.js");
      return;
    case "duress.compartment":
      await import("../compartment/project.js");
      return;
    case "duress.recovery":
      await import("../recovery/custody.js");
      return;
    case "duress.removal":
      await import("../removal/local-remove.js");
      return;
    case "duress.canary":
      await import("../canary/detect.js");
      return;
    case "duress.peer":
      await import("../peer/envelope.js");
      return;
    case "duress.ui":
      await importDuressUi();
      return;
    default: {
      const _exhaustive: never = cap.id;
      throw new Error(`unsupported capability: ${_exhaustive}`);
    }
  }
}

/**
 * Enrollment gate: durable storage + cached modules + no SW mismatch.
 * Does not stub success when assets are missing (INV-30).
 */
export type EnrollmentAssetReadinessResult = Readonly<{
  ok: boolean;
  code?: "undurable_storage" | "unsupported_action";
}>;

export function enrollmentAssetReadiness(
  checks: DuressAssetReadiness,
): EnrollmentAssetReadinessResult {
  if (!checks.durableStorage) return { ok: false, code: "undurable_storage" };
  if (!checks.modulesCached || !checks.offlineBootOk) {
    return { ok: false, code: "unsupported_action" };
  }
  if (checks.swMismatch) {
    return { ok: false, code: "unsupported_action" };
  }
  return { ok: true };
}

export type DuressModeComparison = Readonly<{
  modes: readonly DuressFeatureMode[];
  capabilityCounts: Readonly<Record<DuressFeatureMode, number>>;
  peerIncluded: Readonly<Record<DuressFeatureMode, boolean>>;
  uiAdmitted: Readonly<Record<DuressFeatureMode, boolean>>;
}>;

/** Mode matrix used by BUILD-F compare + verify scripts. */
export function compareDuressModes(): DuressModeComparison {
  const modes = ["off", "local_only", "optional_peer"] as const;
  return {
    modes,
    capabilityCounts: {
      off: 0,
      local_only: capabilitiesForMode("local_only").length,
      optional_peer: capabilitiesForMode("optional_peer").length,
    },
    peerIncluded: {
      off: false,
      local_only: false,
      optional_peer: true,
    },
    uiAdmitted: {
      off: false,
      local_only: true,
      optional_peer: true,
    },
  };
}

export type FeatureModeFetchProfile = Readonly<{
  fetchesDuressUi: boolean;
  peerTraffic: boolean;
}>;

export type FeatureModeMatrix = Readonly<{
  off: FeatureModeFetchProfile;
  local_only: FeatureModeFetchProfile;
  optional_peer: FeatureModeFetchProfile;
}>;

/** @deprecated Prefer compareDuressModes — kept for early BUILD stubs. */
const FEATURE_MODE_MATRIX = {
  off: { fetchesDuressUi: false, peerTraffic: false },
  local_only: { fetchesDuressUi: true, peerTraffic: false },
  optional_peer: { fetchesDuressUi: true, peerTraffic: true },
} satisfies FeatureModeMatrix;

export function compareFeatureModes(): FeatureModeMatrix {
  return FEATURE_MODE_MATRIX;
}
