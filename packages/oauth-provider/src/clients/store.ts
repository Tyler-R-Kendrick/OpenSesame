import { pairwiseSectorKey } from "../pairwise/sector.js";
import type { OAuthClientRecord, SectorKeyRelease } from "../types.js";

/** How a row joins its sector key (`insertAtomic`). */
export interface InsertOptions {
  /** The client this row succeeds (rotation). */
  successorOf?: string | undefined;
}

export interface ClientRecordStore {
  findById(id: string): Promise<OAuthClientRecord | undefined>;
  findByOrigin(canonicalOrigin: string): Promise<OAuthClientRecord | undefined>;
  /**
   * Insert if absent; return existing on unique conflict. `successorOf`
   * marks a rotation: the row may only join a key its owner still holds,
   * beside a live, unblocked predecessor.
   */
  insertAtomic(
    client: OAuthClientRecord,
    options?: InsertOptions,
  ): Promise<OAuthClientRecord>;
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
   * pairwise subjects are fresh. The key is left open, or held for
   * `nextOwnerKey` when given. `undefined` when nobody holds it.
   */
  releaseSectorKey(
    sectorKey: string,
    nextOwnerKey?: string,
  ): Promise<SectorKeyRelease | undefined>;
}

/**
 * Another owner holds this sector key: the memory twin of the database's
 * `OAuthClientSectorClaimedError` (409 `sector_identifier_taken`).
 */
export class SectorKeyClaimedError extends Error {
  override readonly name = "SectorKeyClaimedError";
  readonly code = "sector_identifier_taken" as const;
  constructor(readonly sectorKey: string) {
    super("another owner already holds a client under this sector key");
  }
}

const keyOf = (client: OAuthClientRecord): string =>
  client.sectorKey ?? pairwiseSectorKey(client.sectorIdentifier);

const ownerKeyOf = (client: OAuthClientRecord): string =>
  client.ownerPrincipalId ?? `client:${client.id}`;

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
  /** Sector key -> holder (`null` once released and not yet re-taken). */
  private readonly claims = new Map<string, string | null>();

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

  async insertAtomic(
    client: OAuthClientRecord,
    options?: InsertOptions,
  ): Promise<OAuthClientRecord> {
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
    }
    if (options?.successorOf) {
      this.assertSuccessor(client, options.successorOf);
    } else {
      this.claim(keyOf(client), ownerKeyOf(client), client.id);
    }
    if (client.origin) this.byOrigin.set(client.origin, client.id);
    const admitted = this.withGeneration(client);
    this.byId.set(client.id, admitted);
    return admitted;
  }

  /**
   * A rotation successor joins only a key its owner still holds, beside a
   * predecessor that is on it and unblocked — so a release that lands after
   * the route's pre-check still refuses it.
   */
  private assertSuccessor(client: OAuthClientRecord, predecessorId: string) {
    const key = keyOf(client);
    const owner = ownerKeyOf(client);
    const predecessor = this.byId.get(predecessorId);
    if (
      this.holderOf(key) !== owner ||
      !predecessor ||
      keyOf(predecessor) !== key ||
      ownerKeyOf(predecessor) !== owner ||
      predecessor.sectorKeyBlocked
    ) {
      throw new SectorKeyClaimedError(key);
    }
  }

  /** Who holds `key`: the claim, else the first unblocked client on it. */
  private holderOf(key: string): string | null | undefined {
    if (this.claims.has(key)) return this.claims.get(key);
    const first = [...this.byId.values()].find(
      (client) => keyOf(client) === key && !client.sectorKeyBlocked,
    );
    return first ? ownerKeyOf(first) : undefined;
  }

  /**
   * The Postgres claim rule, synchronously: an open or own key is taken; a
   * key another owner holds passes only as a lone client moving owner (the
   * client is already on it and its holder has no other client there).
   */
  private claim(key: string, owner: string, clientId: string): void {
    const holder = this.holderOf(key);
    if (holder && holder !== owner) {
      const onKey = [...this.byId.values()].filter((c) => keyOf(c) === key);
      const self = onKey.some((c) => c.id === clientId);
      const other = onKey.some(
        (c) => c.id !== clientId && ownerKeyOf(c) === holder,
      );
      if (!self || other) throw new SectorKeyClaimedError(key);
    }
    this.claims.set(key, owner);
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
    const same = existing.sectorIdentifier === client.sectorIdentifier;
    if ((!same || !existing.sectorKeyBlocked) && client.state !== "revoked") {
      this.claim(keyOf(rest), ownerKeyOf(rest), client.id);
    }
    const stored: OAuthClientRecord =
      existing.sectorIdentifier === client.sectorIdentifier
        ? { ...rest, ...sectorFields(existing) }
        : this.withGeneration(rest);
    this.byId.set(client.id, stored);
    return stored;
  }

  async releaseSectorKey(
    sectorKey: string,
    nextOwnerKey?: string,
  ): Promise<SectorKeyRelease | undefined> {
    const holder = this.holderOf(sectorKey);
    if (!holder) return undefined;
    const live = [...this.byId.values()].filter(
      (client) => keyOf(client) === sectorKey && !client.sectorKeyBlocked,
    );
    const generation = (this.generations.get(sectorKey) ?? 0) + 1;
    this.generations.set(sectorKey, generation);
    this.claims.set(sectorKey, nextOwnerKey ?? null);
    for (const client of live) {
      this.byId.set(client.id, {
        ...client,
        sectorKeyBlocked: "sector_released",
      });
    }
    return {
      sectorKey,
      previousOwnerKey: holder,
      generation,
      nextOwnerKey: nextOwnerKey ?? null,
      blockedClientIds: live.map((client) => client.id),
    };
  }
}
