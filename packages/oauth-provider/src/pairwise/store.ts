import { randomBytes } from "node:crypto";
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { errors } from "oidc-provider";
import type { PairwiseSubject, PairwiseSubjectStore } from "../types.js";
import { pairwiseSectorKey, pairwiseSubjectSector } from "./sector.js";

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
  findById(id: string): Promise<
    | {
        sectorIdentifier?: string;
        sectorKey?: string;
        sectorKeyBlocked?: string;
        sectorGeneration?: number;
      }
    | undefined
  >;
};

/** The sector a stored record's subjects live under, or "" when it has none. */
function registeredSectorKey(record: {
  sectorIdentifier?: string;
  sectorKey?: string;
  sectorGeneration?: number;
}): string {
  const declared = record.sectorIdentifier;
  const key =
    isString(record.sectorKey) && record.sectorKey
      ? record.sectorKey
      : isString(declared)
        ? pairwiseSectorKey(declared)
        : "";
  return key ? pairwiseSubjectSector(key, record.sectorGeneration ?? 0) : "";
}

/**
 * Build oidc-provider `pairwiseIdentifier` callback from a PairwiseSubjectStore.
 *
 * The sector is the OpenSesame client record's registered `sectorIdentifier`
 * (via `clients`), because that is the value ownership is checked against.
 * oidc-provider's own `client.sectorIdentifier` — the host of
 * `redirect_uris[0]` when no `sector_identifier_uri` is set — is only the
 * fallback for clients the record store does not hold (static configuration),
 * then `clientId`. See `pairwise/sector.ts` for how a sector becomes a key;
 * a durable store's `sectorKey` is that key as stored, and is what its
 * cross-owner claim holds, so it is preferred over re-deriving it.
 *
 * A record marked `sectorKeyBlocked` (a legacy row on a key another owner
 * holds, one whose spelling could not be keyed exactly, or one an operator
 * released the key from) gets no subject at all: issuing one would hand it
 * another owner's `sub`. A record's `sectorGeneration` is mixed into the
 * sector (`pairwiseSubjectSector`), so the holder after a release starts from
 * fresh subjects.
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
    if (record?.sectorKeyBlocked) {
      throw new errors.InvalidClient(
        "client must re-register: its sector identifier is held by another owner or could not be keyed exactly",
      );
    }
    const registered = record ? registeredSectorKey(record) : "";
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
