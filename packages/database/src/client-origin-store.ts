import {
  type BoundaryValue,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

/**
 * Application-claim (F5) persistence beside the OAuth client store: the
 * single-use claim challenges and the verified origin aliases a claimed
 * application carries. Split from `client-store.ts` (ADR 0093).
 */

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

type ClientClaimChallengeRow = typeof schema.clientClaimChallenges.$inferSelect;

export function isUniqueViolation(err: BoundaryValue): boolean {
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
