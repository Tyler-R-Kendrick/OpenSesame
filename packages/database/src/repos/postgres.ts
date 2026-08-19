import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuthorizationRequest,
  BetterAuthSubject,
  ClaimItem,
  ClaimSession,
  ExternalIdentity,
  OutboxEvent,
  Principal,
} from "@opensesame/os-domain";
import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import * as schema from "../schema/index.js";
import {
  type AuditEventRepository,
  type AuthorizationRequestRepository,
  type BetterAuthSubjectRepository,
  type ClaimItemRepository,
  type ClaimSessionRepository,
  ConflictError,
  type ExternalIdentityRepository,
  type NewOutboxEvent,
  NotFoundError,
  OUTBOX_CLAIM_HOLD_MS,
  type OutboxRepository,
  type PrincipalRepository,
  type Repositories,
  type TransactionFn,
  type UnitOfWork,
  outboxClaimToken,
  outboxHoldActive,
} from "./interfaces.js";

export type Database = PostgresJsDatabase<typeof schema>;

type TxDb = Database;

function normalizeTenant(tenant?: string | null): string {
  return tenant ?? "";
}

function mapAuditEvent(
  row: typeof schema.auditEvents.$inferSelect,
): AuditEvent {
  const mapped: AuditEvent = {
    id: row.id,
    occurredAt: row.occurredAt,
    eventType: row.eventType,
    outcome: row.outcome as AuditEvent["outcome"],
    correlationId: row.correlationId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
  if (row.principalId) mapped.principalId = row.principalId;
  if (row.actorType) {
    mapped.actorType = row.actorType as NonNullable<AuditEvent["actorType"]>;
  }
  if (row.actorId) mapped.actorId = row.actorId;
  if (row.agentInstanceId) mapped.agentInstanceId = row.agentInstanceId;
  if (row.clientId) mapped.clientId = row.clientId;
  if (row.organizationId) mapped.organizationId = row.organizationId;
  if (row.projectId) mapped.projectId = row.projectId;
  if (row.claimId) mapped.claimId = row.claimId;
  if (row.sessionId) mapped.sessionId = row.sessionId;
  if (row.targetType) mapped.targetType = row.targetType;
  if (row.targetId) mapped.targetId = row.targetId;
  if (row.causationId) mapped.causationId = row.causationId;
  if (row.previousDigest) mapped.previousDigest = row.previousDigest;
  if (row.digest) mapped.digest = row.digest;
  return mapped;
}

function mapPrincipal(row: typeof schema.principals.$inferSelect): Principal {
  return {
    id: row.id,
    state: row.state as Principal["state"],
    assurance: row.assurance as Principal["assurance"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt } : {}),
    ...(row.suspendedAt ? { suspendedAt: row.suspendedAt } : {}),
  };
}

function mapIdentity(
  row: typeof schema.externalIdentities.$inferSelect,
): ExternalIdentity {
  return {
    id: row.id,
    principalId: row.principalId,
    kind: row.kind as ExternalIdentity["kind"],
    issuer: row.issuer,
    subject: row.subject,
    assurance: row.assurance as ExternalIdentity["assurance"],
    linkedAt: row.linkedAt,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    ...(row.tenant ? { tenant: row.tenant } : {}),
    ...(row.displayHint ? { displayHint: row.displayHint } : {}),
    ...(row.emailNormalized != null
      ? { emailNormalized: row.emailNormalized }
      : {}),
    ...(row.emailVerified != null ? { emailVerified: row.emailVerified } : {}),
    ...(row.lastAuthenticatedAt
      ? { lastAuthenticatedAt: row.lastAuthenticatedAt }
      : {}),
  };
}

function mapAuthorizationRequest(
  row: typeof schema.authorizationRequests.$inferSelect,
): AuthorizationRequest {
  return {
    id: row.id,
    principalId: row.principalId,
    requesterRef: row.requesterRef,
    authorizationDetails: row.authorizationDetails,
    requestDigest: row.requestDigest,
    bindingMessage: row.bindingMessage,
    status: row.status as AuthorizationRequest["status"],
    intervalSeconds: row.intervalSeconds,
    ...(row.connectionId ? { connectionId: row.connectionId } : {}),
    ...(row.delegationId ? { delegationId: row.delegationId } : {}),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.decidedAt ? { decidedAt: row.decidedAt } : {}),
    ...(row.decidedByPrincipalId
      ? { decidedByPrincipalId: row.decidedByPrincipalId }
      : {}),
    ...(row.decidedByKind
      ? { decidedByKind: row.decidedByKind as "human" | "agent" }
      : {}),
    version: row.version,
  };
}

