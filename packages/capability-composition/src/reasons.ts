/**
 * The closed reason vocabulary and its presentation order.
 *
 * Reasons on a `CapabilityState` are sorted by this order so two plans built
 * from the same facts in a different input order print identically.
 */
import { REASON_CODES, type ReasonCode } from "./types-plan.js";

export { REASON_CODES };

/**
 * Codes that make a capability ineligible for any closure — they describe
 * the ceiling, the runtime, or the network, not a person's choice.
 */
export const BLOCKING_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "NOT_DISTRIBUTED",
  "POLICY_UNVERIFIED",
  "PROFILE_MISMATCH",
  "PROHIBITED_BY_INSTANCE",
  "NOT_PERMITTED_BY_INSTANCE",
  "DENIED_BY_WORKSPACE",
  "DISABLED_IN_VAULT",
  "UNSUPPORTED_RUNTIME",
  "NETWORK_POLICY_DENIES",
  "WORKER_GRAPH_UNAVAILABLE",
]);

/** Codes that leave a capability in the consentable closure. */
export const CONSENT_ONLY_REASONS: ReadonlySet<ReasonCode> =
  new Set<ReasonCode>(["CONSENT_REQUIRED", "RESTART_REQUIRED"]);

/** Unique reasons in vocabulary order. */
export function sortReasons(codes: Iterable<ReasonCode>): ReasonCode[] {
  // Looked up per call rather than in a table built at load: the list is
  // eighteen long, and every code is in it (ReasonCode is derived from it).
  return [...new Set(codes)].sort(
    (a, b) => REASON_CODES.indexOf(a) - REASON_CODES.indexOf(b),
  );
}
