/**
 * Durable stores for the OpenID4VCI issuer — grants, nonces, access tokens.
 *
 * The `@opensesame/openid4vci` package ships `MemoryPreAuthorizedCodeStore`
 * and `MemoryNonceStore`, and its own header says why they are process-local:
 * a single process wants a `Map`, a horizontally scaled gateway wants
 * something with an atomic compare-and-delete. This file is that something.
 *
 * Every store here delegates its state to a {@link SecurityMap} — a plain
 * `Map` in a dev run or a test, a {@link DurableMap} (Postgres, shared by
 * every replica) wherever a `DATABASE_URL` is set. The security-sensitive
 * decisions do not move: expiry and the constant-time Transaction Code check
 * stay in the package's {@link redeemGrant}, and the only thing a store adds
 * is the *atomic spend* — fetch-and-remove in one step — so two replicas
 * presenting one pre-authorized code cannot both win. That is exactly what
 * `DurableMap.take` provides and what `takeSecurityMap` preserves for the
 * `Map` case.
 *
 * A pre-authorized code, a `c_nonce` and an access token are all bearers, so
 * the durable variant hashes its keys (`secretKeys`): a database dump is not a
 * second copy of a live secret.
 */

import { randomBytes } from "node:crypto";
import type {
  IssuedNonce,
  NonceStore,
  PreAuthorizedGrant,
  RedeemedGrant,
} from "@opensesame/openid4vci";
import { Openid4vciError, redeemGrant } from "@opensesame/openid4vci";
import type { JsonObject } from "@opensesame/os-domain";
import {
  DurableMap,
  type SecurityMap,
  takeSecurityMap,
} from "./durable-map.js";

/** Read a value from either backing store; `await` flattens the sync `Map`. */
async function readSecurityMap<T>(
  store: SecurityMap<T>,
  key: string,
): Promise<T | undefined> {
  return store instanceof DurableMap ? store.get(key) : store.get(key);
}

/** Write a value to either backing store. */
async function writeSecurityMap<T>(
  store: SecurityMap<T>,
  key: string,
  value: T,
): Promise<void> {
  if (store instanceof DurableMap) await store.set(key, value);
  else store.set(key, value);
}

/** 256 bits, base64url. The same width the in-memory stores use. */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A pre-authorized grant plus the route-level binding the package deliberately
 * does not hold.
 *
 * The package's {@link PreAuthorizedGrant} is value-blind — it carries no
 * principal, because a credential authorizes nothing and the grant should not
 * either. But F10's protected-redemption promise has to be *checked* somewhere,
 * and the only place that knows who is at the token endpoint is the route. So
 * the binding rides here, beside the grant, never inside it.
 */
export interface StoredPreAuthorizedGrant {
  readonly grant: PreAuthorizedGrant;
  /** The principal the offer was minted for, when redemption is protected. */
  readonly boundPrincipalId?: string;
  /** Mirrors `grant.expiresAt` so `DurableMap` can set the row's TTL. */
  readonly expiresAt: Date;
}

/** What a durable redemption yields: the package's verdict plus the binding. */
export interface DurableRedeemedGrant {
  readonly redeemed: RedeemedGrant;
  readonly boundPrincipalId?: string;
}

/**
 * Durable pre-authorized code store.
 *
 * Not a drop-in `PreAuthorizedCodeStore`: its `redeem` returns the F10 binding
 * alongside {@link RedeemedGrant} so the token route can confirm the caller is
 * the principal the offer was bound to. The atomic spend is `takeSecurityMap`;
 * the verdict is the package's `redeemGrant`, so unknown, expired and
 * wrong-transaction-code stay one indistinguishable refusal.
 */
export class DurablePreAuthorizedCodeStore {
  constructor(private readonly store: SecurityMap<StoredPreAuthorizedGrant>) {}

  async register(
    grant: PreAuthorizedGrant,
    boundPrincipalId?: string,
  ): Promise<void> {
    const record: StoredPreAuthorizedGrant =
      boundPrincipalId === undefined
        ? { grant, expiresAt: grant.expiresAt }
        : { grant, boundPrincipalId, expiresAt: grant.expiresAt };
    await writeSecurityMap(this.store, grant.code, record);
  }

