/**
 * Lifecycle contracts for the loader (S06) and worker hosts (S08).
 *
 * TYPES ONLY — no runtime logic, no DOM, no timers. The resolver computes
 * plan identity; these are the handles the loader will mint, hold and revoke
 * against that identity. Implementations live elsewhere.
 */
import type { ModuleId } from "./ids.js";

/**
 * A bounded activation lease for one module, minted per plan generation.
 * `expiresAtKind: "plan-generation"` means the lease does not use wall-clock
 * time: it expires when the plan generation that minted it is superseded.
 */
export type ModuleActivationLease = {
  readonly moduleId: ModuleId;
  /** The plan this lease was minted against (see digest.ts caveats). */
  readonly planDigest: string;
  /** Monotonic generation counter of the minting plan. */
  readonly generation: number;
  readonly expiresAtKind: "plan-generation";
};

/**
 * A handle over a loaded contribution that can be revoked. After `revoke()`
 * the handle must stop dispatching; implementations must make repeated
 * revocation idempotent.
 */
export type ContributionHandle = {
  readonly handleId: string;
  readonly moduleId: ModuleId;
  readonly planDigest: string;
  /** Idempotent revoke: later calls observe the already-revoked state. */
  revoke(): void;
  isRevoked(): boolean;
};

/**
 * Gate every dispatch passes before reaching a contribution. The loader
 * (S06) implements this; worker hosts (S08) depend on it through types.
 */
export type DispatchGate = {
  /** True when dispatch may proceed for this module right now. */
  allows(moduleId: ModuleId, planDigest: string): boolean;
  /** Human-readable refusal when `allows` returned false. */
  refusalReason?(moduleId: ModuleId): string;
};

/** A reference to one compiled variant of a worker graph. */
export type WorkerVariantRef = {
  readonly variantId: string;
  readonly moduleId: ModuleId;
  readonly planDigest: string;
  /** Asset ids that make up this variant; resolved by the build (S07). */
  readonly assetIds: readonly string[];
};
