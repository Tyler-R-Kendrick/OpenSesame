import type { OAuthClientRecord } from "../types.js";

export interface ClientRecordStore {
  findById(id: string): Promise<OAuthClientRecord | undefined>;
  findByOrigin(canonicalOrigin: string): Promise<OAuthClientRecord | undefined>;
  /** Insert if absent; return existing on unique conflict. */
  insertAtomic(client: OAuthClientRecord): Promise<OAuthClientRecord>;
  touchLastUsed?(id: string, at: Date): Promise<void>;
  /** All clients owned by a principal (registration API listing + quota). */
  listByOwner(ownerPrincipalId: string): Promise<OAuthClientRecord[]>;
  /** All clients sharing a sector identifier (cross-owner claim fence). */
  findBySectorIdentifier(
    sectorIdentifier: string,
  ): Promise<OAuthClientRecord[]>;
  /** Full-record replace by `client.id`. */
  update(client: OAuthClientRecord): Promise<OAuthClientRecord>;
}

/**
 * In-memory client record store (tests / ephemeral). The durable Postgres
 * implementation lands with the migration slice (ADR 0050 R-C).
 */
export class MemoryClientRecordStore implements ClientRecordStore {
  private readonly byId = new Map<string, OAuthClientRecord>();
  private readonly byOrigin = new Map<string, string>();

  /**
   * Synchronously load initial records (e.g. static `clients` configuration).
   * Not part of the store interface — callers that only have the interface
   * use `insertAtomic`.
   */
  seed(clients: OAuthClientRecord[]): void {
    for (const client of clients) {
      if (this.byId.has(client.id)) continue;
      if (client.origin) {
        if (!this.byOrigin.has(client.origin)) {
          this.byOrigin.set(client.origin, client.id);
        }
      }
      this.byId.set(client.id, client);
    }
  }

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

  async listByOwner(ownerPrincipalId: string): Promise<OAuthClientRecord[]> {
    return [...this.byId.values()].filter(
      (client) => client.ownerPrincipalId === ownerPrincipalId,
    );
  }

  async findBySectorIdentifier(
    sectorIdentifier: string,
  ): Promise<OAuthClientRecord[]> {
    return [...this.byId.values()].filter(
      (client) => client.sectorIdentifier === sectorIdentifier,
    );
  }

  async update(client: OAuthClientRecord): Promise<OAuthClientRecord> {
    const existing = this.byId.get(client.id);
    if (!existing) {
      throw new Error(`Cannot update unknown OAuth client ${client.id}`);
    }
    if (existing.origin !== client.origin) {
      if (existing.origin && this.byOrigin.get(existing.origin) === client.id) {
        this.byOrigin.delete(existing.origin);
      }
      if (client.origin) this.byOrigin.set(client.origin, client.id);
    }
    this.byId.set(client.id, client);
    return client;
  }
}