  async redeem(
    code: string,
    txCode: string | undefined,
    now: Date,
  ): Promise<DurableRedeemedGrant> {
    // Spend first: the grant is gone before any decision, so a wrong
    // Transaction Code burns the code rather than leaving it for a retry.
    const stored = await takeSecurityMap(this.store, code);
    if (stored === undefined) {
      // Unknown, expired (a live `DurableMap` filtered it) or already spent —
      // one refusal, no oracle. The same code `redeemGrant` raises for an
      // expired grant, so a missing one is byte-identical on the wire.
      throw new Openid4vciError("pre_authorized_code_rejected");
    }
    const redeemed = redeemGrant(stored.grant, txCode, now);
    return stored.boundPrincipalId === undefined
      ? { redeemed }
      : { redeemed, boundPrincipalId: stored.boundPrincipalId };
  }
}

/** The value a nonce row carries: only its expiry. */
interface NonceRecord {
  readonly expiresAt: Date;
}

/**
 * Durable, single-use `c_nonce` store.
 *
 * `issue` writes a random nonce with a TTL; `consume` spends it with an atomic
 * take. Unlike the in-memory store there is no tombstone — a durable set of
 * every spent nonce is an unbounded table with an attacker holding the pen —
 * so a replay and an expiry both surface as "not live". The package maps both
 * to `invalid_nonce` on the wire regardless, so no distinction is lost where a
 * wallet could see it.
 */
export class DurableNonceStore implements NonceStore {
  constructor(
    private readonly store: SecurityMap<NonceRecord>,
    private readonly ttlSeconds: number,
  ) {}

  async issue(now?: Date): Promise<IssuedNonce> {
    const at = now ?? new Date();
    const nonce = randomToken();
    const expiresAt = new Date(at.getTime() + this.ttlSeconds * 1000);
    await writeSecurityMap(this.store, nonce, { expiresAt });
    return { nonce, expiresAt };
  }

  async consume(nonce: string, now?: Date): Promise<void> {
    const at = now ?? new Date();
    const record = await takeSecurityMap(this.store, nonce);
    // `nonce_unknown` for both branches: the package maps it to `invalid_nonce`
    // and the wire cannot tell "never issued" from "already spent". Raising the
    // package's own error keeps `verifyProofOfPossession`'s failure surface one
    // type, so the route's `Openid4vciError` translation catches it.
    if (record === undefined) throw new Openid4vciError("nonce_unknown");
    if (record.expiresAt.getTime() <= at.getTime()) {
      throw new Openid4vciError("nonce_unknown");
    }
  }
}

/** What an access token stands for: one credential of one configuration. */
export interface AccessTokenRecord {
  readonly credentialConfigurationIds: readonly string[];
  readonly boundPrincipalId?: string;
  readonly expiresAt: Date;
}

/**
 * Durable, single-use issuance access token store.
 *
 * The token endpoint mints one; the credential endpoint spends it exactly
 * once. Single-use is the point: an access token that could be replayed would
 * mint a second credential for a key the wallet chose on the second call.
 */
export class DurableAccessTokenStore {
  constructor(private readonly store: SecurityMap<AccessTokenRecord>) {}

  async mint(record: AccessTokenRecord): Promise<string> {
    const token = `oid4vci_at_${randomToken()}`;
    await writeSecurityMap(this.store, token, record);
    return token;
  }

  /** Spend a token once, or return undefined for unknown/expired/spent. */
  async redeem(
    token: string,
    now: Date,
  ): Promise<AccessTokenRecord | undefined> {
    const record = await takeSecurityMap(this.store, token);
    if (record === undefined) return undefined;
    if (record.expiresAt.getTime() <= now.getTime()) return undefined;
    return record;
  }
}

/** The stored offer resource, plus its F10 binding. */
export interface StoredOffer {
  readonly offer: JsonObject;
  readonly requiresProtectedRedemption: boolean;
  readonly boundPrincipalId?: string;
  readonly expiresAt: Date;
}

/**
 * Durable offer-resource store.
 *
 * Keyed by a public, unguessable offer id (not a secret — the offer link
 * carries it in the clear by design), so no key hashing. The value is the
 * offer object served over TLS at the `credential_offer_uri`, and the binding
 * the fetch route enforces: a protected offer is returned only to the
 * principal it was minted for.
 */
export class DurableOfferStore {
  constructor(private readonly store: SecurityMap<StoredOffer>) {}

  async put(id: string, offer: StoredOffer): Promise<void> {
    await writeSecurityMap(this.store, id, offer);
  }

  async get(id: string): Promise<StoredOffer | undefined> {
    return readSecurityMap(this.store, id);
  }
}
