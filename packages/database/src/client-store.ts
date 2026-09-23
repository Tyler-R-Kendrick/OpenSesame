import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { isUniqueViolation } from "./client-origin-store.js";
import {
  OAuthClientSectorClaimedError,
  type SectorKeyBlock,
  claimSectorKey,
  sectorKeyOf,
  sectorOwnerKey,
} from "./client-sector-claims.js";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

/**
 * OAuth client persistence — structural types matching `ClientRecordStore`
 * and `OAuthClientRecord` in `@opensesame/oauth-provider` (ADR 0050 slice 1).
 * This package must not import the issuer; the shapes below are assignment-
 * compatible with it.
 */
export type ClientAdmissionMode =
  | "pre_registered"
  | "dynamic_registration"
  | "client_metadata_document"
  | "origin_profile";
export type ClientState = "active" | "suspended" | "revoked";

export type OwnershipStatus = "unclaimed" | "claimed";

export interface OAuthClientRecord {
  id: string;
  admissionMode: ClientAdmissionMode;
  displayName: string;
  redirectUris: string[];
  sectorIdentifier: string;
  /** Stored `sector_key`; read-only — derived from `sectorIdentifier` on write. */
  sectorKey?: string;
  /** Set when this client may not mint a pairwise `sub` (migration 0029). */
  sectorKeyBlocked?: SectorKeyBlock;
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  allowedScopes: string[];
  allowedResources: string[];
  metadataUri?: string;
  metadataDigest?: string;
  jwks?: { keys: import("@opensesame/os-domain").JsonObject[] };
  state: ClientState;
  origin?: string;
  ownershipStatus?: OwnershipStatus;
  ownerPrincipalId?: string;
  firstSeenAt?: Date;
  lastUsedAt?: Date;
  claimedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

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
  /** Full-record replace by `client.id`. */
  update(client: OAuthClientRecord): Promise<OAuthClientRecord>;
}

type OAuthClientRow = typeof schema.oauthClients.$inferSelect;

function mapRow(row: OAuthClientRow): OAuthClientRecord {
  const record: OAuthClientRecord = {
    id: row.id,
    admissionMode: overlapCast(row.admissionMode),
    displayName: row.displayName,
    redirectUris: overlapCast(row.redirectUris ?? []),
    sectorIdentifier: row.sectorIdentifier,
    sectorKey: row.sectorKey,
    grantTypes: overlapCast(row.grantTypes ?? []),
    responseTypes: overlapCast(row.responseTypes ?? []),
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    allowedScopes: overlapCast(row.allowedScopes ?? []),
    allowedResources: overlapCast(row.allowedResources ?? []),
    state: overlapCast(row.state),
  };
  if (row.sectorKeyBlocked)
    record.sectorKeyBlocked = overlapCast(row.sectorKeyBlocked);
  if (row.metadataUri) record.metadataUri = row.metadataUri;
  if (row.metadataDigest) record.metadataDigest = row.metadataDigest;
  if (row.tokenEndpointJwks) record.jwks = overlapCast(row.tokenEndpointJwks);
  if (row.origin) record.origin = row.origin;
  if (row.ownershipStatus)
    record.ownershipStatus = overlapCast(row.ownershipStatus);
  if (row.ownerPrincipalId) record.ownerPrincipalId = row.ownerPrincipalId;
  if (row.firstSeenAt) record.firstSeenAt = row.firstSeenAt;
  if (row.lastUsedAt) record.lastUsedAt = row.lastUsedAt;
  if (row.claimedAt) record.claimedAt = row.claimedAt;
  if (row.createdAt) record.createdAt = row.createdAt;
  if (row.updatedAt) record.updatedAt = row.updatedAt;
  return record;
}

function insertValues(client: OAuthClientRecord, now: Date) {
  return {
    id: client.id,
    admissionMode: client.admissionMode,
    displayName: client.displayName,
    redirectUris: client.redirectUris,
    sectorIdentifier: client.sectorIdentifier,
    sectorKey: sectorKeyOf(client.sectorIdentifier),
    grantTypes: client.grantTypes,
    responseTypes: client.responseTypes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    allowedScopes: client.allowedScopes,
    allowedResources: client.allowedResources,
    metadataUri: client.metadataUri,
    metadataDigest: client.metadataDigest,
    tokenEndpointJwks: client.jwks ?? null,
    state: client.state,
    origin: client.origin ?? null,
    ownershipStatus: client.ownershipStatus ?? "unclaimed",
    ownerPrincipalId: client.ownerPrincipalId ?? null,
    firstSeenAt: client.firstSeenAt ?? now,
    lastUsedAt: client.lastUsedAt ?? now,
    claimedAt: client.claimedAt ?? null,
    createdAt: client.createdAt ?? now,
    updatedAt: client.updatedAt ?? now,
  };
}

