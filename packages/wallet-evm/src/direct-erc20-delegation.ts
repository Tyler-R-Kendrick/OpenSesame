/**
 * `directErc20Delegation` payment adapter.
 *
 * Candidate upstream: MetaMask delegation-framework
 * bff4b08f8006ad94322a6e3da8d90f274e20325d (see package README).
 *
 * Live mode stays fail-closed until a local-chain harness exists.
 * Simulation mode is unit-test only and is NOT contract verification.
 */

import type { InMemorySharedAncestorCounter } from "./simulation.js";
import type {
  AdapterContext,
  AdapterManifest,
  EnforcementAssessment,
  ExecutionObservation,
  PaymentAdapter,
  PaymentAttemptRef,
  PaymentIntent,
  PreparedExecutionRef,
  ReconciliationObservation,
  ReservedApprovedIntent,
  RevocationObservation,
  SpendingAuthorityRef,
  SpendingLease,
} from "./types.js";

/** Inspected candidate pin — not a final release certificate. */
export const DELEGATION_FRAMEWORK_CANDIDATE_COMMIT =
  "bff4b08f8006ad94322a6e3da8d90f274e20325d" as const;

export const DIRECT_ERC20_DELEGATION_ADAPTER_ID =
  "directErc20Delegation" as const;

export type DirectErc20DelegationMode =
  | {
      kind: "live";
    }
  | {
      /**
       * Unit-test path only. In-memory shared-ancestor counter demonstrates
       * overspend rejection semantics in pure TypeScript.
       * NOT contract verification — do not cite as local_execution_verified.
       */
      kind: "simulation";
      enforcer: InMemorySharedAncestorCounter;
    };

export type DirectErc20DelegationOptions = {
  packageVersion?: string;
  /**
   * When true, describe() reports evidenceStatus `blocked` (e.g. missing
   * source pin or operator refusal). Default is `source_inspected` for the
   * documented candidate commit with productionEnabled still false.
   */
  blockDescribe?: boolean;
  mode?: DirectErc20DelegationMode;
};

type PreparedSlot = {
  prepared: PreparedExecutionRef;
  input: ReservedApprovedIntent;
  rootAccountingRef: string;
  consumed: boolean;
};

function defaultManifest(
  packageVersion: string,
  evidenceStatus: "source_inspected" | "blocked",
  readiness: AdapterManifest["readiness"],
): AdapterManifest {
  return {
    adapterId: DIRECT_ERC20_DELEGATION_ADAPTER_ID,
    packageName: "@opensesame/wallet-evm",
    packageVersion,
    protocolVersions: ["evm.direct-erc20-delegation.v0"],
    sourceCommit: DELEGATION_FRAMEWORK_CANDIDATE_COMMIT,
    sourceLicense:
      "MIT (upstream MetaMask delegation-framework; verify at pin)",
    evidenceStatus,
    productionEnabled: false,
    browserRuntimeRequirements: [
      "ES2022",
      "WebCrypto",
      "no window.ethereum injection into third-party origins",
    ],
    mandatoryExternalComponents: [
      "local-chain RPC + deployed DelegationManager/enforcer (BUILD harness)",
    ],
    supportedMechanisms: ["direct_erc20_transfer"],
    supportedAssets: ["erc20"],
    supportedNetworks: ["local-test-only-when-harnessed"],
    supportedConstraints: [
      {
        constraintId: "amount",
        authority: "contract",
        unitsOrTimeSemantics:
          "token smallest units; shared ancestor counter (when harnessed)",
        knownBypassPaths: [
          "alternate entrypoints beyond direct ERC20.transfer",
          "new root IDs that refresh counters under the same budget approval",
        ],
      },
      {
        constraintId: "fixed-interval",
        authority: "contract",
        unitsOrTimeSemantics:
          "period keyed by manager + delegation hash (candidate hypothesis)",
        knownBypassPaths: [
          "calendar policies silently mapped to 86400s (must refuse instead)",
        ],
      },
    ],
    keyArrangement:
      "owner/root delegation with child delegates under a stable shared constrained ancestor",
    independentlyEnforcedScope:
      "direct ERC20.transfer amount (+ period when harnessed); not approvals/channels/arbitrary calls",
    privilegedModules: [
      "DelegationManager",
      "ERC20PeriodTransferEnforcer (candidate)",
    ],
    deploymentIdentity: null,
    revocationSemantics:
      "root revocation may remain pending until chain observation; simulation has no chain",
    outstandingAuthorizationBehavior:
      "outstanding prepared refs expire; live path refuses prepare until harness",
    closureRecoveryRules:
      "reconcile outstanding attempts; do not fabricate external revocation",
    maxUnresolvedExposureAccounting:
      "reserved + submitted-unknown until reconcile; fees tracked separately",
    verificationAssumptions: [
      "owner/root authority is not compromised",
      "token and account implementations match the tested profile",
      "configured chain observations are trustworthy when a harness exists",
      "simulation mode is NOT contract verification",
    ],
    readiness,
  };
}

