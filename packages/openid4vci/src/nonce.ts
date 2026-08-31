/**
 * `c_nonce` issuance and single-use consumption.
 *
 * The Nonce Endpoint (OpenID4VCI 1.0 §7) is the one unauthenticated endpoint
 * in the issuance flow — no access token, by design, because a wallet needs a
 * challenge before it has anything to authenticate with. Everything below
 * follows from that: the store's input is attacker-controlled in volume, so
 * its bound is a security parameter and its overflow policy is a decision
 * rather than a default.
 *
 * What a nonce buys us is narrow and worth stating precisely. It does **not**
 * authenticate the wallet, and it does not prove the wallet holds a
 * pre-authorized code. It proves that the key proof in front of us was
 * constructed after a specific moment that we chose — which is what stops a
 * proof captured from one issuance being replayed into another, and what
 * makes the holder's signature evidence of present possession rather than of
 * possession at some unknown time in the past. That is the entire job.
 *
 * Single use is the other half. A nonce that can be consumed twice is a nonce
 * that proves nothing about *which* request the holder signed for, so
 * {@link NonceStore.consume} is a spend, not a lookup, and the interface has
 * no read operation at all.
 */

import { randomBytes } from "node:crypto";
import { refuse } from "./errors.js";

/** 32 bytes → 256 bits. §7.2: "New challenge values MUST be unpredictable." */
const NONCE_BYTES = 32;

/**
 * How long an unspent nonce stays valid.
 *
 * Long enough for a wallet to prompt for biometrics and sign; short enough
 * that a nonce scraped from a log is dead. The proof's own `iat` freshness
 * window in `proof.ts` is the second, independent bound on the same thing —
 * neither is sufficient alone, because a nonce TTL says nothing about when
 * the holder actually signed and an `iat` window is holder-asserted.
 */
export const DEFAULT_NONCE_TTL_SECONDS = 120;

export interface IssuedNonce {
  readonly nonce: string;
  readonly expiresAt: Date;
}

/**
 * The store, injectable.
 *
 * Async because the interesting implementations are not local: a horizontally
 * scaled Credential Endpoint needs a shared store with an atomic
 * compare-and-delete, and forcing that behind a synchronous signature would
 * mean either a lie or a rewrite. The in-memory implementation returns
 * resolved promises and costs nothing.
 *
 * `consume` returns `void` and rejects. That is deliberate: a boolean return
 * can be ignored by a caller that forgot to check it, and the one thing this
 * interface exists to guarantee is that nobody proceeds past a failed spend.
 * Implementations must *reject* rather than throw synchronously — the local
 * implementation below is `async` for exactly that reason, even though it
 * never awaits anything, because a caller writing `store.consume(n).catch(…)`
 * must not be surprised by which side of the promise a refusal arrives on.
 */
export interface NonceStore {
  issue(now?: Date): Promise<IssuedNonce>;
  /**
   * Spend a nonce, or throw.
   *
   * Implementations MUST make consumption atomic with respect to concurrent
   * callers: two requests presenting the same nonce must not both succeed.
   * They MUST NOT let the *wire* response distinguish "never issued" from
   * "already spent" — `errors.ts` maps both to `invalid_nonce` — while
   * remaining free to distinguish them internally, since a replay is an
   * attack signal and an expiry is usually a slow user.
   */
  consume(nonce: string, now?: Date): Promise<void>;
}

interface Expiring {
  readonly expiresAt: number;
}

/**
 * Bounded in-memory nonce store.
 *
 * **Overflow evicts the oldest entry.** Anyone on the internet can POST to the
 * Nonce Endpoint, so refusing to issue when full would hand an attacker a
 * total outage of issuance for the price of a loop. Evicting instead means a
 * flood costs a legitimate wallet one retry: its nonce is dropped, its proof
 * is refused as `invalid_nonce`, and §8.3.1.2 already tells it to fetch a new
 * one. Availability degrades gracefully instead of collapsing, and no nonce is
 * ever accepted twice regardless of pressure.
 *
 * **Spent nonces leave a tombstone.** Deleting on consumption would make a
 * replay indistinguishable from an expiry in our own logs, which is exactly
 * the distinction an operator wants. Tombstones expire on the original
 * schedule and count against the same bound, because an unbounded set of
 * spent values is a memory leak with an attacker holding the pen.
 */
export class MemoryNonceStore implements NonceStore {
  readonly #live = new Map<string, Expiring>();
  readonly #spent = new Map<string, Expiring>();
  readonly #capacity: number;
  readonly #ttlMs: number;

  constructor(capacity = 4096, ttlSeconds = DEFAULT_NONCE_TTL_SECONDS) {
    if (!Number.isInteger(capacity) || capacity <= 0)
      refuse("issuance_refused");
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)
      refuse("issuance_refused");
    this.#capacity = capacity;
    this.#ttlMs = ttlSeconds * 1000;
  }

  /** Live plus tombstoned. Both are bounded by the same capacity. */
  get size(): number {
    return this.#live.size + this.#spent.size;
  }

  async issue(now?: Date): Promise<IssuedNonce> {
    const at = (now ?? new Date()).getTime();
    this.#sweep(at);
    this.#evictTo(this.#capacity - 1);
    const nonce = randomBytes(NONCE_BYTES).toString("base64url");
    const expiresAt = at + this.#ttlMs;
    this.#live.set(nonce, { expiresAt });
    return { nonce, expiresAt: new Date(expiresAt) };
  }

  async consume(nonce: string, now?: Date): Promise<void> {
    const at = (now ?? new Date()).getTime();
    this.#sweep(at);

    const live = this.#live.get(nonce);
    if (live === undefined) {
      // A tombstone means this value was ours and has already been spent.
      // Distinguished here, collapsed to one wire error by `errors.ts`.
      if (this.#spent.has(nonce)) refuse("nonce_replayed");
      refuse("nonce_unknown");
    }
    // Delete first, decide second: the entry is gone before any further
    // branch, so two concurrent callers on one event loop cannot both find it.
    this.#live.delete(nonce);
    if (live.expiresAt <= at) refuse("nonce_unknown");
    this.#spent.set(nonce, { expiresAt: live.expiresAt });
  }

  #sweep(at: number): void {
    for (const [key, entry] of this.#live) {
      if (entry.expiresAt <= at) this.#live.delete(key);
    }
    for (const [key, entry] of this.#spent) {
      if (entry.expiresAt <= at) this.#spent.delete(key);
    }
  }

  /**
   * Drop oldest-first until at most `target` entries remain.
   *
   * `Map` iterates in insertion order, and every entry is inserted with the
   * same TTL, so insertion order is expiry order and the oldest entry is also
   * the one closest to being worthless. Tombstones are dropped before live
   * nonces: forgetting that a spent nonce was spent only costs us the replay
   * signal, whereas forgetting a live one costs a wallet its round trip.
   */
  #evictTo(target: number): void {
    const limit = Math.max(target, 0);
    while (this.size > limit && this.#spent.size > 0) {
      const oldest = this.#spent.keys().next();
      if (oldest.done === true) break;
      this.#spent.delete(oldest.value);
    }
    while (this.size > limit && this.#live.size > 0) {
      const oldest = this.#live.keys().next();
      if (oldest.done === true) break;
      this.#live.delete(oldest.value);
    }
  }
}
