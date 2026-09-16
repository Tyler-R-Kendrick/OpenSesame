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

function readBoundary(err: unknown): BoundaryValue {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === "object" && current !== null) {
      if ("code" in current) {
        const code = Reflect.get(current, "code");
        if (typeof code === "string") return { code };
      }
      current = "cause" in current ? Reflect.get(current, "cause") : undefined;
      continue;
    }
    break;
  }
  return {};
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

export function createWalletRegistrationRegister(
  db: Database,
  resolveDb: ResolveDb,
): Pick<WalletRegistrationRepository, "register"> {
  return {
    register: async (registration, uow) => {
      try {
        const [row] = await resolveDb(uow)
          .insert(schema.walletRegistrations)
          .values({
            id: registration.id,
            provider: registration.provider,
            status: registration.status,
            subjectKind: registration.subjectKind,
            subjectId: registration.subjectId,
            providerObjectRef: registration.providerObjectRef,
            providerSubject: registration.providerSubject ?? null,
            interactionId: registration.interactionId ?? null,
            approverPrincipalId: registration.approverPrincipalId ?? null,
            passReferenceDigest: registration.passReferenceDigest ?? null,
            expiresAt: registration.expiresAt ?? null,
            revokedAt: registration.revokedAt ?? null,
            version: registration.version,
            createdAt: registration.createdAt,
            updatedAt: registration.updatedAt,
          })
          .returning();
        if (!row) throw new Error("insert wallet registration failed");
        return mapWalletRegistration(row);
      } catch (err) {
        const boundaryError = readBoundary(err);
        // The partial unique indexes reject a second live pass over one
        // ceremony subject or one provider object; both mean "already
        // registered", and the caller reads what is there rather than forking.
        if (isUniqueViolation(boundaryError)) {
          throw new ConflictError(
            `wallet registration conflict: ${registration.id}`,
          );
        }
        throw err;
      }
    },
  };
}
