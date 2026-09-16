/**
 * assess(requested, approved, providerEffective?) → ConstraintEnforcement[]
 *
 * Compares requested vs approved vs provider-returned permissions. Broader
 * returned ERC-7715-style grants are refused even when adjustmentAllowed is set.
 * Calendar periods against a fixed_interval-only mechanism yield
 * PERIOD_SEMANTICS_UNSUPPORTED — never a silent 86400s mapping.
 */

import { isBroaderThan } from "./compare.js";
import { constraintDigest } from "./digest.js";
import { indexByKind } from "./intersect.js";
import type {
  ConstraintEnforcement,
  ConstraintKind,
  ConstraintSet,
  EnforcementAuthority,
  EnforcementResult,
  PeriodConstraint,
  PolicyConstraint,
  PolicyDetailCode,
  ProviderCapabilities,
  ProviderEffective,
} from "./types.js";
import { CONSTRAINT_KINDS } from "./types.js";

type EnforcementDraft = {
  readonly constraintRef: string;
  readonly kind: ConstraintKind;
  readonly requestedDigest: string;
  readonly effectiveDigest: string;
  readonly result: EnforcementResult;
  readonly assumptions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly authority?: EnforcementAuthority;
  readonly detailCode?: PolicyDetailCode;
};

type ApprovedAssessment = {
  readonly approved: PolicyConstraint;
  readonly requested: PolicyConstraint | undefined;
  readonly providerEffective: ProviderEffective | undefined;
};

type DraftInput = Omit<EnforcementDraft, "assumptions" | "evidenceRefs"> & {
  readonly assumptions?: readonly string[];
  readonly evidenceRefs?: readonly string[];
};

function enforcement(draftValue: EnforcementDraft): ConstraintEnforcement {
  const base = {
    constraintRef: draftValue.constraintRef,
    kind: draftValue.kind,
    requestedDigest: draftValue.requestedDigest,
    effectiveDigest: draftValue.effectiveDigest,
    result: draftValue.result,
    assumptions: draftValue.assumptions,
    evidenceRefs: draftValue.evidenceRefs,
  } satisfies Omit<ConstraintEnforcement, "authority" | "detailCode">;

  if (
    draftValue.authority !== undefined &&
    draftValue.detailCode !== undefined
  ) {
    return {
      ...base,
      authority: draftValue.authority,
      detailCode: draftValue.detailCode,
    };
  }
  if (draftValue.authority !== undefined) {
    return { ...base, authority: draftValue.authority };
  }
  if (draftValue.detailCode !== undefined) {
    return { ...base, detailCode: draftValue.detailCode };
  }
  return base;
}

function draft(partial: DraftInput): EnforcementDraft {
  const withCore: EnforcementDraft = {
    constraintRef: partial.constraintRef,
    kind: partial.kind,
    requestedDigest: partial.requestedDigest,
    effectiveDigest: partial.effectiveDigest,
    result: partial.result,
    assumptions: partial.assumptions ?? [],
    evidenceRefs: partial.evidenceRefs ?? [],
  };
  if (partial.authority !== undefined && partial.detailCode !== undefined) {
    return {
      ...withCore,
      authority: partial.authority,
      detailCode: partial.detailCode,
    };
  }
  if (partial.authority !== undefined) {
    return { ...withCore, authority: partial.authority };
  }
  if (partial.detailCode !== undefined) {
    return { ...withCore, detailCode: partial.detailCode };
  }
  return withCore;
}

function capabilitiesEnforce(
  capabilities: ProviderCapabilities | undefined,
  kind: ConstraintKind,
): boolean {
  if (capabilities === undefined) {
    return false;
  }
  return capabilities.enforcedKinds.includes(kind);
}

function periodSemanticsUnsupported(
  approved: PeriodConstraint,
  capabilities: ProviderCapabilities | undefined,
): boolean {
  if (approved.window.kind !== "calendar") {
    return false;
  }
  if (capabilities === undefined) {
    return true;
  }
  return capabilities.periodSemantics !== "calendar";
}

