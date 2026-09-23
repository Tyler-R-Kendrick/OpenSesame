import { randomBytes } from "node:crypto";
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import type { PairwiseSubject, PairwiseSubjectStore } from "../types.js";
import { pairwiseSectorKey } from "./sector.js";

/**
 * In-memory pairwise subject mapping (tests / ephemeral).
 * Persisted random mapping — rotating a secret cannot rewrite all subjects.
 */
export class MemoryPairwiseSubjectStore implements PairwiseSubjectStore {
  private readonly map = new Map<string, PairwiseSubject>();

  private key(principalId: string, sectorIdentifier: string): string {
    return `${sectorIdentifier}\0${principalId}`;
  }

  async find(
    principalId: string,
    sectorIdentifier: string,
  ): Promise<PairwiseSubject | undefined> {
    return this.map.get(this.key(principalId, sectorIdentifier));
  }

  async getOrCreate(
    principalId: string,
    sectorIdentifier: string,
  ): Promise<PairwiseSubject> {
    // Do not `await this.find()` here: that yields and two callers can both
    // observe a miss, mint different `sub` values, and last-write-wins.
    const key = this.key(principalId, sectorIdentifier);
    const existing = this.map.get(key);
    if (existing) return existing;
    const subject: PairwiseSubject = {
      principalId,
      sectorIdentifier,
      subject: randomBytes(32).toString("base64url"),
      createdAt: new Date(),
    };
    this.map.set(key, subject);
    return subject;
  }
}

/** The one client-store lookup the pairwise callback needs. */
export type PairwiseClientLookup = {
  findById(id: string): Promise<{ sectorIdentifier?: string } | undefined>;
};

/**
 * Build oidc-provider `pairwiseIdentifier` callback from a PairwiseSubjectStore.
 *
 * The sector is the OpenSesame client record's registered `sectorIdentifier`
 * (via `clients`), because that is the value ownership is checked against.
 * oidc-provider's own `client.sectorIdentifier` — the host of
 * `redirect_uris[0]` when no `sector_identifier_uri` is set — is only the
 * fallback for clients the record store does not hold (static configuration),
 * then `clientId`. See `pairwise/sector.ts` for how a sector becomes a key.
 */
export function createPairwiseIdentifierCallback(
  store: PairwiseSubjectStore,
  clients?: PairwiseClientLookup,
) {
  return async (
    _ctx: BoundaryValue,
    accountId: string,
    client: { clientId?: string; sectorIdentifier?: string },
  ): Promise<string> => {
    const clientId = isString(client.clientId) ? client.clientId.trim() : "";
    const record =
      clients && clientId ? await clients.findById(clientId) : undefined;
    const declared = record?.sectorIdentifier;
    const registered = isString(declared) ? pairwiseSectorKey(declared) : "";
    const sector =
      registered ||
      (isString(client.sectorIdentifier) && client.sectorIdentifier.trim()) ||
      clientId;
    if (!sector) {
      throw new Error(
        "pairwiseIdentifier: client must supply sectorIdentifier or clientId (refusing a shared default sector)",
      );
    }
    const mapping = await store.getOrCreate(accountId, sector);
    return mapping.subject;
  };
}
