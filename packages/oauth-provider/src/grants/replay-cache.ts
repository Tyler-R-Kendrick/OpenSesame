/**
 * jti replay fence for `private_key_jwt` client assertions.
 * oidc-provider also tracks ReplayDetection; this cache is the same check
 * as a typed primitive the issuer can unit-test without spinning HTTP.
 * Control-plane replicas pass a DurableMap-backed implementation.
 */
export interface JwtReplayCache {
  remember(
    issuer: string,
    jti: string,
    expiresAtMs: number,
  ): boolean | Promise<boolean>;
}

export class ReplayCache implements JwtReplayCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  private key(issuer: string, jti: string): string {
    return `${issuer}\0${jti}`;
  }

  /**
   * Record `(issuer, jti)` until `expiresAtMs`. Returns false when that
   * pair is already unexpired — a replay.
   */
  remember(issuer: string, jti: string, expiresAtMs: number): boolean {
    this.gc();
    const key = this.key(issuer, jti);
    const now = this.clock();
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(key, expiresAtMs);
    return true;
  }

  has(issuer: string, jti: string): boolean {
    const exp = this.seen.get(this.key(issuer, jti));
    return exp !== undefined && exp > this.clock();
  }

  private gc(): void {
    const now = this.clock();
    for (const [key, exp] of this.seen) {
      if (exp <= now) this.seen.delete(key);
    }
  }
}
