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
}

export interface ClientRecordStore {
  findById(id: string): Promise<OAuthClientRecord | undefined>;
  findByOrigin(canonicalOrigin: string): Promise<OAuthClientRecord | undefined>;
  /** Insert if absent; return existing on unique conflict. */
  insertAtomic(client: OAuthClientRecord): Promise<OAuthClientRecord>;
  touchLastUsed?(id: string, at: Date): Promise<void>;
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

type OAuthClientRow = typeof schema.oauthClients.$inferSelect;
type ClientClaimChallengeRow = typeof schema.clientClaimChallenges.$inferSelect;

function isUniqueViolation(err: unknown): boolean {
  // postgres.js puts `code` on the error itself; drizzle wraps driver
  // errors (notably PGlite's) in a DrizzleQueryError with a `cause`.
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  if (code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: string }).code === "23505"
  );
}

function mapRow(row: OAuthClientRow): OAuthClientRecord {
  const record: OAuthClientRecord = {
    id: row.id,
    admissionMode: row.admissionMode as ClientAdmissionMode,
    displayName: row.displayName,
    redirectUris: (row.redirectUris ?? []) as string[],
    sectorIdentifier: row.sectorIdentifier,
    grantTypes: (row.grantTypes ?? []) as string[],
    responseTypes: (row.responseTypes ?? []) as string[],
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    allowedScopes: (row.allowedScopes ?? []) as string[],
    allowedResources: (row.allowedResources ?? []) as string[],
    state: row.state as ClientState,
  };
  if (row.metadataUri) record.metadataUri = row.metadataUri;
  if (row.metadataDigest) record.metadataDigest = row.metadataDigest;
  if (row.origin) record.origin = row.origin;
  if (row.ownershipStatus) {
    record.ownershipStatus = row.ownershipStatus as OwnershipStatus;
  }
  if (row.ownerPrincipalId) record.ownerPrincipalId = row.ownerPrincipalId;
  if (row.firstSeenAt) record.firstSeenAt = row.firstSeenAt;
  if (row.lastUsedAt) record.lastUsedAt = row.lastUsedAt;
  if (row.claimedAt) record.claimedAt = row.claimedAt;
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
    createdAt: now,
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
        if (!isUniqueViolation(err)) {
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
