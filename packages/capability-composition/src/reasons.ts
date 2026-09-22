/**
 * The closed reason vocabulary and its presentation order.
 *
 * Reasons on a `CapabilityState` are sorted by this order so two plans built
 * from the same facts in a different input order print identically.
 */
import type { ReasonCode } from "./types.js";

export const REASON_CODES: readonly ReasonCode[] = [
  "CORE",
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
  "NOT_SELECTED",
  "REQUIRED_NOT_ACCEPTED",
  "DEPENDENCY_CONFLICT",
  "ALTERNATIVE_NOT_CHOSEN",
  "CONSENT_REQUIRED",
  "NOT_CACHED_OFFLINE",
  "RESTART_REQUIRED",
];

const ORDER: ReadonlyMap<ReasonCode, number> = new Map(
  REASON_CODES.map((code, index) => [code, index]),
);

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
export const CONSENT_ONLY_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(
  ["CONSENT_REQUIRED", "RESTART_REQUIRED"],
);

/** Unique reasons in vocabulary order. */
export function sortReasons(codes: Iterable<ReasonCode>): ReasonCode[] {
  return [...new Set(codes)].sort(
    (a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0),
  );
}
