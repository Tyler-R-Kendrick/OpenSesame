import { randomBytes } from "node:crypto";
import type { PairwiseSubject, PairwiseSubjectStore } from "../types.js";
import { type BoundaryValue, isString } from "@opensesame/os-domain";

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

/**
 * Build oidc-provider `pairwiseIdentifier` callback from a PairwiseSubjectStore.
 * Sector comes from client.sectorIdentifier (OIDC pairwise); falls back to clientId.
 */
export function createPairwiseIdentifierCallback(store: PairwiseSubjectStore) {
  return async (
    _ctx: BoundaryValue,
    accountId: string,
    client: { clientId?: string; sectorIdentifier?: string },
  ): Promise<string> => {
    const sector =
      (isString(client.sectorIdentifier) &&
        client.sectorIdentifier.trim()) ||
      (isString(client.clientId) && client.clientId.trim()) ||
      "";
    if (!sector) {
      throw new Error(
        "pairwiseIdentifier: client must supply sectorIdentifier or clientId (refusing a shared default sector)",
      );
    }
    const mapping = await store.getOrCreate(accountId, sector);
    return mapping.subject;
  };
}
