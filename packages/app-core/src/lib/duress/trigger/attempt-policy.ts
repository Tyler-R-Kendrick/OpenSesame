/**
 * Attempt / throttle policy for complete trigger submissions (INV-25).
 * Throttling is allowed; attempt counts never auto-activate a profile.
 */

export type AttemptPolicyConfig = Readonly<{
  /** Failures in window before throttle. */
  maxFailures: number;
  /** Sliding window for counting failures (ms). */
  windowMs: number;
  /** Lockout duration after threshold (ms). */
  lockoutMs: number;
}>;

const DEFAULT_CONFIG: AttemptPolicyConfig = {
  maxFailures: 8,
  windowMs: 60_000,
  lockoutMs: 15_000,
};

export type CompleteAttemptGate = Readonly<{
  allowed: boolean;
  reason: "ok" | "throttled";
}>;

export class TriggerAttemptPolicy {
  readonly config: AttemptPolicyConfig;
  #failures: number[] = [];
  #lockedUntil = 0;

  constructor(config: Partial<AttemptPolicyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** INV-25 — always false; counters never escalate to a trigger. */
  wouldAutoTriggerFromAttemptCount(): false {
    return false;
  }

  isThrottled(now = Date.now()): boolean {
    return now < this.#lockedUntil;
  }

  /**
   * Gate a complete submission attempt. Partial entry must not call this.
   * Returns whether the attempt may proceed (not whether a profile matched).
   */
  beginCompleteAttempt(now = Date.now()): CompleteAttemptGate {
    if (this.isThrottled(now)) {
      return {
        allowed: false,
        reason: "throttled",
      } satisfies CompleteAttemptGate;
    }
    return { allowed: true, reason: "ok" } satisfies CompleteAttemptGate;
  }

  /** Record a complete miss. Never activates a duress profile. */
  recordCompleteMiss(now = Date.now()): void {
    const cut = now - this.config.windowMs;
    this.#failures = this.#failures.filter((t) => t >= cut);
    this.#failures.push(now);
    if (this.#failures.length >= this.config.maxFailures) {
      this.#lockedUntil = now + this.config.lockoutMs;
      this.#failures = [];
    }
  }

  /** Successful match clears the failure window (not a trigger itself). */
  recordCompleteHit(): void {
    this.#failures = [];
    this.#lockedUntil = 0;
  }

  failureCount(now = Date.now()): number {
    const cut = now - this.config.windowMs;
    return this.#failures.filter((t) => t >= cut).length;
  }
}
