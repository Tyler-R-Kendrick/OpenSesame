import type { OAuthClientRecord } from "../types.js";

export interface ClientRecordStore {
  findById(id: string): Promise<OAuthClientRecord | undefined>;
  findByOrigin(canonicalOrigin: string): Promise<OAuthClientRecord | undefined>;
  /** Insert if absent; return existing on unique conflict. */
  insertAtomic(client: OAuthClientRecord): Promise<OAuthClientRecord>;
  touchLastUsed?(id: string, at: Date): Promise<void>;
}

/**
 * In-memory client record store (tests / ephemeral). The durable Postgres
 * implementation lands with the migration slice (ADR 0050 R-C).
 */
export class MemoryClientRecordStore implements ClientRecordStore {
  private readonly byId = new Map<string, OAuthClientRecord>();
  private readonly byOrigin = new Map<string, string>();

  async findById(id: string): Promise<OAuthClientRecord | undefined> {
    return this.byId.get(id);
  }

  async findByOrigin(
    canonicalOrigin: string,
  ): Promise<OAuthClientRecord | undefined> {
    const id = this.byOrigin.get(canonicalOrigin);
    return id ? this.byId.get(id) : undefined;
  }

  async insertAtomic(client: OAuthClientRecord): Promise<OAuthClientRecord> {
    // No awaits between check and set: run-to-completion makes the
    // check-then-insert atomic, simulating a unique-violation reload —
    // concurrent first-seen admissions resolve to a single winner.
    const existing = this.byId.get(client.id);
    if (existing) return existing;
    if (client.origin) {
      const byOriginId = this.byOrigin.get(client.origin);
      if (byOriginId) {
        const byOrigin = this.byId.get(byOriginId);
        if (byOrigin) return byOrigin;
      }
      this.byOrigin.set(client.origin, client.id);
    }
    this.byId.set(client.id, client);
    return client;
  }

  async touchLastUsed(id: string, at: Date): Promise<void> {
    const c = this.byId.get(id);
    if (!c) return;
    this.byId.set(id, { ...c, lastUsedAt: at });
  }
}