export function createDirectErc20DelegationAdapter(
  options: DirectErc20DelegationOptions = {},
): PaymentAdapter {
  const packageVersion = options.packageVersion ?? "0.1.0";
  const blockDescribe = options.blockDescribe === true;
  const mode: DirectErc20DelegationMode = options.mode ?? { kind: "live" };
  const prepared = new Map<string, PreparedSlot>();
  let prepareSeq = 0;
  let attemptSeq = 0;

  const adapter: PaymentAdapter = {
    async describe(_context: AdapterContext): Promise<AdapterManifest> {
      if (blockDescribe) {
        return defaultManifest(packageVersion, "blocked", {
          kind: "blocked",
          detail: "Operator blocked describe for this adapter configuration.",
        });
      }
      if (mode.kind === "simulation") {
        return defaultManifest(packageVersion, "source_inspected", {
          kind: "awaiting_harness",
          detail:
            "Simulation mode only — NOT contract verification; wallet:test:contracts pending BUILD harness.",
        });
      }
      return defaultManifest(packageVersion, "source_inspected", {
        kind: "awaiting_harness",
        detail:
          "Local-chain harness not present; independent enforcement unavailable.",
      });
    },

    async assess(
      intent: PaymentIntent,
      lease: SpendingLease,
    ): Promise<EnforcementAssessment> {
      if (intent.asset.kind !== "token") {
        return {
          kind: "refused",
          code: "REQUIRED_CONSTRAINT_UNSUPPORTED",
          detail: "directErc20Delegation only assesses ERC-20 token assets.",
          evidenceStatus: "source_inspected",
          unsupportedConstraints: ["asset.kind"],
          residualExposures: ["full intent amount if executed elsewhere"],
          requiredServices: [],
          keyCustodyTrust: "not_assessed",
          assumptions: [],
        };
      }

      const semantics = intent.asset.transferSemantics ?? "standard";
      if (semantics !== "standard") {
        return {
          kind: "refused",
          code: "REQUIRED_CONSTRAINT_UNSUPPORTED",
          detail: `ERC-20 transfer semantics "${semantics}" are unsupported; activation refused until proven (WAL-E10).`,
          evidenceStatus: "source_inspected",
          unsupportedConstraints: [`asset.transferSemantics.${semantics}`],
          residualExposures: [
            "fee-on-transfer/rebase/callback/upgrade tokens can desync period counters",
          ],
          requiredServices: [],
          keyCustodyTrust: "not_assessed",
          assumptions: [],
        };
      }

      if (intent.requiredEnforcement === "independent_execution") {
        if (mode.kind !== "simulation") {
          return {
            kind: "refused",
            code: "INDEPENDENT_ENFORCEMENT_UNAVAILABLE",
            detail:
              "No local-chain harness; cannot claim independent ERC-20 enforcer checks.",
            evidenceStatus: "source_inspected",
            unsupportedConstraints: [],
            residualExposures: [
              "hostile beneficiary could bypass UI until harness exists",
            ],
            requiredServices: ["wallet:test:contracts harness"],
            keyCustodyTrust: "unverified",
            assumptions: [
              "candidate pin bff4b08 is hypothesis only until executed",
            ],
          };
        }

        // Simulation: amount constraint only, via in-memory shared counter.
        // NOT contract verification.
        return {
          kind: "assessed",
          constraints: [
            {
              constraintRef: "amount",
              requestedDigest: lease.requiredEnforcementDigest,
              effectiveDigest: lease.effectiveEnforcementDigest,
              result: "enforced",
              assumptions: [
                "NOT contract verification — InMemorySharedAncestorCounter only",
                `shared root ${lease.rootAccountingRef}`,
              ],
              evidenceRefs: ["simulation:shared-ancestor-counter"],
              authority: {
                kind: "local_broker",
                origin: "simulation://wallet-evm",
                buildDigest: "simulation-not-a-build",
              },
            },
          ],
          evidenceStatus: "source_inspected",
          residualExposures: [
            "simulation cannot stop a real chain call",
            "period/recipient/zero-native checks not simulated here",
          ],
          requiredServices: [],
          keyCustodyTrust: "simulation_keys_only",
          assumptions: [
            "unit-test simulation mode; productionEnabled remains false",
          ],
        };
      }

      return {
        kind: "refused",
        code: "REQUIRED_CONSTRAINT_UNSUPPORTED",
        detail:
          "local_approval-only intents are not independently enforced by this adapter.",
        evidenceStatus: "source_inspected",
        unsupportedConstraints: ["requiredEnforcement.local_approval"],
        residualExposures: ["approval_only path has no chain enforcer"],
        requiredServices: [],
        keyCustodyTrust: "broker_local",
        assumptions: [],
      };
    },

    async prepare(
      input: ReservedApprovedIntent,
    ): Promise<PreparedExecutionRef> {
      if (mode.kind !== "simulation") {
        throw new Error(
          "INDEPENDENT_ENFORCEMENT_UNAVAILABLE: prepare refused until local-chain harness exists",
        );
      }
      prepareSeq += 1;
      const ref = `prepared:sim:${prepareSeq}`;
      const preparedRef: PreparedExecutionRef = {
        ref,
        intentId: input.intentId,
        expiresAt: input.expiresAt,
        singleUseToken: `single-use:${ref}`,
      };
      prepared.set(ref, {
        prepared: preparedRef,
        input,
        rootAccountingRef: input.rootAccountingRef,
        consumed: false,
      });
      return preparedRef;
    },

    async execute(
      preparedRef: PreparedExecutionRef,
    ): Promise<ExecutionObservation> {
      attemptSeq += 1;
      const attemptRef = `attempt:sim:${attemptSeq}`;

      if (mode.kind !== "simulation") {
        return {
          attemptRef,
          status: "failed",
          detail: "INDEPENDENT_ENFORCEMENT_UNAVAILABLE",
          evidenceRefs: [],
        };
      }

      const slot = prepared.get(preparedRef.ref);
      if (slot === undefined || slot.consumed) {
        return {
          attemptRef,
          status: "failed",
          detail: "PreparedExecutionRef missing, expired, or already used",
          evidenceRefs: [],
        };
      }
      if (slot.prepared.singleUseToken !== preparedRef.singleUseToken) {
        return {
          attemptRef,
          status: "failed",
          detail: "PreparedExecutionRef authentication mismatch",
          evidenceRefs: [],
        };
      }

      // NOT contract verification — pure TS shared-ancestor semantics only.
      const result = mode.enforcer.trySpend(
        slot.rootAccountingRef,
        slot.input.amount,
      );
      slot.consumed = true;

      if (result.kind === "rejected") {
        return {
          attemptRef,
          status: "failed",
          detail: `shared-ancestor overspend rejected (${result.reason}): requested ${result.requested} remaining ${result.remaining}`,
          evidenceRefs: ["simulation:shared-ancestor-counter"],
        };
      }

      return {
        attemptRef,
        status: "confirmed",
        detail: `simulation spend accepted; spent ${result.spent} remaining ${result.remaining}`,
        evidenceRefs: ["simulation:shared-ancestor-counter"],
      };
    },

    async reconcile(
      attempt: PaymentAttemptRef,
    ): Promise<ReconciliationObservation> {
      if (mode.kind !== "simulation") {
        return {
          attemptRef: attempt.ref,
          status: "unknown",
          detail: "INDEPENDENT_ENFORCEMENT_UNAVAILABLE",
          evidenceRefs: [],
        };
      }
      return {
        attemptRef: attempt.ref,
        status: "matched",
        detail: "simulation has no external chain; observation is local only",
        evidenceRefs: ["simulation:shared-ancestor-counter"],
      };
    },

    async requestStop(
      authority: SpendingAuthorityRef,
    ): Promise<RevocationObservation> {
      if (mode.kind !== "simulation") {
        return {
          authorityRef: authority.ref,
          status: "unavailable",
          detail: "INDEPENDENT_ENFORCEMENT_UNAVAILABLE",
          evidenceRefs: [],
        };
      }
      return {
        authorityRef: authority.ref,
        status: "revoked",
        detail: "simulation stop is local only — NOT on-chain root revocation",
        evidenceRefs: ["simulation:local-stop"],
      };
    },
  };

  return adapter;
}
