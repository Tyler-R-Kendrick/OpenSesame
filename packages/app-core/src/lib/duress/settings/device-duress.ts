/**
 * This device's duress code, as Settings › Security sets it (ADR 0155).
 *
 * One code per device. Typed complete where a vault is unlocked, it is caught
 * before any unwrap and the person is shown one of two things, never the
 * vault: an empty decoy that reads as a normal unlock, or the refusal a wrong
 * password gets. Both run wholly on the device. What a code does is a mode in
 * the registry (`modes/`), sealed with the code, so nothing stored says which
 * was chosen.
 *
 * The rest of the duress vocabulary — holds, custodians, alerts, removal —
 * needs recipients or an independent authority a browser cannot supply
 * alone, and the unlock path applies none of it; so this module offers
 * neither, rather than a switch that promises what unlock does not do.
 */

import { clearIncidentJournalsDurable } from "../incident/intent-journal.js";
import {
  DURESS_PIN_MAX,
  DURESS_PIN_MIN,
  assertDuressCodeLength,
} from "../keys/pin-floors.js";
import { duressSessionFence } from "../session/fence.js";
import { loadEnrollmentStateForUnlock } from "../store/unlock-enrollment.js";
import {
  type DuressMode,
  type DuressModeId,
  encodePlan,
  getMode,
  inputReady,
} from "./modes/index.js";
import {
  armPersistedUnlockEnrollment,
  disarmPersistedUnlockEnrollment,
  sealUnlockTriggerFromCeremony,
} from "./unlock-arming.js";

/** The digits a duress code may have, worded once for every surface. */
export const DURESS_CODE_DIGITS = `${DURESS_PIN_MIN} to ${DURESS_PIN_MAX} digits`;

/** Whether `code` is a code this device will seal, before anything is tried. */
export function isAcceptableDuressCode(code: string): boolean {
  try {
    assertDuressCodeLength(code);
    return true;
  } catch {
    return false;
  }
}

export const DEVICE_DURESS_PROFILE = "device-duress";
/** Enrollment is device-wide (ADR 0130); the binding names this browser. */
export const DEVICE_BINDING = "this-browser";

/** What entering the code does: a mode's id (`modes/`). */
export type DuressOutcome = DuressModeId;

export type DuressStatus = Readonly<{
  /** A code is set and armed. */
  armed: boolean;
  /** Incidents this device has not yet been cleared of. */
  incidents: number;
}>;

export type DuressRefusal =
  /** Not the digits a code may have. */
  | "code_format"
  /** It would open a vault here in the ordinary way. */
  | "collides"
  /** The browser would not keep it. */
  | "not_durable"
  /** A duress response holds this device. */
  | "incident_active"
  | "failed";

export type DuressResult = { ok: true } | { ok: false; code: DuressRefusal };

export function duressStatus(): DuressStatus {
  const state = loadEnrollmentStateForUnlock();
  return {
    armed: Boolean(state?.armed && state.triggers.length > 0),
    incidents: duressSessionFence.readFence().activeIncidentIds.length,
  };
}

type Checked =
  | { readonly ok: true; readonly mode: DuressMode }
  | { readonly ok: false; readonly code: DuressRefusal };

/** What can be refused before anything is sealed: a held device, a bad code, an unknown mode. */
function checkRequest(input: {
  code: string;
  mode?: string;
  outcome?: string;
  extras?: Readonly<Record<string, string>>;
}): Checked {
  if (duressSessionFence.readFence().activeIncidentIds.length > 0) {
    return { ok: false, code: "incident_active" };
  }
  if (!isAcceptableDuressCode(input.code)) {
    return { ok: false, code: "code_format" };
  }
  const mode = getMode(input.mode ?? input.outcome ?? "");
  if (!mode || !inputReady(mode, input.extras ?? {})) {
    return { ok: false, code: "failed" };
  }
  return { ok: true, mode };
}

function refusalFor(message: string): DuressRefusal {
  if (message.startsWith("code ")) return "code_format";
  if (message.includes("ambiguous_trigger") || message.includes("collide")) {
    return "collides";
  }
  return "failed";
}

/**
 * Seal the code, prove the sealed slot opens with it and with nothing else
 * on this device, and arm it. Replaces any code already set.
 */
export async function enableDuressCode(input: {
  code: string;
  /** The mode's id. Unknown ids refuse with `failed`. */
  mode?: string;
  /** The name `mode` had before the registry; read when `mode` is absent. */
  outcome?: string;
  /** Values for the inputs the mode declares, by the input's id. */
  extras?: Readonly<Record<string, string>>;
  /** The vault the owner is in, so the enrollment names a real one. */
  vaultRef: string;
  /**
   * A code the browser would lose on reload fails silently when it is needed
   * most, so arming refuses without durable storage. Only tests turn it off.
   */
  requireDurable?: boolean;
}): Promise<DuressResult> {
  const request = checkRequest(input);
  if (!request.ok) return request;
  const { mode } = request;
  try {
    // One code per device: a fresh enrollment, never the old one with a new
    // trigger added. Replacing by profile id only drops a trigger of the same
    // id, so an older code under another profile would keep firing. The
    // revisions carry over so nothing sealed against them goes stale.
    const before = loadEnrollmentStateForUnlock();
    const sealed = await sealUnlockTriggerFromCeremony({
      code: input.code,
      profileId: DEVICE_DURESS_PROFILE,
      vaultRef: input.vaultRef,
      deviceBindingRef: DEVICE_BINDING,
      presentation: mode.presentation,
      ...(mode.plan
        ? { payload: encodePlan(mode.plan(input.extras ?? {})) }
        : {}),
      previous: null,
      policyRevision: before?.policyRevision ?? 1,
      keyEpoch: before?.keyEpoch ?? 1,
      ownerConsent: true,
      capabilities: { durableLocalStorage: true, offlineReady: true },
    });
    const armed = await armPersistedUnlockEnrollment(sealed, {
      requireDurable: input.requireDurable ?? true,
    });
    if (!armed.ok) return { ok: false, code: "not_durable" };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: refusalFor(error instanceof Error ? error.message : ""),
    };
  }
}

/**
 * Turn the code off. The vault is untouched. Succeeds only once storage has
 * forgotten the enrollment, so a reload cannot bring the code back.
 */
export async function removeDuressCode(): Promise<DuressResult> {
  if (duressSessionFence.readFence().activeIncidentIds.length > 0) {
    return { ok: false, code: "incident_active" };
  }
  try {
    await disarmPersistedUnlockEnrollment();
  } catch {
    return { ok: false, code: "failed" };
  }
  return { ok: true };
}

export type DuressClearResult =
  | { ok: true; status: DuressStatus }
  | { ok: false; code: "failed" };

/**
 * The owner clears what the code set off. A duress unlock leaves the device
 * fenced — the person who unlocked is held to a guest's powers, travel and
 * code changes are refused — and only a session opened with the vault's own
 * key gets here: the panel is not drawn to a guest or a decoy. Clearing is
 * the owner's word that the danger has passed; the code stays armed.
 *
 * The incident journals go first and storage must confirm it: they say
 * "active" until they are gone, and restart recovery would put a cleared fence
 * back from them. If they will not go, the fence stays and nothing is
 * reported cleared, so the owner can try again.
 */
export async function clearDuressIncidents(): Promise<DuressClearResult> {
  try {
    await clearIncidentJournalsDurable();
  } catch {
    return { ok: false, code: "failed" };
  }
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
  return { ok: true, status: duressStatus() };
}
