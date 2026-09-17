import type { MandateClaims } from "./types.js";

export type MandateFulfillResult =
  | { ok: true; remaining: string }
  | { ok: false; reason: "allowance_exceeded" | "duplicate_jti" };

export class LocalMandateLedger {
  private remaining: bigint;
  private readonly spent = new Set<string>();

  constructor(ceiling: bigint) {
    this.remaining = ceiling;
  }

  fulfill(claims: MandateClaims): MandateFulfillResult {
    if (this.spent.has(claims.jti)) {
      return { ok: false, reason: "duplicate_jti" };
    }
    const amount = BigInt(claims.amount);
    if (amount > this.remaining) {
      return { ok: false, reason: "allowance_exceeded" };
    }
    this.spent.add(claims.jti);
    this.remaining -= amount;
    return { ok: true, remaining: this.remaining.toString() };
  }

  getRemaining(): string {
    return this.remaining.toString();
  }
}
