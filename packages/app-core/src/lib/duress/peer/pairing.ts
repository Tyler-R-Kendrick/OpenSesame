import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * Exact-origin / recipient-key pairing + operation-limited delegations (PEER-A).
 * Consent, rotation, revocation are explicit (INV-02, INV-13).
 */

import { PEER_BOUNDS } from "./bounds.js";
import { assertSafePeerOrigin } from "./origin.js";

export type PeerDelegation = Readonly<{
  operation: string;
  vaultRef: string;
  expiresAt: string;
}>;

export type PeerPairing = Readonly<{
  peerRef: string;
  origin: string;
  recipientPrincipalRef: string;
  recipientPublicKeyJwk: JsonWebKey;
  consentedAt: string;
  revokedAt: string | null;
  generation: number;
  delegations: readonly PeerDelegation[];
}>;

export class PeerPairingRegistry {
  #peers = new Map<string, PeerPairing>();

  pair(input: {
    peerRef: string;
    origin: string;
    recipientPrincipalRef: string;
    recipientPublicKeyJwk: JsonWebKey;
    consentedAt: string;
    delegations: readonly PeerDelegation[];
  }): PeerPairing {
    assertSafePeerOrigin(input.origin);
    if (this.#peers.size >= PEER_BOUNDS.peersMax) {
      throw new Error("unsupported_factor: peersMax");
    }
    if (this.#peers.has(input.peerRef)) {
      throw new Error("ambiguous_trigger: peer already paired");
    }
    if (
      "d" in overlapCast<JsonWebKey, object>(input.recipientPublicKeyJwk) &&
      input.recipientPublicKeyJwk.d
    ) {
      throw new Error("unsupported_factor: private key in pairing");
    }
    if (
      input.delegations.length === 0 ||
      input.delegations.length > PEER_BOUNDS.operationsMax
    ) {
      throw new Error("unsupported_factor: delegations");
    }
    for (const d of input.delegations) {
      if (!d.operation || d.operation === "*") {
        throw new Error("unsupported_factor: unbounded delegation");
      }
    }
    const rec: PeerPairing = {
      peerRef: input.peerRef,
      origin: assertSafePeerOrigin(input.origin).origin,
      recipientPrincipalRef: input.recipientPrincipalRef,
      recipientPublicKeyJwk: input.recipientPublicKeyJwk,
      consentedAt: input.consentedAt,
      revokedAt: null,
      generation: 1,
      delegations: [...input.delegations],
    };
    this.#peers.set(input.peerRef, rec);
    return rec;
  }

  rotate(
    peerRef: string,
    nextPublicKeyJwk: JsonWebKey,
    at: string,
  ): PeerPairing {
    const cur = this.#require(peerRef);
    if (cur.revokedAt) throw new Error("unavailable_authority: revoked");
    if (
      "d" in overlapCast<JsonWebKey, object>(nextPublicKeyJwk) &&
      nextPublicKeyJwk.d
    ) {
      throw new Error("unsupported_factor: private key in pairing");
    }
    const next: PeerPairing = {
      ...cur,
      recipientPublicKeyJwk: nextPublicKeyJwk,
      generation: cur.generation + 1,
      consentedAt: at,
    };
    this.#peers.set(peerRef, next);
    return next;
  }

  revoke(peerRef: string, at: string): PeerPairing {
    const cur = this.#require(peerRef);
    const next: PeerPairing = { ...cur, revokedAt: at, delegations: [] };
    this.#peers.set(peerRef, next);
    return next;
  }

  assertDelegation(
    peerRef: string,
    operation: string,
    vaultRef: string,
    now = Date.now(),
  ): PeerPairing {
    const peer = this.#require(peerRef);
    if (peer.revokedAt) throw new Error("unavailable_authority: revoked");
    const hit = peer.delegations.find(
      (d) =>
        d.operation === operation &&
        d.vaultRef === vaultRef &&
        Date.parse(d.expiresAt) >= now,
    );
    if (!hit) throw new Error("unavailable_authority: no live delegation");
    return peer;
  }

  get(peerRef: string): PeerPairing | undefined {
    return this.#peers.get(peerRef);
  }

  list(): readonly PeerPairing[] {
    return [...this.#peers.values()];
  }

  #require(peerRef: string): PeerPairing {
    const p = this.#peers.get(peerRef);
    if (!p) throw new Error("unavailable_authority: unknown peer");
    return p;
  }
}
