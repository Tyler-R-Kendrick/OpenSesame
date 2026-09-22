/**
 * Policy validity windows and what an offline device does with them (S03).
 *
 * TRUST-09 — the offline envelope. A Pages installation may run for weeks
 * without reaching the origin that issued its policy. The rules:
 *
 * 1. Validity is checked against a clock the CALLER supplies (`now`), at boot
 *    and on every generation bump — never by a timer inside this module.
 * 2. An expired policy stays the ceiling. It is never widened to
 *    personal-local and never dropped: its `required`/`optional`/`prohibited`
 *    sets keep governing, and the store labels the plan `expired` so the UI
 *    can say so.
 * 3. Under an expired or not-yet-valid policy nothing NEW may be accepted:
 *    no new optional root, no new dependency, no re-consent for changed
 *    exposure. What was approved before expiry keeps running; growth waits
 *    for a fresh, verified revision.
 * 4. There is no grace period. `expires` means what it says; an operator who
 *    wants slack issues a later `expires`.
 *
 * TRUST-10 — what this cannot promise. Browser storage is under the person's
 * (and any same-origin script's) control, and the wall clock is a setting.
 * `LIMITATIONS` is the honest list; the UI shows it beside a policy's
 * validity rather than implying a guarantee the platform does not give.
 */
import { parseIsoTime } from "./digest.js";

export type PolicyValidity =
  | "valid"
  | "expired"
  | "not-yet-valid"
  | "malformed-time";

export type ValidityWindow = Readonly<{
  notBefore?: string;
  expires?: string;
}>;

/** `now` is ISO 8601 and supplied by the caller; a bad `now` is `malformed-time`. */
export function policyValidity(window: ValidityWindow, now: string): PolicyValidity {
  const at = parseIsoTime(now);
  if (at === null) return "malformed-time";
  const notBefore = parseIsoTime(window.notBefore);
  const expires = parseIsoTime(window.expires);
  if (window.notBefore !== undefined && notBefore === null) return "malformed-time";
  if (window.expires !== undefined && expires === null) return "malformed-time";
  if (notBefore !== null && at < notBefore) return "not-yet-valid";
  if (expires !== null && at >= expires) return "expired";
  return "valid";
}

/** What an installation may still do under each validity state. */
export type OfflineAllowance = Readonly<{
  /** Approved capabilities keep running. */
  keepRunning: boolean;
  /** New roots, dependencies or re-consent may be accepted. */
  acceptNew: boolean;
  /** The policy stays the ceiling; it is never replaced by personal-local. */
  remainsCeiling: boolean;
}>;

export const OFFLINE_ENVELOPE: Readonly<Record<PolicyValidity, OfflineAllowance>> =
  Object.freeze({
    valid: { keepRunning: true, acceptNew: true, remainsCeiling: true },
    expired: { keepRunning: true, acceptNew: false, remainsCeiling: true },
    "not-yet-valid": { keepRunning: false, acceptNew: false, remainsCeiling: true },
    "malformed-time": { keepRunning: false, acceptNew: false, remainsCeiling: true },
  });

export function offlineAllowance(validity: PolicyValidity): OfflineAllowance {
  return OFFLINE_ENVELOPE[validity];
}

/** TRUST-10: stated in the product, not buried in a comment. */
export const LIMITATIONS: readonly string[] = Object.freeze([
  "Browser storage can be cleared or restored from a copy, so the accepted-revision record can be rolled back with it. It is a witness against accidental rollback, not a proof against a deliberate one.",
  "The device clock is a setting. A policy's validity window is checked against the time the device reports, which a person can move.",
  "An expired policy keeps governing until a newer verified revision arrives; nothing widens on expiry, and nothing new is accepted until then.",
  "Verification proves which trusted key signed a policy. It does not prove the key's holder is who the invitation says — that is what the fingerprint comparison is for.",
]);