function mapClaim(row: typeof schema.claimSessions.$inferSelect): ClaimSession {
  return {
    id: row.id,
    type: row.type as ClaimSession["type"],
    state: row.state as ClaimSession["state"],
    tokenDigest: row.tokenDigest,
    targetManifest: (row.targetManifest ?? {}) as Record<string, unknown>,
    targetManifestDigest: row.targetManifestDigest,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    version: row.version,
    ...(row.creatorPrincipalId
      ? { creatorPrincipalId: row.creatorPrincipalId }
      : {}),
    ...(row.creatorAgentId ? { creatorAgentId: row.creatorAgentId } : {}),
    ...(row.creatorInstanceId
      ? { creatorInstanceId: row.creatorInstanceId }
      : {}),
    ...(row.userCodeDigest ? { userCodeDigest: row.userCodeDigest } : {}),
    ...(row.proofKeyJkt ? { proofKeyJkt: row.proofKeyJkt } : {}),
    ...(row.requestedDestination
      ? {
          requestedDestination: row.requestedDestination as Record<
            string,
            unknown
          >,
        }
      : {}),
    ...(row.requestedGrant
      ? { requestedGrant: row.requestedGrant as Record<string, unknown> }
      : {}),
    ...(row.presentedAt ? { presentedAt: row.presentedAt } : {}),
    ...(row.authenticatedAt ? { authenticatedAt: row.authenticatedAt } : {}),
    ...(row.reviewedAt ? { reviewedAt: row.reviewedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
    ...(row.completedByPrincipalId
      ? { completedByPrincipalId: row.completedByPrincipalId }
      : {}),
  };
}

function mapOutbox(row: typeof schema.outboxEvents.$inferSelect): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    availableAt: row.availableAt,
    attempts: row.attempts,
    ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
  };
}

function isUniqueViolation(err: unknown): boolean {
  // postgres-js surfaces the PG error code on the error itself; the PGlite
  // driver wraps the original error in `cause`. Check both so the conflict
  // mapping behaves identically under either driver.
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "code" in candidate &&
      (candidate as { code?: string }).code === "23505"
    ) {
      return true;
    }
  }
  return false;
}

class PostgresUnitOfWork implements UnitOfWork {
  constructor(readonly db: TxDb) {}

  async appendOutbox(event: NewOutboxEvent): Promise<OutboxEvent> {
    const id = event.id || randomUUID();
    const [row] = await this.db
      .insert(schema.outboxEvents)
      .values({
        id,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        availableAt: event.availableAt ?? new Date(),
      })
      .returning();
    if (!row) {
      throw new Error("failed to append outbox event");
    }
    return mapOutbox(row);
  }
}

function dbOf(uow: UnitOfWork | undefined, root: Database): TxDb {
  if (uow instanceof PostgresUnitOfWork) {
    return uow.db;
  }
  return root;
}

export class PostgresRepositories implements Repositories {
  constructor(private readonly db: Database) {}

  readonly principals: PrincipalRepository = {
    create: async (principal, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.principals)
          .values({
            id: principal.id,
            state: principal.state,
            assurance: principal.assurance,
            verifiedAt: principal.verifiedAt,
            suspendedAt: principal.suspendedAt,
            version: principal.version,
            createdAt: principal.createdAt,
            updatedAt: principal.updatedAt,
          })
          .returning();
        if (!row) throw new Error("insert principal returned no row");
        return mapPrincipal(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(`principal already exists: ${principal.id}`);
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.principals)
        .where(eq(schema.principals.id, id))
        .limit(1);
      return row ? mapPrincipal(row) : null;
    },
    deleteUnlinkedProvisional: async (id, uow) => {
      const rows = await dbOf(uow, this.db)
        .delete(schema.principals)
        .where(
          and(
            eq(schema.principals.id, id),
            eq(schema.principals.state, "provisional"),
            notExists(
              dbOf(uow, this.db)
                .select({ id: schema.externalIdentities.id })
                .from(schema.externalIdentities)
                .where(eq(schema.externalIdentities.principalId, id)),
            ),
          ),
        )
        .returning({ id: schema.principals.id });
      return rows.length > 0;
    },

