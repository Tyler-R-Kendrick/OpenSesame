/**
 * Single-use SIOP login state — binds the outbound nonce to the returning `state`.
 */

export type PendingSiopAuth = {
  nonce: string;
  issuedAtMs: number;
};

export type NonceStoreErrorCode =
  | "unknown_state"
  | "state_replay"
  | "state_expired";

export class NonceStoreError extends Error {
  readonly code: NonceStoreErrorCode;
  constructor(code: NonceStoreErrorCode, message: string) {
    super(message);
    this.name = "NonceStoreError";
    this.code = code;
  }
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class NonceStore {
  private readonly pending = new Map<string, PendingSiopAuth>();
  private readonly consumed = new Map<string, number>();

  private pruneConsumed(nowMs: number, ttlMs: number): void {
    for (const [state, consumedAtMs] of this.consumed) {
      if (nowMs - consumedAtMs > ttlMs) {
        this.consumed.delete(state);
      }
    }
  }

  issue(state: string, nonce: string, issuedAtMs: number): void {
    this.pruneConsumed(issuedAtMs, DEFAULT_TTL_MS);
    this.pending.set(state, { nonce, issuedAtMs });
  }

  /**
   * Atomically removes pending state for verify-in-flight.
   * Call {@link restore} on verify failure so a correct token can still land.
   * Call {@link finish} after a successful verify.
   */
  claim(
    state: string,
    nowMs: number,
    ttlMs: number = DEFAULT_TTL_MS,
  ): PendingSiopAuth {
    this.pruneConsumed(nowMs, ttlMs);
    if (this.consumed.has(state)) {
      throw new NonceStoreError(
        "state_replay",
        "This sign-in response was already processed.",
      );
    }
    const row = this.pending.get(state);
    if (!row) {
      throw new NonceStoreError(
        "unknown_state",
        "No matching sign-in attempt for this response.",
      );
    }
    if (nowMs - row.issuedAtMs > ttlMs) {
      this.pending.delete(state);
      throw new NonceStoreError(
        "state_expired",
        "The sign-in attempt expired. Start again from the application.",
      );
    }
    this.pending.delete(state);
    return row;
  }

  /** Puts a claimed pending row back after a failed ID Token verify. */
  restore(state: string, row: PendingSiopAuth): void {
    if (this.consumed.has(state)) return;
    this.pending.set(state, row);
  }

  /** Marks a claimed state consumed after a successful ID Token verify. */
  finish(state: string, nowMs: number, ttlMs: number = DEFAULT_TTL_MS): void {
    this.pruneConsumed(nowMs, ttlMs);
    this.pending.delete(state);
    this.consumed.set(state, nowMs);
  }
}
