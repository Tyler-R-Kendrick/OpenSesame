import { pairwiseSectorKey } from "../pairwise/sector.js";
import type { OAuthClientRecord, SectorKeyRelease } from "../types.js";

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
  /** All clients on a pairwise sector key, whatever spelling they registered. */
  findBySectorKey(sectorKey: string): Promise<OAuthClientRecord[]>;
  /**
   * Full-record replace by `client.id`. A row's sector block and generation
   * are the store's: they survive a replace that keeps the sector.
   */
  update(client: OAuthClientRecord): Promise<OAuthClientRecord>;
  /**
   * Operator release of a held sector key: block every client on it
   * `sector_released` and bump the key's generation, so the next holder's
   * pairwise subjects are fresh. `undefined` when no live client holds it.
   */
  releaseSectorKey(sectorKey: string): Promise<SectorKeyRelease | undefined>;
}

const keyOf = (client: OAuthClientRecord): string =>
  client.sectorKey ?? pairwiseSectorKey(client.sectorIdentifier);

/** The sector fields a store owns, as a stored record carries them. */
function sectorFields(
  record: OAuthClientRecord,
): Pick<
  OAuthClientRecord,
  "sectorKey" | "sectorKeyBlocked" | "sectorGeneration"
> {
  const kept: Pick<
    OAuthClientRecord,
    "sectorKey" | "sectorKeyBlocked" | "sectorGeneration"
  > = {};
  if (record.sectorKey !== undefined) kept.sectorKey = record.sectorKey;
  if (record.sectorKeyBlocked) kept.sectorKeyBlocked = record.sectorKeyBlocked;
  if (record.sectorGeneration !== undefined)
    kept.sectorGeneration = record.sectorGeneration;
  return kept;
}

/**
 * In-memory client record store (tests / ephemeral). The durable Postgres
 * implementation lands with the migration slice (ADR 0050 R-C).
 */
export class MemoryClientRecordStore implements ClientRecordStore {
  private readonly byId = new Map<string, OAuthClientRecord>();
  private readonly byOrigin = new Map<string, string>();
  /** Sector key -> claim generation (bumped by `releaseSectorKey`). */
  private readonly generations = new Map<string, number>();

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
    const admitted = this.withGeneration(client);
    this.byId.set(client.id, admitted);
    return admitted;
  }

  /** A record admitted onto its key now: the key's current generation. */
  private withGeneration(client: OAuthClientRecord): OAuthClientRecord {
    const generation = this.generations.get(keyOf(client)) ?? 0;
    return generation > 0
      ? { ...client, sectorGeneration: generation }
      : client;
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

  async findBySectorKey(sectorKey: string): Promise<OAuthClientRecord[]> {
    return [...this.byId.values()].filter(
      (client) => keyOf(client) === sectorKey,
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
    const { sectorKey, sectorKeyBlocked, sectorGeneration, ...rest } = client;
    const stored: OAuthClientRecord =
      existing.sectorIdentifier === client.sectorIdentifier
        ? { ...rest, ...sectorFields(existing) }
        : this.withGeneration(rest);
    this.byId.set(client.id, stored);
    return stored;
  }

  async releaseSectorKey(
    sectorKey: string,
  ): Promise<SectorKeyRelease | undefined> {
    const live = [...this.byId.values()].filter(
      (client) => keyOf(client) === sectorKey && !client.sectorKeyBlocked,
    );
    const holder = live[0];
    if (!holder) return undefined;
    const generation = (this.generations.get(sectorKey) ?? 0) + 1;
    this.generations.set(sectorKey, generation);
    for (const client of live) {
      this.byId.set(client.id, {
        ...client,
        sectorKeyBlocked: "sector_released",
      });
    }
    return {
      sectorKey,
      previousOwnerKey: holder.ownerPrincipalId ?? `client:${holder.id}`,
      generation,
      blockedClientIds: live.map((client) => client.id),
    };
  }
}
