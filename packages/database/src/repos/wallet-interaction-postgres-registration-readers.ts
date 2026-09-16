/**
 * Postgres wallet-registration repository (ADR 0086).
 */

import { and, desc, eq, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as coreSchema from "../schema/index.js";
import * as walletSchema from "../schema/wallet-interactions.js";
import { ConflictError, NotFoundError, type UnitOfWork } from "./interfaces.js";
import type {
  WalletRegistration,
  WalletRegistrationRepository,
} from "./wallet-interaction-types.js";

const schema = { ...coreSchema, ...walletSchema };
type Database = PostgresJsDatabase<typeof coreSchema>;
type ResolveDb = (uow?: UnitOfWork) => Database;
type BoundaryValue = { code?: string };

function overlapCast<T>(value: string): T {
  // SAFETY: column checks constrain these closed enums at write time.
  return value as T;
}

function isUniqueViolation(err: BoundaryValue): boolean {
  return err.code === "23505";
}

function mapWalletRegistration(
  row: typeof schema.walletRegistrations.$inferSelect,
): WalletRegistration {
  const mapped: WalletRegistration = {
    id: row.id,
    provider: row.provider,
    status: overlapCast(row.status),
    subjectKind: overlapCast(row.subjectKind),
    subjectId: row.subjectId,
    providerObjectRef: row.providerObjectRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
  if (row.providerSubject !== null) {
    mapped.providerSubject = row.providerSubject;
  }
  if (row.interactionId !== null) mapped.interactionId = row.interactionId;
  if (row.approverPrincipalId !== null) {
    mapped.approverPrincipalId = row.approverPrincipalId;
  }
  if (row.passReferenceDigest !== null) {
    mapped.passReferenceDigest = row.passReferenceDigest;
  }
  if (row.expiresAt !== null) mapped.expiresAt = row.expiresAt;
  if (row.revokedAt !== null) mapped.revokedAt = row.revokedAt;
  return mapped;
}

export function createWalletRegistrationReaders(
  db: Database,
): Pick<
  WalletRegistrationRepository,
  | "getById"
  | "findActiveBySubject"
  | "findActiveByObjectRef"
  | "listForApprover"
> {
  return {
    getById: async (id) => {
      const [row] = await db
        .select()
        .from(schema.walletRegistrations)
        .where(eq(schema.walletRegistrations.id, id))
        .limit(1);
      return row ? mapWalletRegistration(row) : null;
    },
    findActiveBySubject: async (provider, subjectKind, subjectId) => {
      const [row] = await db
        .select()
        .from(schema.walletRegistrations)
        .where(
          and(
            eq(schema.walletRegistrations.provider, provider),
            eq(schema.walletRegistrations.subjectKind, subjectKind),
            eq(schema.walletRegistrations.subjectId, subjectId),
            eq(schema.walletRegistrations.status, "active"),
          ),
        )
        .limit(1);
      return row ? mapWalletRegistration(row) : null;
    },
    findActiveByObjectRef: async (provider, providerObjectRef) => {
      const [row] = await db
        .select()
        .from(schema.walletRegistrations)
        .where(
          and(
            eq(schema.walletRegistrations.provider, provider),
            eq(schema.walletRegistrations.providerObjectRef, providerObjectRef),
            eq(schema.walletRegistrations.status, "active"),
          ),
        )
        .limit(1);
      return row ? mapWalletRegistration(row) : null;
    },
    listForApprover: async (principalId) => {
      const rows = await db
        .select()
        .from(schema.walletRegistrations)
        .where(eq(schema.walletRegistrations.approverPrincipalId, principalId))
        .orderBy(desc(schema.walletRegistrations.createdAt));
      return rows.map(mapWalletRegistration);
    },
  };
}
