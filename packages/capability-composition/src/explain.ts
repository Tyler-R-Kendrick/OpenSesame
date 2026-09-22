import type { ReasonCode } from "./ids.js";
/**
 * Human explanations and structured provenance for resolver decisions.
 * The reason-code strings are the contract; the prose is presentation.
 */
import type {
  EffectivePlan,
  PlanConflict,
  SelectedCapability,
} from "./resolver.js";

/** One human-readable explanation per closed reason code. */
export const REASON_EXPLANATIONS: Readonly<Record<ReasonCode, string>> = {
  NOT_DISTRIBUTED:
    "This capability is not part of the distribution installed on this device.",
  PROHIBITED_BY_INSTANCE:
    "The instance policy explicitly prohibits this capability; prohibition wins over every other rule.",
  DENIED_BY_WORKSPACE:
    "A vault or installation allow-list excludes this capability from the permitted set.",
  NOT_SELECTED:
    "The capability is permitted and shipped but was not selected for this installation.",
  CONSENT_REQUIRED:
    "The capability's declared privileges (egress, key access, browser permissions) require explicit consent that has not been granted.",
  DEPENDENCY_CONFLICT:
    "A capability this one depends on is blocked or missing; dependencies are never auto-enabled.",
  UNSUPPORTED_RUNTIME:
    "No execution environment offered by this runtime satisfies the capability's requirements.",
  POLICY_UNVERIFIED:
    "A governing policy document could not be verified, so nothing may be loaded from it.",
  PROFILE_MISMATCH:
    "The capability's requirements do not match this profile's constraints.",
  NOT_CACHED_OFFLINE:
    "The device is offline and the capability's assets were not pre-cached.",
  RESTART_REQUIRED:
    "Loading this capability requires a document reload; it is provisioned but not yet active.",
  UNKNOWN:
    "The id was not found in the distribution and no descriptor explains it.",
};

/** The explanation string for a reason code. */
export function explainReason(reasonCode: ReasonCode): string {
  return REASON_EXPLANATIONS[reasonCode];
}

/** Structured provenance for one capability's decision. */
export type CapabilityExplanation = {
  readonly capabilityId: string;
  readonly reasonCodes: readonly ReasonCode[];
  readonly explanations: readonly string[];
  /** Which document/scope/rule produced each blocking fact. */
  readonly provenance: readonly string[];
  readonly conflicts: readonly PlanConflict[];
  readonly activationStatus: SelectedCapability["activationStatus"];
};

/**
 * Build a structured explanation for one capability in a plan. Returns
 * `undefined` when the plan does not mention the capability at all.
 */
export function buildExplanation(
  plan: EffectivePlan,
  capabilityId: string,
): CapabilityExplanation | undefined {
  const entry = plan.selected.find((c) => c.id === capabilityId);
  if (entry !== undefined) {
    const mentions = plan.conflicts.filter(
      (c) => c.capabilityId === capabilityId,
    );
    return {
      capabilityId,
      reasonCodes: entry.reasonCodes,
      explanations: entry.reasonCodes.map(explainReason),
      provenance: mentions.map((c) => c.provenance),
      conflicts: mentions,
      activationStatus: entry.activationStatus,
    };
  }
  const mentions = plan.conflicts.filter(
    (c) => c.capabilityId === capabilityId,
  );
  if (mentions.length === 0) return undefined;
  return {
    capabilityId,
    reasonCodes: mentions.map((c) => c.reasonCode),
    explanations: mentions.map((c) => explainReason(c.reasonCode)),
    provenance: mentions.map((c) => c.provenance),
    conflicts: mentions,
    activationStatus: "not-loaded",
  };
}
