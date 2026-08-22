import {
  type BoundaryValue,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { and, eq, gt, isNull } from "drizzle-orm";
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
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  allowedScopes: string[];
  allowedResources: string[];
  metadataUri?: string;
  metadataDigest?: string;
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
  /** Full-record replace by `client.id`. */
  update(client: OAuthClientRecord): Promise<OAuthClientRecord>;
}

export interface ClientClaimChallengeRecord {
  id: string;
  applicationId: string;
  ownerPrincipalId: string;
  challenge: string;
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
}

export interface ClientClaimChallengeStore {
  insert(
    challenge: Omit<ClientClaimChallengeRecord, "consumedAt" | "createdAt">,
  ): Promise<ClientClaimChallengeRecord>;
  findByChallenge(
    challenge: string,
  ): Promise<ClientClaimChallengeRecord | undefined>;
  /**
   * Single-consume: stamps `consumed_at` only when the challenge is
   * unconsumed and unexpired. Returns the stamped record, or `undefined`
   * when the challenge was already spent or has lapsed.
   */
  consume(
    challenge: string,
    at: Date,
  ): Promise<ClientClaimChallengeRecord | undefined>;
}

export type ClientOriginStatus = "active" | "revoked" | "pending";

export interface ClientOriginRecord {
  id: string;
  applicationId: string;
  canonicalOrigin: string;
  publicClientId: string;
  verificationMethod?: string;
  status: ClientOriginStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** The alias origin is already attached to a different application. */
export class ClientOriginConflictError extends Error {
  override readonly name = "ClientOriginConflictError";
  // biome-ignore lint/complexity/noUselessConstructor: Error needs the message passed to super.
  constructor(message: string) {
    super(message);
  }
}

export interface ClientOriginStore {
  /**
   * Attach a verified alias origin to an application. Re-attaching the same
   * origin to the same application is idempotent (returns the existing row);
   * an origin already attached to a *different* application is a conflict —
   * one origin must never fan out to two pairwise sectors.
   */
  insert(
    origin: Omit<ClientOriginRecord, "createdAt" | "updatedAt">,
  ): Promise<ClientOriginRecord>;
  findByOrigin(
    canonicalOrigin: string,
  ): Promise<ClientOriginRecord | undefined>;
  listByApplication(applicationId: string): Promise<ClientOriginRecord[]>;
}

type OAuthClientRow = typeof schema.oauthClients.$inferSelect;
type ClientClaimChallengeRow = typeof schema.clientClaimChallenges.$inferSelect;

function isUniqueViolation(err: BoundaryValue): boolean {
  // postgres.js puts `code` on the error itself; drizzle wraps driver
  // errors (notably PGlite's) in a DrizzleQueryError with a `cause`.
  if (!isTypeofObject(err) || err === null) return false;
  const code = overlapCast(err).code;
  if (code === "23505") return true;
  const cause = overlapCast(err).cause;
  return (
    isTypeofObject(cause) &&
    cause !== null &&
    overlapCast(cause).code === "23505"
  );
}

function mapRow(row: OAuthClientRow): OAuthClientRecord {
  const record: OAuthClientRecord = {
    id: row.id,
    admissionMode: overlapCast(row.admissionMode),
    displayName: row.displayName,
    redirectUris: overlapCast(row.redirectUris ?? []),
    sectorIdentifier: row.sectorIdentifier,
    grantTypes: overlapCast(row.grantTypes ?? []),
    responseTypes: overlapCast(row.responseTypes ?? []),
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    allowedScopes: overlapCast(row.allowedScopes ?? []),
    allowedResources: overlapCast(row.allowedResources ?? []),
    state: overlapCast(row.state),
  };
  if (row.metadataUri) record.metadataUri = row.metadataUri;
  if (row.metadataDigest) record.metadataDigest = row.metadataDigest;
  if (row.origin) record.origin = row.origin;
  if (row.ownershipStatus) {
    record.ownershipStatus = overlapCast(row.ownershipStatus);
  }
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
    grantTypes: client.grantTypes,
    responseTypes: client.responseTypes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    allowedScopes: client.allowedScopes,
    allowedResources: client.allowedResources,
    metadataUri: client.metadataUri,
    metadataDigest: client.metadataDigest,
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
  // Full-record replace except identity (id) and first sight; createdAt is
  // immutable, updatedAt is stamped by the write.
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
    state: client.state,
    origin: client.origin ?? null,
    ownershipStatus: client.ownershipStatus ?? "unclaimed",
    ownerPrincipalId: client.ownerPrincipalId ?? null,
    lastUsedAt: client.lastUsedAt ?? now,
    claimedAt: client.claimedAt ?? null,
    updatedAt: now,
  };
}

/**
 * Postgres OAuth client store. `insertAtomic` resolves first-seen admission
 * races through the primary key and the partial unique index on `origin`:
 * the loser of a concurrent insert re-reads by id, then by origin, and
 * returns the winner's row.
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
      const now = new Date();
      try {
        const [row] = await db
          .insert(schema.oauthClients)
          .values(insertValues(client, now))
          .returning();
        if (!row) {
          throw new Error("insert oauth client returned no row");
        }
        return mapRow(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
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

    async update(client) {
      const now = new Date();
      const [row] = await db
        .update(schema.oauthClients)
        .set(updateValues(client, now))
        .where(eq(schema.oauthClients.id, client.id))
        .returning();
      if (!row) {
        throw new Error(`Cannot update unknown OAuth client ${client.id}`);
      }
      return mapRow(row);
    },
  };
}

function mapChallengeRow(
  row: ClientClaimChallengeRow,
): ClientClaimChallengeRecord {
  const record: ClientClaimChallengeRecord = {
    id: row.id,
    applicationId: row.applicationId,
    ownerPrincipalId: row.ownerPrincipalId,
    challenge: row.challenge,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
  if (row.consumedAt) record.consumedAt = row.consumedAt;
  return record;
}

/**
 * Postgres claim-challenge store (F5 well-known claim document). The
 * conditional update in `consume` is what makes a challenge single-use:
 * two concurrent verifiers race one `UPDATE`, and only the one that lands
 * the stamp gets a row back.
 */
