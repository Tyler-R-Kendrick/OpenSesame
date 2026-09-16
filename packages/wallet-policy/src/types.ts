/**
 * Typed spending-constraint vocabulary and enforcement assessment shapes.
 *
 * Natural-language instructions are not constraints. Only members of
 * `CONSTRAINT_KINDS` may enter `assess`. DOM (`packages/os-domain/src/wallet/`)
 * has not landed AmountUnits yet, so wire-safe local aliases live here.
 */

/** Opaque stable identifier. */
export type Ref = string;

/** Digest of a constraint or set — deterministic canonical form. */
export type Digest = string;

/**
 * Smallest currency subunit as a canonical non-negative integer decimal string.
 * Never a JS number; never a float.
 */
export type AmountUnits = string;

export const CONSTRAINT_KINDS = [
  "amount",
  "recipient",
  "period",
  "fee",
  "redelegation",
  "asset",
] as const;

export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export type AssetRef =
  | {
      readonly kind: "fiat";
      readonly currency: string;
      readonly exponent: number;
    }
  | {
      readonly kind: "token";
      readonly chainId: string;
      readonly contract: string;
      readonly decimals: number;
      readonly deploymentFingerprint: Digest;
    };

export type BudgetWindow =
  | {
      readonly kind: "lifetime";
      readonly validFrom: string;
      readonly validUntil: string;
    }
  | {
      readonly kind: "fixed_interval";
      readonly anchor: string;
      readonly durationSeconds: string;
      readonly validUntil: string;
      readonly rollover: "none";
    }
  | {
      readonly kind: "calendar";
      readonly unit: "day" | "month";
      readonly timeZone: string;
      readonly boundaryScheduleRef: Ref;
      readonly validUntil: string;
      readonly rollover: "none";
    };

export type AmountConstraint = {
  readonly kind: "amount";
  readonly ref: Ref;
  readonly ceiling: AmountUnits;
  readonly critical: boolean;
};

export type RecipientConstraint = {
  readonly kind: "recipient";
  readonly ref: Ref;
  /** Exact destination identities. Empty means refuse (no default-allow). */
  readonly allowed: readonly string[];
  readonly critical: boolean;
};

export type PeriodConstraint = {
  readonly kind: "period";
  readonly ref: Ref;
  readonly window: BudgetWindow;
  readonly critical: boolean;
};

export type FeeConstraint = {
  readonly kind: "fee";
  readonly ref: Ref;
  readonly maxFee: AmountUnits;
  readonly critical: boolean;
};

export type RedelegationConstraint = {
  readonly kind: "redelegation";
  readonly ref: Ref;
  /** 0 = no further delegation. */
  readonly maxDepth: number;
  readonly critical: boolean;
};

export type AssetConstraint = {
  readonly kind: "asset";
  readonly ref: Ref;
  readonly asset: AssetRef;
  readonly critical: boolean;
};

export type PolicyConstraint =
  | AmountConstraint
  | RecipientConstraint
  | PeriodConstraint
  | FeeConstraint
  | RedelegationConstraint
  | AssetConstraint;

/**
 * A closed set of typed constraints. One entry per kind.
 * `adjustmentAllowed` mirrors ERC-7715-style upstream flags and never
 * authorizes a broader effective grant than `approved`.
 */
export type ConstraintSet = {
  readonly constraints: readonly PolicyConstraint[];
  readonly adjustmentAllowed?: boolean;
};

export type PeriodSemantics =
  | "lifetime"
  | "fixed_interval"
  | "calendar"
  | "none";

export type EnforcementAuthority =
  | {
      readonly kind: "local_broker";
      readonly origin: string;
      readonly buildDigest: Digest;
    }
  | {
      readonly kind: "contract";
      readonly chainId: string;
      readonly account: string;
      readonly manager: string;
      readonly sharedRootRef: Ref;
      readonly deploymentManifestRef: Ref;
    }
  | {
      readonly kind: "preallocated_purse";
      readonly allocationRef: Ref;
      readonly accountRef: Ref;
    }
  | {
      readonly kind: "escrow";
      readonly channelRef: Ref;
      readonly deploymentManifestRef: Ref;
    }
  | {
      readonly kind: "owner_service";
      readonly connectionRef: Ref;
      readonly ledgerNamespace: Ref;
    }
  | {
      readonly kind: "issuer";
      readonly connectionRef: Ref;
      readonly instrumentRef: Ref;
    };

/**
 * What a mechanism can actually enforce — not a provider brand claim.
 * Period semantics stay distinct: fixed_interval never satisfies calendar.
 */
export type ProviderCapabilities = {
  readonly periodSemantics: PeriodSemantics;
  readonly enforcedKinds: readonly ConstraintKind[];
  readonly authority: EnforcementAuthority;
};

export type ProviderEffective = ConstraintSet & {
  readonly capabilities?: ProviderCapabilities;
};

export type EnforcementResult = "enforced" | "approval_only" | "unsupported";

export const POLICY_DETAIL_CODES = [
  "POLICY_WIDENING_REFUSED",
  "REQUIRED_CONSTRAINT_UNSUPPORTED",
  "PERIOD_SEMANTICS_UNSUPPORTED",
  "UNKNOWN_CRITICAL_CONSTRAINT",
  "EMPTY_RECIPIENT_ALLOWLIST",
] as const;

export type PolicyDetailCode = (typeof POLICY_DETAIL_CODES)[number];

export type ConstraintEnforcement = {
  readonly constraintRef: Ref;
  readonly kind: ConstraintKind;
  readonly requestedDigest: Digest;
  readonly effectiveDigest: Digest;
  readonly result: EnforcementResult;
  readonly assumptions: readonly string[];
  readonly evidenceRefs: readonly Ref[];
  readonly authority?: EnforcementAuthority;
  readonly detailCode?: PolicyDetailCode;
};