function assessApprovedConstraint(
  input: ApprovedAssessment,
): ConstraintEnforcement {
  const { approved, requested, providerEffective } = input;
  const requestedDigest = constraintDigest(requested ?? approved);
  const approvedDigest = constraintDigest(approved);

  if (requested !== undefined && isBroaderThan(requested, approved)) {
    return enforcement(
      draft({
        constraintRef: approved.ref,
        kind: approved.kind,
        requestedDigest,
        effectiveDigest: approvedDigest,
        result: "unsupported",
        detailCode: "POLICY_WIDENING_REFUSED",
        assumptions: ["requested exceeds approved"],
      }),
    );
  }

  if (approved.kind === "recipient" && approved.allowed.length === 0) {
    return enforcement(
      draft({
        constraintRef: approved.ref,
        kind: approved.kind,
        requestedDigest,
        effectiveDigest: approvedDigest,
        result: "unsupported",
        detailCode: "EMPTY_RECIPIENT_ALLOWLIST",
        assumptions: ["empty recipient allow-list is not default-allow"],
      }),
    );
  }

  if (providerEffective === undefined) {
    return enforcement(
      draft({
        constraintRef: approved.ref,
        kind: approved.kind,
        requestedDigest,
        effectiveDigest: approvedDigest,
        result: "approval_only",
        assumptions: ["no provider-effective permissions supplied"],
      }),
    );
  }

  const effectiveMap = indexByKind(providerEffective.constraints);
  const effective = effectiveMap.get(approved.kind);

  if (effective === undefined) {
    const assumptions =
      providerEffective.adjustmentAllowed === true
        ? ([
            "inherited constraint omitted from provider-effective permissions",
            "adjustmentAllowed does not authorize omission",
          ] as const)
        : ([
            "inherited constraint omitted from provider-effective permissions",
            "omission is not attenuation",
          ] as const);
    return enforcement(
      draft({
        constraintRef: approved.ref,
        kind: approved.kind,
        requestedDigest,
        effectiveDigest: approvedDigest,
        result: "unsupported",
        detailCode: "REQUIRED_CONSTRAINT_UNSUPPORTED",
        assumptions,
      }),
    );
  }

  const effectiveDigest = constraintDigest(effective);

  if (
    approved.kind === "period" &&
    periodSemanticsUnsupported(approved, providerEffective.capabilities)
  ) {
    return enforcement(
      draft({
        constraintRef: approved.ref,
        kind: approved.kind,
        requestedDigest,
        effectiveDigest,
        result: "unsupported",
        detailCode: "PERIOD_SEMANTICS_UNSUPPORTED",
        assumptions: [
          "calendar period requested",
          `provider periodSemantics=${providerEffective.capabilities?.periodSemantics ?? "none"}`,
          "fixed_interval must not be presented as a calendar day",
        ],
      }),
    );
  }

  if (
    approved.kind === "period" &&
    effective.kind === "period" &&
    approved.window.kind !== effective.window.kind
  ) {
    return enforcement(
      draft({
        constraintRef: approved.ref,
        kind: approved.kind,
        requestedDigest,
        effectiveDigest,
        result: "unsupported",
        detailCode: "PERIOD_SEMANTICS_UNSUPPORTED",
        assumptions: [
          `approved window kind=${approved.window.kind}`,
          `effective window kind=${effective.window.kind}`,
          "period window kinds are not interchangeable",
        ],
      }),
    );
  }

  if (isBroaderThan(effective, approved)) {
    const assumptions =
      providerEffective.adjustmentAllowed === true
        ? ([
            "provider-effective permissions are broader than approved",
            "adjustmentAllowed does not authorize widening",
          ] as const)
        : ([
            "provider-effective permissions are broader than approved",
            "returned permissions are not a trusted echo",
          ] as const);
    return enforcement(
      draft({
        constraintRef: approved.ref,
        kind: approved.kind,
        requestedDigest,
        effectiveDigest,
        result: "unsupported",
        detailCode: "POLICY_WIDENING_REFUSED",
        assumptions,
      }),
    );
  }

  if (!capabilitiesEnforce(providerEffective.capabilities, approved.kind)) {
    if (approved.critical) {
      return enforcement(
        draft({
          constraintRef: approved.ref,
          kind: approved.kind,
          requestedDigest,
          effectiveDigest,
          result: "unsupported",
          detailCode: "UNKNOWN_CRITICAL_CONSTRAINT",
          assumptions: [
            "critical constraint lacks independent enforcement authority",
          ],
        }),
      );
    }
    return enforcement(
      draft({
        constraintRef: approved.ref,
        kind: approved.kind,
        requestedDigest,
        effectiveDigest,
        result: "approval_only",
        assumptions: [
          "constraint retained as approval-only; not independently enforced",
        ],
      }),
    );
  }

  const authority = providerEffective.capabilities?.authority;
  if (authority === undefined) {
    return enforcement(
      draft({
        constraintRef: approved.ref,
        kind: approved.kind,
        requestedDigest,
        effectiveDigest,
        result: "enforced",
        assumptions: ["enforcedKinds listed kind without authority descriptor"],
      }),
    );
  }
  return enforcement(
    draft({
      constraintRef: approved.ref,
      kind: approved.kind,
      requestedDigest,
      effectiveDigest,
      result: "enforced",
      assumptions: [],
      authority,
    }),
  );
}

/**
 * Assess requested + approved (+ optional provider-effective) constraints.
 *
 * - Every approved constraint yields one `ConstraintEnforcement`.
 * - Requested kinds absent from approved are reported as widening refusals.
 * - `adjustmentAllowed` on provider-effective never passes a broader grant.
 */
export function assess(
  requested: ConstraintSet,
  approved: ConstraintSet,
  providerEffective?: ProviderEffective,
): ConstraintEnforcement[] {
  const approvedMap = indexByKind(approved.constraints);
  const requestedMap = indexByKind(requested.constraints);
  const results: ConstraintEnforcement[] = [];

  for (const kind of CONSTRAINT_KINDS) {
    const approvedConstraint = approvedMap.get(kind);
    if (approvedConstraint === undefined) {
      const orphanRequest = requestedMap.get(kind);
      if (orphanRequest !== undefined) {
        const digest = constraintDigest(orphanRequest);
        results.push(
          enforcement(
            draft({
              constraintRef: orphanRequest.ref,
              kind,
              requestedDigest: digest,
              effectiveDigest: digest,
              result: "unsupported",
              detailCode: "POLICY_WIDENING_REFUSED",
              assumptions: ["requested kind is not present in approved policy"],
            }),
          ),
        );
      }
      continue;
    }
    const assessment: ApprovedAssessment = {
      approved: approvedConstraint,
      requested: requestedMap.get(kind),
      providerEffective,
    };
    results.push(assessApprovedConstraint(assessment));
  }

  return results;
}