export function createPostgresClientClaimChallengeStore(
  db: Database,
): ClientClaimChallengeStore {
  return {
    async insert(challenge) {
      const [row] = await db
        .insert(schema.clientClaimChallenges)
        .values(challenge)
        .returning();
      if (!row) {
        throw new Error("insert client claim challenge returned no row");
      }
      return mapChallengeRow(row);
    },

    async findByChallenge(challenge) {
      const [row] = await db
        .select()
        .from(schema.clientClaimChallenges)
        .where(eq(schema.clientClaimChallenges.challenge, challenge))
        .limit(1);
      return row ? mapChallengeRow(row) : undefined;
    },

    async consume(challenge, at) {
      const [row] = await db
        .update(schema.clientClaimChallenges)
        .set({ consumedAt: at, updatedAt: at })
        .where(
          and(
            eq(schema.clientClaimChallenges.challenge, challenge),
            isNull(schema.clientClaimChallenges.consumedAt),
            gt(schema.clientClaimChallenges.expiresAt, at),
          ),
        )
        .returning();
      return row ? mapChallengeRow(row) : undefined;
    },
  };
}

type ClientOriginRow = typeof schema.clientOrigins.$inferSelect;

function mapOriginRow(row: ClientOriginRow): ClientOriginRecord {
  const record: ClientOriginRecord = {
    id: row.id,
    applicationId: row.applicationId,
    canonicalOrigin: row.canonicalOrigin,
    publicClientId: row.publicClientId,
    status: overlapCast(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.verificationMethod) {
    record.verificationMethod = row.verificationMethod;
  }
  return record;
}

/**
 * Postgres verified-origin-alias store (F5 `client_origins`). Alias attach is
 * idempotent per application and conflicting across applications; the unique
 * index on `canonical_origin` decides races, and the loser is judged by who
 * the persisted row points to.
 */
export function createPostgresClientOriginStore(
  db: Database,
): ClientOriginStore {
  const findByOrigin = async (canonicalOrigin: string) => {
    const [row] = await db
      .select()
      .from(schema.clientOrigins)
      .where(eq(schema.clientOrigins.canonicalOrigin, canonicalOrigin))
      .limit(1);
    return row ? mapOriginRow(row) : undefined;
  };

  return {
    findByOrigin,

    async insert(origin) {
      const now = new Date();
      try {
        const [row] = await db
          .insert(schema.clientOrigins)
          .values({
            id: origin.id,
            applicationId: origin.applicationId,
            canonicalOrigin: origin.canonicalOrigin,
            publicClientId: origin.publicClientId,
            verificationMethod: origin.verificationMethod ?? null,
            status: origin.status,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) {
          throw new Error("insert client origin returned no row");
        }
        return mapOriginRow(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (!isUniqueViolation(boundaryError)) {
          throw err;
        }
        const existing = await findByOrigin(origin.canonicalOrigin);
        if (existing && existing.applicationId === origin.applicationId) {
          return existing;
        }
        throw new ClientOriginConflictError(
          `Origin ${origin.canonicalOrigin} is already attached to another application`,
        );
      }
    },

    async listByApplication(applicationId) {
      const rows = await db
        .select()
        .from(schema.clientOrigins)
        .where(eq(schema.clientOrigins.applicationId, applicationId));
      return rows.map(mapOriginRow);
    },
  };
}

/**
 * In-memory claim-challenge store — tests/dev counterpart of the Postgres
 * store above. `consume` keeps the same single-use contract: no awaits
 * between the check and the stamp, so run-to-completion makes it atomic.
 */
export function createMemoryClientClaimChallengeStore(): ClientClaimChallengeStore {
  const byChallenge = new Map<string, ClientClaimChallengeRecord>();
  return {
    async insert(challenge) {
      const record: ClientClaimChallengeRecord = {
        ...challenge,
        createdAt: new Date(),
      };
      byChallenge.set(record.challenge, record);
      return record;
    },
    async findByChallenge(challenge) {
      return byChallenge.get(challenge);
    },
    async consume(challenge, at) {
      const record = byChallenge.get(challenge);
      if (!record || record.consumedAt || record.expiresAt <= at) {
        return undefined;
      }
      record.consumedAt = at;
      return record;
    },
  };
}

/** In-memory verified-origin-alias store (tests/dev). */
export function createMemoryClientOriginStore(): ClientOriginStore {
  const byOrigin = new Map<string, ClientOriginRecord>();
  return {
    async insert(origin) {
      const existing = byOrigin.get(origin.canonicalOrigin);
      if (existing) {
        if (existing.applicationId === origin.applicationId) {
          return existing;
        }
        throw new ClientOriginConflictError(
          `Origin ${origin.canonicalOrigin} is already attached to another application`,
        );
      }
      const now = new Date();
      const record: ClientOriginRecord = {
        ...origin,
        createdAt: now,
        updatedAt: now,
      };
      byOrigin.set(record.canonicalOrigin, record);
      return record;
    },
    async findByOrigin(canonicalOrigin) {
      return byOrigin.get(canonicalOrigin);
    },
    async listByApplication(applicationId) {
      return [...byOrigin.values()].filter(
        (record) => record.applicationId === applicationId,
      );
    },
  };
}