function updateValues(client: OAuthClientRecord, now: Date) {
  // Full-record replace except id/firstSeen/createdAt; updatedAt is stamped.
  return {
    admissionMode: client.admissionMode,
    displayName: client.displayName,
    redirectUris: client.redirectUris,
    sectorIdentifier: client.sectorIdentifier,
    grantTypes: client.grantTypes,
    responseTypes: client.responseTypes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    allowedScopes: client.allowedScopes,
    allowedResources: client.allowedResources,
    metadataUri: client.metadataUri ?? null,
    metadataDigest: client.metadataDigest ?? null,
    tokenEndpointJwks: client.jwks ?? null,
    state: client.state,
    origin: client.origin ?? null,
    ownershipStatus: client.ownershipStatus ?? "unclaimed",
    ownerPrincipalId: client.ownerPrincipalId ?? null,
    lastUsedAt: client.lastUsedAt ?? now,
    claimedAt: client.claimedAt ?? null,
    updatedAt: now,
  };
}

/** Claim the row's sector key and insert it, in one transaction. */
function insertClaimed(
  db: Database,
  client: OAuthClientRecord,
): Promise<OAuthClientRecord> {
  const values = insertValues(client, new Date());
  return db.transaction(async (tx) => {
    await claimSectorKey(
      tx,
      values.sectorKey,
      sectorOwnerKey(client),
      client.id,
    );
    const [row] = await tx
      .insert(schema.oauthClients)
      .values(values)
      .returning();
    if (!row) {
      throw new Error("insert oauth client returned no row");
    }
    return mapRow(row);
  });
}

/**
 * Full-record replace. The stored key and block survive unless the sector
 * itself changes: a legacy row keeps the `sub` it has, and a blocked one stays
 * blocked. A row that stays live re-asserts its claim, so an ownership
 * transfer cannot carry a key onto a second owner.
 */
function updateClaimed(
  db: Database,
  client: OAuthClientRecord,
): Promise<OAuthClientRecord> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.id, client.id))
      .for("update");
    if (!current) {
      throw new Error(`Cannot update unknown OAuth client ${client.id}`);
    }
    const same = current.sectorIdentifier === client.sectorIdentifier;
    const sectorKey = same
      ? current.sectorKey
      : sectorKeyOf(client.sectorIdentifier);
    const sectorKeyBlocked = same ? current.sectorKeyBlocked : null;
    if (!sectorKeyBlocked && client.state !== "revoked") {
      await claimSectorKey(tx, sectorKey, sectorOwnerKey(client), client.id);
    }
    const [row] = await tx
      .update(schema.oauthClients)
      .set({ ...updateValues(client, new Date()), sectorKey, sectorKeyBlocked })
      .where(eq(schema.oauthClients.id, client.id))
      .returning();
    if (!row) {
      throw new Error(`Cannot update unknown OAuth client ${client.id}`);
    }
    return mapRow(row);
  });
}

/**
 * Postgres OAuth client store. `insertAtomic` resolves first-seen admission
 * races through the primary key and the partial unique index on `origin`:
 * the loser of a concurrent insert re-reads by id, then by origin, and
 * returns the winner's row. Every write holds the row's pairwise sector key
 * first (`claimSectorKey`); a key another owner holds answers
 * `OAuthClientSectorClaimedError` instead of a second owner on one `sub`.
 *
 * `owner_principal_id` is a FK to `principals`. Callers must persist the
 * owner principal before inserting an owned client.
 */
export function createPostgresClientRecordStore(
  db: Database,
): ClientRecordStore {
  const findById = async (id: string) => {
    const [row] = await db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.id, id))
      .limit(1);
    return row ? mapRow(row) : undefined;
  };

  const findByOrigin = async (canonicalOrigin: string) => {
    const [row] = await db
      .select()
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.origin, canonicalOrigin))
      .limit(1);
    return row ? mapRow(row) : undefined;
  };

  return {
    findById,
    findByOrigin,

    async insertAtomic(client) {
      try {
        return await insertClaimed(db, client);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (err instanceof OAuthClientSectorClaimedError) {
          const existing = await findById(client.id);
          if (existing) return existing;
          throw err;
        }
        if (!isUniqueViolation(boundaryError)) {
          throw err;
        }
        const existing =
          (await findById(client.id)) ??
          (client.origin ? await findByOrigin(client.origin) : undefined);
        if (existing) {
          return existing;
        }
        throw err;
      }
    },

    async touchLastUsed(id, at) {
      await db
        .update(schema.oauthClients)
        .set({ lastUsedAt: at, updatedAt: at })
        .where(eq(schema.oauthClients.id, id));
    },

    async listByOwner(ownerPrincipalId) {
      const rows = await db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.ownerPrincipalId, ownerPrincipalId));
      return rows.map(mapRow);
    },

    async findBySectorIdentifier(sectorIdentifier) {
      const rows = await db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.sectorIdentifier, sectorIdentifier));
      return rows.map(mapRow);
    },

    async findBySectorKey(sectorKey) {
      const rows = await db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.sectorKey, sectorKey));
      return rows.map(mapRow);
    },

    update: (client) => updateClaimed(db, client),
  };
}
