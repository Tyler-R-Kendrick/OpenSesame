import { randomBytes } from "node:crypto";
import type { PairwiseSubject, PairwiseSubjectStore } from "../types.js";

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
    const existing = await this.find(principalId, sectorIdentifier);
    if (existing) return existing;
    const subject: PairwiseSubject = {
      principalId,
      sectorIdentifier,
      subject: randomBytes(32).toString("base64url"),
      createdAt: new Date(),
    };
    this.map.set(this.key(principalId, sectorIdentifier), subject);
    return subject;
  }
}

/**
 * Build oidc-provider `pairwiseIdentifier` callback from a PairwiseSubjectStore.
 * Sector comes from client.sectorIdentifier (OIDC pairwise); falls back to clientId.
 */
export function createPairwiseIdentifierCallback(store: PairwiseSubjectStore) {
  return async (
    _ctx: unknown,
    accountId: string,
    client: { clientId?: string; sectorIdentifier?: string },
  ): Promise<string> => {
    const sector =
      (typeof client.sectorIdentifier === "string" && client.sectorIdentifier) ||
      client.clientId ||
      "default";
    const mapping = await store.getOrCreate(accountId, sector);
    return mapping.subject;
  };
}
