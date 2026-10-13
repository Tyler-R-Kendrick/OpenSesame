import { WrongPasswordError } from "@opensesame/vault-core";

/**
 * Bounds for the parked second step, independent of the unlocked idle
 * auto-lock: the challenge expires on its own timer, and the codes it may
 * send through the Identity API are throttled per challenge.
 */

/** How long a parked second step holds the vault key before it is dropped. */
export const PENDING_CHALLENGE_MS = 5 * 60_000;
/** The shortest gap between two code sends on one parked challenge. */
export const RESEND_COOLDOWN_MS = 60_000;
/** The most codes one parked challenge may send. */
export const MAX_CODE_SENDS = 5;

/** A one-shot expiry for the parked challenge; arming replaces any prior. */
export class PendingChallenge {
  #timer: ReturnType<typeof setTimeout> | null = null;

  arm(onExpire: () => void): void {
    this.clear();
    this.#timer = setTimeout(onExpire, PENDING_CHALLENGE_MS);
  }

  clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/**
 * Client-side resend throttle for the email/text second step: a cooldown
 * between sends and a cap per parked challenge. Defense in depth only — the
 * Identity API rate-limits sends per challenge and address regardless.
 */
export class CodeSendGuard {
  #sentAt = 0;
  #sends = 0;

  reset(): void {
    this.#sentAt = 0;
    this.#sends = 0;
  }

  assertCanSend(now = Date.now()): void {
    if (this.#sends >= MAX_CODE_SENDS) {
      throw new Error("Too many codes sent. Cancel and unlock again.");
    }
    const waitMs = this.#sentAt + RESEND_COOLDOWN_MS - now;
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      throw new Error(`A code was just sent. Try again in ${seconds}s.`);
    }
  }

  noteSent(now = Date.now()): void {
    this.#sentAt = now;
    this.#sends += 1;
  }
}

/** Second-step handlers must not activate after cancel/expiry cleared the challenge. */
export function assertSecondStepPending(
  pending: CryptoKey,
  parked: CryptoKey | null,
): void {
  if (parked !== pending) {
    throw new WrongPasswordError("That second step is no longer pending.");
  }
}

export async function finishSecondStepUnlock(
  pending: CryptoKey,
  parked: CryptoKey | null,
  activate: (key: CryptoKey) => Promise<void>,
): Promise<void> {
  assertSecondStepPending(pending, parked);
  await activate(pending);
}