    update: async (id, patch, expectedVersion, uow) => {
      const [row] = await dbOf(uow, this.db)
        .update(schema.principals)
        .set({
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.assurance !== undefined
            ? { assurance: patch.assurance }
            : {}),
          ...(patch.verifiedAt !== undefined
            ? { verifiedAt: patch.verifiedAt }
            : {}),
          ...(patch.suspendedAt !== undefined
            ? { suspendedAt: patch.suspendedAt }
            : {}),
          updatedAt: patch.updatedAt ?? new Date(),
          version: sql`${schema.principals.version} + 1`,
        })
        .where(
          and(
            eq(schema.principals.id, id),
            eq(schema.principals.version, expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [existing] = await dbOf(uow, this.db)
          .select()
          .from(schema.principals)
          .where(eq(schema.principals.id, id))
          .limit(1);
        if (!existing) throw new NotFoundError(`principal not found: ${id}`);
        throw new ConflictError(
          `principal version conflict: expected ${expectedVersion}, got ${existing.version}`,
        );
      }
      return mapPrincipal(row);
    },
  };

  readonly externalIdentities: ExternalIdentityRepository = {
    create: async (identity, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.externalIdentities)
          .values({
            id: identity.id,
            principalId: identity.principalId,
            kind: identity.kind,
            issuer: identity.issuer,
            tenant: normalizeTenant(identity.tenant),
            subject: identity.subject,
            displayHint: identity.displayHint,
            emailNormalized: identity.emailNormalized,
            emailVerified: identity.emailVerified,
            assurance: identity.assurance,
            linkedAt: identity.linkedAt,
            lastAuthenticatedAt: identity.lastAuthenticatedAt,
            metadata: identity.metadata,
          })
          .returning();
        if (!row) throw new Error("insert identity returned no row");
        return mapIdentity(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            "external identity collision for kind+issuer+tenant+subject",
          );
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.externalIdentities)
        .where(eq(schema.externalIdentities.id, id))
        .limit(1);
      return row ? mapIdentity(row) : null;
    },

    findByTuple: async (input) => {
      const [row] = await this.db
        .select()
        .from(schema.externalIdentities)
        .where(
          and(
            eq(schema.externalIdentities.kind, input.kind),
            eq(schema.externalIdentities.issuer, input.issuer),
            eq(schema.externalIdentities.tenant, normalizeTenant(input.tenant)),
            eq(schema.externalIdentities.subject, input.subject),
          ),
        )
        .limit(1);
      return row ? mapIdentity(row) : null;
    },

    listByPrincipal: async (principalId) => {
      const rows = await this.db
        .select()
        .from(schema.externalIdentities)
        .where(eq(schema.externalIdentities.principalId, principalId));
      return rows.map(mapIdentity);
    },

    listByEmailNormalized: async (email) => {
      const rows = await this.db
        .select()
        .from(schema.externalIdentities)
        .where(eq(schema.externalIdentities.emailNormalized, email));
      return rows.map(mapIdentity);
    },

    deleteById: async (id, uow) => {
      const rows = await dbOf(uow, this.db)
        .delete(schema.externalIdentities)
        .where(eq(schema.externalIdentities.id, id))
        .returning({ id: schema.externalIdentities.id });
      return rows.length > 0;
    },
  };

  readonly betterAuthSubjects: BetterAuthSubjectRepository = {
    link: async (row, uow) => {
      try {
        const [inserted] = await dbOf(uow, this.db)
          .insert(schema.betterAuthSubjects)
          .values({
            betterAuthUserId: row.betterAuthUserId,
            principalId: row.principalId,
            linkedAt: row.linkedAt,
          })
          .returning();
        if (!inserted) throw new Error("insert better_auth_subject failed");
        return {
          betterAuthUserId: inserted.betterAuthUserId,
          principalId: inserted.principalId,
          linkedAt: inserted.linkedAt,
        };
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            `better auth subject already linked: ${row.betterAuthUserId}`,
          );
        }
        throw err;
      }
    },

    getByBetterAuthUserId: async (userId) => {
      const [row] = await this.db
        .select()
        .from(schema.betterAuthSubjects)
        .where(eq(schema.betterAuthSubjects.betterAuthUserId, userId))
        .limit(1);
      return row
        ? {
            betterAuthUserId: row.betterAuthUserId,
            principalId: row.principalId,
            linkedAt: row.linkedAt,
          }
        : null;
    },
  };

  readonly authorizationRequests: AuthorizationRequestRepository = {
    create: async (request, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.authorizationRequests)
          .values({
            id: request.id,
            principalId: request.principalId,
            requesterRef: request.requesterRef,
            authorizationDetails: request.authorizationDetails,
            requestDigest: request.requestDigest,
            bindingMessage: request.bindingMessage,
            status: request.status,
            intervalSeconds: request.intervalSeconds,
            connectionId: request.connectionId,
            delegationId: request.delegationId,
            createdAt: request.createdAt,
            expiresAt: request.expiresAt,
            decidedAt: request.decidedAt,
            decidedByPrincipalId: request.decidedByPrincipalId,
            decidedByKind: request.decidedByKind,
            version: request.version,
          })
          .returning();
        if (!row) throw new Error("insert authorization request failed");
        return mapAuthorizationRequest(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            `authorization request conflict: ${request.id}`,
          );
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.authorizationRequests)
        .where(eq(schema.authorizationRequests.id, id))
        .limit(1);
      return row ? mapAuthorizationRequest(row) : null;
    },

    listForPrincipal: async (principalId, filter) => {
      const where = filter?.status
        ? and(
            eq(schema.authorizationRequests.principalId, principalId),
            eq(schema.authorizationRequests.status, filter.status),
          )
        : eq(schema.authorizationRequests.principalId, principalId);
      const rows = await this.db
        .select()
        .from(schema.authorizationRequests)
        .where(where)
        .orderBy(desc(schema.authorizationRequests.createdAt))
        .limit(filter?.limit ?? 50);
      return rows.map(mapAuthorizationRequest);
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const [row] = await dbOf(uow, this.db)
        .update(schema.authorizationRequests)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.expiresAt !== undefined
            ? { expiresAt: patch.expiresAt }
            : {}),
          ...(patch.decidedAt !== undefined
            ? { decidedAt: patch.decidedAt }
            : {}),
          ...(patch.decidedByPrincipalId !== undefined
            ? { decidedByPrincipalId: patch.decidedByPrincipalId }
            : {}),
          ...(patch.decidedByKind !== undefined
            ? { decidedByKind: patch.decidedByKind }
            : {}),
          version: expectedVersion + 1,
        })
        .where(
          and(
            eq(schema.authorizationRequests.id, id),
            eq(schema.authorizationRequests.version, expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [current] = await this.db
          .select()
          .from(schema.authorizationRequests)
          .where(eq(schema.authorizationRequests.id, id))
          .limit(1);
        if (!current) {
          throw new NotFoundError(`authorization request not found: ${id}`);
        }
        throw new ConflictError(
          `authorization request version conflict: expected ${expectedVersion}, got ${current.version}`,
        );
      }
      return mapAuthorizationRequest(row);
    },
  };

  readonly claimSessions: ClaimSessionRepository = {
    create: async (session, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.claimSessions)
          .values({
            id: session.id,
            type: session.type,
            state: session.state,
            creatorPrincipalId: session.creatorPrincipalId,
            creatorAgentId: session.creatorAgentId,
            creatorInstanceId: session.creatorInstanceId,
            tokenDigest: session.tokenDigest,
            userCodeDigest: session.userCodeDigest,
            proofKeyJkt: session.proofKeyJkt,
            targetManifest: session.targetManifest,
            targetManifestDigest: session.targetManifestDigest,
            requestedDestination: session.requestedDestination,
            requestedGrant: session.requestedGrant,
            presentedAt: session.presentedAt,
            authenticatedAt: session.authenticatedAt,
            reviewedAt: session.reviewedAt,
            completedAt: session.completedAt,
            expiresAt: session.expiresAt,
            revokedAt: session.revokedAt,
            completedByPrincipalId: session.completedByPrincipalId,
            version: session.version,
            createdAt: session.createdAt,
          })
          .returning();
        if (!row) throw new Error("insert claim session failed");
        return mapClaim(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(`claim session conflict: ${session.id}`);
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.claimSessions)
        .where(eq(schema.claimSessions.id, id))
        .limit(1);
      return row ? mapClaim(row) : null;
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const [row] = await dbOf(uow, this.db)
        .update(schema.claimSessions)
        .set({
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.creatorPrincipalId !== undefined
            ? { creatorPrincipalId: patch.creatorPrincipalId }
            : {}),
          ...(patch.creatorAgentId !== undefined
            ? { creatorAgentId: patch.creatorAgentId }
            : {}),
          ...(patch.creatorInstanceId !== undefined
            ? { creatorInstanceId: patch.creatorInstanceId }
            : {}),
          ...(patch.tokenDigest !== undefined
            ? { tokenDigest: patch.tokenDigest }
            : {}),
          ...(patch.userCodeDigest !== undefined
            ? { userCodeDigest: patch.userCodeDigest }
            : {}),
          ...(patch.proofKeyJkt !== undefined
            ? { proofKeyJkt: patch.proofKeyJkt }
            : {}),
          ...(patch.targetManifest !== undefined
            ? { targetManifest: patch.targetManifest }
            : {}),
          ...(patch.targetManifestDigest !== undefined
            ? { targetManifestDigest: patch.targetManifestDigest }
            : {}),
          ...(patch.requestedDestination !== undefined
            ? { requestedDestination: patch.requestedDestination }
            : {}),
          ...(patch.requestedGrant !== undefined
            ? { requestedGrant: patch.requestedGrant }
            : {}),
          ...(patch.presentedAt !== undefined
            ? { presentedAt: patch.presentedAt }
            : {}),
          ...(patch.authenticatedAt !== undefined
            ? { authenticatedAt: patch.authenticatedAt }
            : {}),
          ...(patch.reviewedAt !== undefined
            ? { reviewedAt: patch.reviewedAt }
            : {}),
          ...(patch.completedAt !== undefined
            ? { completedAt: patch.completedAt }
            : {}),
          ...(patch.expiresAt !== undefined
            ? { expiresAt: patch.expiresAt }
            : {}),
          ...(patch.revokedAt !== undefined
            ? { revokedAt: patch.revokedAt }
            : {}),
          ...(patch.completedByPrincipalId !== undefined
            ? { completedByPrincipalId: patch.completedByPrincipalId }
            : {}),
          version: sql`${schema.claimSessions.version} + 1`,
        })
        .where(
          and(
            eq(schema.claimSessions.id, id),
            eq(schema.claimSessions.version, expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [existing] = await dbOf(uow, this.db)
          .select()
          .from(schema.claimSessions)
          .where(eq(schema.claimSessions.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(`claim session not found: ${id}`);
        }
        throw new ConflictError(
          `claim version conflict: expected ${expectedVersion}, got ${existing.version}`,
        );
      }
      return mapClaim(row);
    },
  };

  readonly claimItems: ClaimItemRepository = {
    create: async (item, uow) => {
      const [row] = await dbOf(uow, this.db)
        .insert(schema.claimItems)
        .values({
          id: item.id,
          claimId: item.claimId,
          targetType: item.targetType,
          targetId: item.targetId,
          required: item.required,
          dependencies: item.dependencies,
          requestedAction: item.requestedAction,
          state: item.state,
          snapshotVersion: item.snapshotVersion,
          snapshotDigest: item.snapshotDigest,
        })
        .returning();
      if (!row) throw new Error("insert claim item failed");
      return {
        id: row.id,
        claimId: row.claimId,
        targetType: row.targetType as ClaimItem["targetType"],
        targetId: row.targetId,
        required: row.required,
        dependencies: (row.dependencies ?? []) as string[],
        requestedAction: row.requestedAction as ClaimItem["requestedAction"],
        state: row.state as ClaimItem["state"],
        snapshotVersion: row.snapshotVersion,
        snapshotDigest: row.snapshotDigest,
      };
    },

    listByClaim: async (claimId) => {
      const rows = await this.db
        .select()
        .from(schema.claimItems)
        .where(eq(schema.claimItems.claimId, claimId));
      return rows.map((row) => ({
        id: row.id,
        claimId: row.claimId,
        targetType: row.targetType as ClaimItem["targetType"],
        targetId: row.targetId,
        required: row.required,
        dependencies: (row.dependencies ?? []) as string[],
        requestedAction: row.requestedAction as ClaimItem["requestedAction"],
        state: row.state as ClaimItem["state"],
        snapshotVersion: row.snapshotVersion,
        snapshotDigest: row.snapshotDigest,
      }));
    },
  };

  readonly auditEvents: AuditEventRepository = {
    append: async (event, uow) => {
      const [row] = await dbOf(uow, this.db)
        .insert(schema.auditEvents)
        .values({
          id: event.id,
          occurredAt: event.occurredAt,
          eventType: event.eventType,
          principalId: event.principalId,
          actorType: event.actorType,
          actorId: event.actorId,
          agentInstanceId: event.agentInstanceId,
          clientId: event.clientId,
          organizationId: event.organizationId,
          projectId: event.projectId,
          claimId: event.claimId,
          sessionId: event.sessionId,
          targetType: event.targetType,
          targetId: event.targetId,
          outcome: event.outcome,
          correlationId: event.correlationId,
          causationId: event.causationId,
          metadata: event.metadata,
          previousDigest: event.previousDigest,
          digest: event.digest,
        })
        .returning();
      if (!row) throw new Error("insert audit event failed");
      return mapAuditEvent(row);
    },
    list: async (filter) => {
      const limit = filter?.limit ?? 50;
      let query = this.db
        .select()
        .from(schema.auditEvents)
        // Append order, newest first. Ordering by `occurred_at` cannot re-walk the
        // hash chain: it comes from a clock, and ties sort arbitrarily.
        .orderBy(desc(schema.auditEvents.seq))
        .limit(limit)
        .$dynamic();
      if (filter?.principalId) {
        query = query.where(
          eq(schema.auditEvents.principalId, filter.principalId),
        );
      }
      const rows = await query;
      return rows.map(mapAuditEvent);
    },
  };

  readonly outbox: OutboxRepository = {
    append: async (event, uow) => {
      if (uow instanceof PostgresUnitOfWork) {
        return uow.appendOutbox(event);
      }
      return new PostgresUnitOfWork(this.db).appendOutbox(event);
    },

    listUnpublished: async (limit = 100) => {
      const now = new Date();
      const rows = await this.db
        .select()
        .from(schema.outboxEvents)
        .where(isNull(schema.outboxEvents.publishedAt))
        .orderBy(schema.outboxEvents.availableAt)
        .limit(limit * 4);
      return rows
        .filter((row) => !outboxHoldActive(row.lastError ?? undefined, now))
        .slice(0, limit)
        .map(mapOutbox);
    },

    claimUnpublished: async (
      limit = 100,
      now = new Date(),
      holdMs = OUTBOX_CLAIM_HOLD_MS,
    ) => {
      const token = outboxClaimToken(now, holdMs);
      return this.db.transaction(async (tx) => {
        const candidates = await tx
          .select()
          .from(schema.outboxEvents)
          .where(
            and(
              isNull(schema.outboxEvents.publishedAt),
              sql`${schema.outboxEvents.availableAt} <= ${now}`,
            ),
          )
          .orderBy(schema.outboxEvents.availableAt)
          .limit(limit * 4)
          .for("update", { skipLocked: true });
        const claimed: OutboxEvent[] = [];
        for (const row of candidates) {
          if (outboxHoldActive(row.lastError ?? undefined, now)) continue;
          if (claimed.length >= limit) break;
          const [updated] = await tx
            .update(schema.outboxEvents)
            .set({ lastError: token, attempts: row.attempts + 1 })
            .where(eq(schema.outboxEvents.id, row.id))
            .returning();
          if (updated) claimed.push(mapOutbox(updated));
        }
        return claimed;
      });
    },

    releaseClaim: async (id, error) => {
      await this.db
        .update(schema.outboxEvents)
        .set({ lastError: error ?? null })
        .where(
          and(
            eq(schema.outboxEvents.id, id),
            isNull(schema.outboxEvents.publishedAt),
          ),
        );
    },

    markPublished: async (id, publishedAt = new Date()) => {
      const [row] = await this.db
        .update(schema.outboxEvents)
        .set({ publishedAt, lastError: null })
        .where(
          and(
            eq(schema.outboxEvents.id, id),
            isNull(schema.outboxEvents.publishedAt),
          ),
        )
        .returning();
      if (!row) {
        const [existing] = await this.db
          .select()
          .from(schema.outboxEvents)
          .where(eq(schema.outboxEvents.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(`outbox event not found: ${id}`);
        }
      }
    },
  };

  async transaction<T>(fn: TransactionFn<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const uow = new PostgresUnitOfWork(tx as unknown as Database);
      return fn(uow);
    });
  }
}

export function createPostgresRepositories(db: Database): PostgresRepositories {
  return new PostgresRepositories(db);
}

export type { postgres };
