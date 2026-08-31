import { randomUUID } from "node:crypto";
import {
  type ApprovalActivation,
  type ApprovalReceipt,
  type AuditEvent,
  type AuthorizationRequest,
  type BetterAuthSubject,
  type BoundaryValue,
  type ByoUpstream,
  type ClaimItem,
  type ClaimSession,
  type ComparisonChallenge,
  type ExternalChannelBinding,
  type ExternalIdentity,
  type JsonObject,
  type NotificationDelivery,
  type NotificationPreferences,
  type Organization,
  type OrganizationMembership,
  type OutboxEvent,
  type Principal,
  type Project,
  type ProjectMembership,
  type WebhookDelivery,
  type WebhookEndpoint,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type Column,
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import * as schema from "../schema/index.js";
import {
  type ApprovalActivationRepository,
  type ApprovalReceiptRepository,
  type AuditEventRepository,
  type AuthorizationRequestRepository,
  type BetterAuthSubjectRepository,
  type ByoUpstreamRepository,
  type CallbackReplayRepository,
  type ChannelBindingChallenge,
  type ChannelBindingChallengeRepository,
  type ChannelBindingRepository,
  type ClaimItemRepository,
  type ClaimSessionRepository,
  type ComparisonChallengeRepository,
  ConflictError,
  type EnsurePersonalProjectResult,
  type ExternalIdentityRepository,
  type NewOutboxEvent,
  NotFoundError,
  type NotificationDeliveryRepository,
  type NotificationPreferenceRepository,
  OUTBOX_CLAIM_HOLD_MS,
  type OrganizationMembershipStore,
  type OrganizationStore,
  type OrganizationStores,
  type OutboxRepository,
  type PrincipalRepository,
  type ProjectMembershipStore,
  type ProjectStore,
  type ProjectStores,
  type PushSubscription,
  type PushSubscriptionRepository,
  type Repositories,
  type TransactionFn,
  type UnitOfWork,
  type WebhookDeliveryRepository,
  type WebhookEndpointRepository,
  buildPersonalProject,
  normalizeIssuer,
  normalizeOrganizationRow,
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
    outcome: overlapCast(row.outcome),
    correlationId: row.correlationId,
    metadata: overlapCast(row.metadata ?? {}),
  };
  if (row.principalId) mapped.principalId = row.principalId;
  if (row.actorType) {
    mapped.actorType = overlapCast(row.actorType);
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
    state: overlapCast(row.state),
    assurance: overlapCast(row.assurance),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt } : undefined),
    ...(row.suspendedAt ? { suspendedAt: row.suspendedAt } : undefined),
  };
}

function mapIdentity(
  row: typeof schema.externalIdentities.$inferSelect,
): ExternalIdentity {
  return {
    id: row.id,
    principalId: row.principalId,
    kind: overlapCast(row.kind),
    issuer: row.issuer,
    subject: row.subject,
    assurance: overlapCast(row.assurance),
    linkedAt: row.linkedAt,
    metadata: overlapCast(row.metadata ?? {}),
    ...(row.tenant ? { tenant: row.tenant } : undefined),
    ...(row.displayHint ? { displayHint: row.displayHint } : undefined),
    ...(row.emailNormalized != null
      ? { emailNormalized: row.emailNormalized }
      : undefined),
    ...(row.emailVerified != null
      ? { emailVerified: row.emailVerified }
      : undefined),
    ...(row.lastAuthenticatedAt
      ? { lastAuthenticatedAt: row.lastAuthenticatedAt }
      : undefined),
  };
}

function mapByoUpstream(
  row: typeof schema.byoUpstreams.$inferSelect,
): ByoUpstream {
  return {
    id: row.id,
    issuer: row.issuer,
    label: row.label,
    clientId: row.clientId,
    clientAuth: overlapCast(row.clientAuth),
    registrationSource: overlapCast(row.registrationSource),
    state: overlapCast(row.state),
    createdAt: row.createdAt,
    ...(row.clientSecret ? { clientSecret: row.clientSecret } : undefined),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : undefined),
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
    status: overlapCast(row.status),
    intervalSeconds: row.intervalSeconds,
    ...(row.connectionId ? { connectionId: row.connectionId } : undefined),
    ...(row.delegationId ? { delegationId: row.delegationId } : undefined),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.decidedAt ? { decidedAt: row.decidedAt } : undefined),
    ...(row.decidedByPrincipalId
      ? { decidedByPrincipalId: row.decidedByPrincipalId }
      : undefined),
    ...(row.decidedByKind
      ? { decidedByKind: overlapCast(row.decidedByKind) }
      : undefined),
    version: row.version,
  };
}

function mapClaim(row: typeof schema.claimSessions.$inferSelect): ClaimSession {
  return {
    id: row.id,
    type: overlapCast(row.type),
    state: overlapCast(row.state),
    tokenDigest: row.tokenDigest,
    targetManifest: overlapCast(row.targetManifest ?? {}),
    targetManifestDigest: row.targetManifestDigest,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    version: row.version,
    ...(row.creatorPrincipalId
      ? { creatorPrincipalId: row.creatorPrincipalId }
      : undefined),
    ...(row.creatorAgentId
      ? { creatorAgentId: row.creatorAgentId }
      : undefined),
    ...(row.creatorInstanceId
      ? { creatorInstanceId: row.creatorInstanceId }
      : undefined),
    ...(row.userCodeDigest
      ? { userCodeDigest: row.userCodeDigest }
      : undefined),
    ...(row.proofKeyJkt ? { proofKeyJkt: row.proofKeyJkt } : undefined),
    ...(row.requestedDestination
      ? {
          requestedDestination: overlapCast(row.requestedDestination),
        }
      : undefined),
    ...(row.requestedGrant
      ? { requestedGrant: overlapCast(row.requestedGrant) }
      : undefined),
    ...(row.presentedAt ? { presentedAt: row.presentedAt } : undefined),
    ...(row.authenticatedAt
      ? { authenticatedAt: row.authenticatedAt }
      : undefined),
    ...(row.reviewedAt ? { reviewedAt: row.reviewedAt } : undefined),
    ...(row.completedAt ? { completedAt: row.completedAt } : undefined),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : undefined),
    ...(row.completedByPrincipalId
      ? { completedByPrincipalId: row.completedByPrincipalId }
      : undefined),
  };
}

function mapOutbox(row: typeof schema.outboxEvents.$inferSelect): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: overlapCast(row.payload ?? {}),
    createdAt: row.createdAt,
    availableAt: row.availableAt,
    attempts: row.attempts,
    ...(row.publishedAt ? { publishedAt: row.publishedAt } : undefined),
    ...(row.lastError ? { lastError: row.lastError } : undefined),
  };
}

function mapWebhookEndpoint(
  row: typeof schema.webhookEndpoints.$inferSelect,
): WebhookEndpoint {
  return {
    id: row.id,
    principalId: row.principalId,
    url: row.url,
    secret: row.secret,
    ...(row.description ? { description: row.description } : undefined),
    createdAt: row.createdAt,
    ...(row.disabledAt ? { disabledAt: row.disabledAt } : undefined),
  };
}

function mapWebhookDelivery(
  row: typeof schema.webhookDeliveries.$inferSelect,
): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventType: row.eventType,
    payload: overlapCast(row.payload ?? {}),
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : undefined),
    ...(row.deadAt ? { deadAt: row.deadAt } : undefined),
    ...(row.lastError ? { lastError: row.lastError } : undefined),
    createdAt: row.createdAt,
  };
}

function mapChannelBinding(
  row: typeof schema.channelBindings.$inferSelect,
): ExternalChannelBinding {
  return {
    id: row.id,
    principalId: row.principalId,
    kind: overlapCast(row.kind),
    providerId: row.providerId,
    providerTenantId: row.providerTenantId,
    providerSubjectId: row.providerSubjectId,
    ...(row.displayLabel ? { displayLabel: row.displayLabel } : undefined),
    state: overlapCast(row.state),
    verification: overlapCast(row.verification),
    createdAt: row.createdAt,
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt } : undefined),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : undefined),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : undefined),
    metadata: overlapCast(row.metadata ?? {}),
    version: row.version,
  };
}

function mapBindingChallenge(
  row: typeof schema.channelBindingChallenges.$inferSelect,
): ChannelBindingChallenge {
  return {
    id: row.id,
    principalId: row.principalId,
    kind: overlapCast(row.kind),
    providerId: row.providerId,
    nonceDigest: row.nonceDigest,
    ...(row.expectedTenantId != null
      ? { expectedTenantId: row.expectedTenantId }
      : undefined),
    ...(row.expectedSubjectId != null
      ? { expectedSubjectId: row.expectedSubjectId }
      : undefined),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : undefined),
    version: row.version,
  };
}

function mapNotificationPreferences(
  row: typeof schema.notificationPreferences.$inferSelect,
): NotificationPreferences {
  return {
    principalId: row.principalId,
    byClass: overlapCast(row.byClass ?? {}),
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function mapNotificationDelivery(
  row: typeof schema.notificationDeliveries.$inferSelect,
): NotificationDelivery {
  return {
    id: row.id,
    principalId: row.principalId,
    kind: overlapCast(row.kind),
    ...(row.bindingId ? { bindingId: row.bindingId } : undefined),
    ...(row.endpointId ? { endpointId: row.endpointId } : undefined),
    notificationClass: row.notificationClass,
    eventType: row.eventType,
    outboxEventId: row.outboxEventId,
    ...(row.authReqId ? { authReqId: row.authReqId } : undefined),
    payload: overlapCast(row.payload ?? {}),
    confidentiality: overlapCast(row.confidentiality),
    state: overlapCast(row.state),
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    ...(row.lastError ? { lastError: row.lastError } : undefined),
    createdAt: row.createdAt,
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : undefined),
    ...(row.providerMessageRef
      ? { providerMessageRef: row.providerMessageRef }
      : undefined),
  };
}

function mapApprovalActivation(
  row: typeof schema.approvalActivations.$inferSelect,
): ApprovalActivation {
  return {
    id: row.id,
    authReqId: row.authReqId,
    principalId: row.principalId,
    transactionDigest: row.transactionDigest,
    decision: overlapCast(row.decision),
    policyDigest: row.policyDigest,
    channelKind: overlapCast(row.channelKind),
    challengeDigest: row.challengeDigest,
    state: overlapCast(row.state),
    createdAt: row.createdAt,
    ...(row.activatedAt ? { activatedAt: row.activatedAt } : undefined),
    ...(row.consumedAt ? { consumedAt: row.consumedAt } : undefined),
    expiresAt: row.expiresAt,
    ...(row.trustSessionId
      ? { trustSessionId: row.trustSessionId }
      : undefined),
    ...(row.method ? { method: row.method } : undefined),
    version: row.version,
  };
}

function mapComparisonChallenge(
  row: typeof schema.comparisonChallenges.$inferSelect,
): ComparisonChallenge {
  return {
    id: row.id,
    authReqId: row.authReqId,
    valueDigest: row.valueDigest,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.satisfiedAt ? { satisfiedAt: row.satisfiedAt } : undefined),
    version: row.version,
  };
}

function mapApprovalReceipt(
  row: typeof schema.approvalReceipts.$inferSelect,
): ApprovalReceipt {
  return {
    id: row.id,
    authReqId: row.authReqId,
    principalId: row.principalId,
    decision: overlapCast(row.decision),
    decidedByKind: overlapCast(row.decidedByKind),
    path: overlapCast(row.path),
    channelKind: overlapCast(row.channelKind),
    ...(row.bindingId ? { bindingId: row.bindingId } : undefined),
    requestDigest: row.requestDigest,
    transactionDigest: row.transactionDigest,
    policyDigest: row.policyDigest,
    requiredAssurance: row.requiredAssurance ?? [],
    achievedAssurance: row.achievedAssurance ?? [],
    evidenceIds: row.evidenceIds ?? [],
    ...(row.trustSessionId
      ? { trustSessionId: row.trustSessionId }
      : undefined),
    ...(row.activationId ? { activationId: row.activationId } : undefined),
    comparisonRequired: row.comparisonRequired,
    comparisonSatisfied: row.comparisonSatisfied,
    ...(row.callbackDigest
      ? { callbackDigest: row.callbackDigest }
      : undefined),
    decidedAt: row.decidedAt,
    receiptVersion: row.receiptVersion,
  };
}

function mapPushSubscription(
  row: typeof schema.pushSubscriptions.$inferSelect,
): PushSubscription {
  return {
    id: row.id,
    principalId: row.principalId,
    endpoint: row.endpoint,
    p256dhKey: row.p256dhKey,
    authSecret: row.authSecret,
    endpointDigest: row.endpointDigest,
    ...(row.deviceLabel ? { deviceLabel: row.deviceLabel } : undefined),
    createdAt: row.createdAt,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : undefined),
    ...(row.disabledAt ? { disabledAt: row.disabledAt } : undefined),
  };
}

function isUniqueViolation(err: BoundaryValue): boolean {
  // postgres-js surfaces the PG error code on the error itself; the PGlite
  // driver wraps the original error in `cause`. Check both so the conflict
  // mapping behaves identically under either driver.
  for (const candidate of [err, overlapCast(err)?.cause]) {
    if (
      isTypeofObject(candidate) &&
      candidate !== null &&
      "code" in candidate &&
      overlapCast(candidate).code === "23505"
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
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
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
          ...(patch.state !== undefined ? { state: patch.state } : undefined),
          ...(patch.assurance !== undefined
            ? { assurance: patch.assurance }
            : undefined),
          ...(patch.verifiedAt !== undefined
            ? { verifiedAt: patch.verifiedAt }
            : undefined),
          ...(patch.suspendedAt !== undefined
            ? { suspendedAt: patch.suspendedAt }
            : undefined),
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
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
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

    findVerifiedByEmail: async (emailNormalized) => {
      // The email column is deliberately non-unique, so the tie-break is the
      // contract: oldest owning principal, then principal id, then identity id.
      const [row] = await this.db
        .select({ identity: getTableColumns(schema.externalIdentities) })
        .from(schema.externalIdentities)
        .innerJoin(
          schema.principals,
          eq(schema.principals.id, schema.externalIdentities.principalId),
        )
        .where(
          and(
            eq(schema.externalIdentities.emailNormalized, emailNormalized),
            eq(schema.externalIdentities.assurance, "verified"),
            // Explicitly true, never merely not-false. A NULL here means the
            // address was recorded without anyone checking it — every row
            // written before the verified-email policy existed is NULL, and so
            // is every row from a provider that supplies an address and no
            // verification claim. Accepting those as link *targets* would let
            // an attacker pre-plant a victim's address on their own principal
            // and capture the victim's account on the victim's first real
            // sign-in, which is the exact inversion of the policy.
            eq(schema.externalIdentities.emailVerified, true),
          ),
        )
        .orderBy(
          asc(schema.principals.createdAt),
          asc(schema.externalIdentities.principalId),
          asc(schema.externalIdentities.id),
        )
        .limit(1);
      return row ? mapIdentity(row.identity) : null;
    },

    deleteById: async (id, uow) => {
      const rows = await dbOf(uow, this.db)
        .delete(schema.externalIdentities)
        .where(eq(schema.externalIdentities.id, id))
        .returning({ id: schema.externalIdentities.id });
      return rows.length > 0;
    },
  };

  readonly byoUpstreams: ByoUpstreamRepository = {
    create: async (record) => {
      const issuer = normalizeIssuer(record.issuer);
      try {
        const [row] = await this.db
          .insert(schema.byoUpstreams)
          .values({
            id: record.id,
            issuer,
            label: record.label,
            clientId: record.clientId,
            clientSecret: record.clientSecret ?? null,
            clientAuth: record.clientAuth,
            registrationSource: record.registrationSource,
            state: record.state,
            createdAt: record.createdAt,
            lastUsedAt: record.lastUsedAt ?? null,
          })
          .returning();
        if (!row) throw new Error("insert byo upstream returned no row");
        return mapByoUpstream(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
          throw new ConflictError(
            `byo upstream issuer already registered: ${issuer}`,
          );
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.byoUpstreams)
        .where(eq(schema.byoUpstreams.id, id))
        .limit(1);
      return row ? mapByoUpstream(row) : null;
    },

    findByIssuer: async (issuer) => {
      const [row] = await this.db
        .select()
        .from(schema.byoUpstreams)
        .where(eq(schema.byoUpstreams.issuer, normalizeIssuer(issuer)))
        .limit(1);
      return row ? mapByoUpstream(row) : null;
    },

    touchLastUsed: async (id, at) => {
      await this.db
        .update(schema.byoUpstreams)
        .set({ lastUsedAt: at })
        .where(eq(schema.byoUpstreams.id, id));
    },

    list: async () => {
      const rows = await this.db
        .select()
        .from(schema.byoUpstreams)
        .orderBy(desc(schema.byoUpstreams.createdAt));
      return rows.map(mapByoUpstream);
    },

    setState: async (id, state) => {
      const [row] = await this.db
        .update(schema.byoUpstreams)
        .set({ state })
        .where(eq(schema.byoUpstreams.id, id))
        .returning();
      return row ? mapByoUpstream(row) : null;
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
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
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
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
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
          ...(patch.status !== undefined
            ? { status: patch.status }
            : undefined),
          ...(patch.expiresAt !== undefined
            ? { expiresAt: patch.expiresAt }
            : undefined),
          ...(patch.decidedAt !== undefined
            ? { decidedAt: patch.decidedAt }
            : undefined),
          ...(patch.decidedByPrincipalId !== undefined
            ? { decidedByPrincipalId: patch.decidedByPrincipalId }
            : undefined),
          ...(patch.decidedByKind !== undefined
            ? { decidedByKind: patch.decidedByKind }
            : undefined),
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
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
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
          ...(patch.type !== undefined ? { type: patch.type } : undefined),
          ...(patch.state !== undefined ? { state: patch.state } : undefined),
          ...(patch.creatorPrincipalId !== undefined
            ? { creatorPrincipalId: patch.creatorPrincipalId }
            : undefined),
          ...(patch.creatorAgentId !== undefined
            ? { creatorAgentId: patch.creatorAgentId }
            : undefined),
          ...(patch.creatorInstanceId !== undefined
            ? { creatorInstanceId: patch.creatorInstanceId }
            : undefined),
          ...(patch.tokenDigest !== undefined
            ? { tokenDigest: patch.tokenDigest }
            : undefined),
          ...(patch.userCodeDigest !== undefined
            ? { userCodeDigest: patch.userCodeDigest }
            : undefined),
          ...(patch.proofKeyJkt !== undefined
            ? { proofKeyJkt: patch.proofKeyJkt }
            : undefined),
          ...(patch.targetManifest !== undefined
            ? { targetManifest: patch.targetManifest }
            : undefined),
          ...(patch.targetManifestDigest !== undefined
            ? { targetManifestDigest: patch.targetManifestDigest }
            : undefined),
          ...(patch.requestedDestination !== undefined
            ? { requestedDestination: patch.requestedDestination }
            : undefined),
          ...(patch.requestedGrant !== undefined
            ? { requestedGrant: patch.requestedGrant }
            : undefined),
          ...(patch.presentedAt !== undefined
            ? { presentedAt: patch.presentedAt }
            : undefined),
          ...(patch.authenticatedAt !== undefined
            ? { authenticatedAt: patch.authenticatedAt }
            : undefined),
          ...(patch.reviewedAt !== undefined
            ? { reviewedAt: patch.reviewedAt }
            : undefined),
          ...(patch.completedAt !== undefined
            ? { completedAt: patch.completedAt }
            : undefined),
          ...(patch.expiresAt !== undefined
            ? { expiresAt: patch.expiresAt }
            : undefined),
          ...(patch.revokedAt !== undefined
            ? { revokedAt: patch.revokedAt }
            : undefined),
          ...(patch.completedByPrincipalId !== undefined
            ? { completedByPrincipalId: patch.completedByPrincipalId }
            : undefined),
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
        targetType: overlapCast(row.targetType),
        targetId: row.targetId,
        required: row.required,
        dependencies: overlapCast(row.dependencies ?? []),
        requestedAction: overlapCast(row.requestedAction),
        state: overlapCast(row.state),
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
        targetType: overlapCast(row.targetType),
        targetId: row.targetId,
        required: row.required,
        dependencies: overlapCast(row.dependencies ?? []),
        requestedAction: overlapCast(row.requestedAction),
        state: overlapCast(row.state),
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
      const filters = [];
      if (filter?.principalId) {
        filters.push(eq(schema.auditEvents.principalId, filter.principalId));
      }
      if (filter?.clientId) {
        filters.push(eq(schema.auditEvents.clientId, filter.clientId));
      }
      if (filter?.organizationId) {
        filters.push(
          eq(schema.auditEvents.organizationId, filter.organizationId),
        );
      }
      if (filters.length > 0) query = query.where(and(...filters));
      const rows = await query;
      return rows.map(mapAuditEvent);
    },
  };

  readonly webhookEndpoints: WebhookEndpointRepository = {
    create: async (endpoint, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.webhookEndpoints)
          .values({
            id: endpoint.id,
            principalId: endpoint.principalId,
            url: endpoint.url,
            secret: endpoint.secret,
            description: endpoint.description ?? null,
            createdAt: endpoint.createdAt,
            disabledAt: endpoint.disabledAt ?? null,
          })
          .returning();
        if (!row) throw new Error("insert webhook endpoint failed");
        return mapWebhookEndpoint(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
          throw new ConflictError(`webhook endpoint conflict: ${endpoint.id}`);
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.id, id))
        .limit(1);
      return row ? mapWebhookEndpoint(row) : null;
    },

    listForPrincipal: async (principalId) => {
      const rows = await this.db
        .select()
        .from(schema.webhookEndpoints)
        .where(
          and(
            eq(schema.webhookEndpoints.principalId, principalId),
            isNull(schema.webhookEndpoints.disabledAt),
          ),
        )
        .orderBy(schema.webhookEndpoints.createdAt);
      return rows.map(mapWebhookEndpoint);
    },

    deleteById: async (id, uow) => {
      const result = await dbOf(uow, this.db)
        .delete(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.id, id))
        .returning({ id: schema.webhookEndpoints.id });
      return result.length === 1;
    },
  };

  readonly webhookDeliveries: WebhookDeliveryRepository = {
    enqueue: async (delivery, uow) => {
      const [row] = await dbOf(uow, this.db)
        .insert(schema.webhookDeliveries)
        .values({
          id: delivery.id,
          endpointId: delivery.endpointId,
          eventType: delivery.eventType,
          payload: delivery.payload,
          attempts: delivery.attempts,
          nextAttemptAt: delivery.nextAttemptAt,
          deliveredAt: delivery.deliveredAt ?? null,
          deadAt: delivery.deadAt ?? null,
          lastError: delivery.lastError ?? null,
          createdAt: delivery.createdAt,
        })
        .returning();
      if (!row) throw new Error("insert webhook delivery failed");
      return mapWebhookDelivery(row);
    },

    claimDue: async (limit, now) => {
      // Same discipline as the outbox drain: SKIP LOCKED so two dispatchers
      // racing split the due set instead of double-delivering it, and the
      // attempt is counted on claim so a crash mid-send still burned a try.
      return this.db.transaction(async (tx) => {
        const candidates = await tx
          .select()
          .from(schema.webhookDeliveries)
          .where(
            and(
              isNull(schema.webhookDeliveries.deliveredAt),
              isNull(schema.webhookDeliveries.deadAt),
              sql`${schema.webhookDeliveries.nextAttemptAt} <= ${now}`,
            ),
          )
          .orderBy(schema.webhookDeliveries.nextAttemptAt)
          .limit(limit)
          .for("update", { skipLocked: true });
        const claimed: WebhookDelivery[] = [];
        for (const row of candidates) {
          const [updated] = await tx
            .update(schema.webhookDeliveries)
            .set({ attempts: row.attempts + 1 })
            .where(eq(schema.webhookDeliveries.id, row.id))
            .returning();
          if (updated) claimed.push(mapWebhookDelivery(updated));
        }
        return claimed;
      });
    },

    markDelivered: async (id, at) => {
      await this.db
        .update(schema.webhookDeliveries)
        .set({ deliveredAt: at })
        .where(eq(schema.webhookDeliveries.id, id));
    },

    recordFailure: async (id, error, nextAttemptAt, dead) => {
      await this.db
        .update(schema.webhookDeliveries)
        .set({
          lastError: error,
          nextAttemptAt,
          ...(dead ? { deadAt: nextAttemptAt } : undefined),
        })
        .where(eq(schema.webhookDeliveries.id, id));
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

  readonly channelBindings: ChannelBindingRepository = {
    create: async (binding, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.channelBindings)
          .values({
            id: binding.id,
            principalId: binding.principalId,
            kind: binding.kind,
            providerId: binding.providerId,
            providerTenantId: binding.providerTenantId,
            providerSubjectId: binding.providerSubjectId,
            displayLabel: binding.displayLabel ?? null,
            state: binding.state,
            verification: binding.verification,
            createdAt: binding.createdAt,
            verifiedAt: binding.verifiedAt ?? null,
            revokedAt: binding.revokedAt ?? null,
            expiresAt: binding.expiresAt ?? null,
            metadata: binding.metadata,
            version: binding.version,
          })
          .returning();
        if (!row) throw new Error("insert channel binding returned no row");
        return mapChannelBinding(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
          throw new ConflictError(
            "channel binding collision for kind+provider+tenant+subject",
          );
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.channelBindings)
        .where(eq(schema.channelBindings.id, id))
        .limit(1);
      return row ? mapChannelBinding(row) : null;
    },

    listForPrincipal: async (principalId) => {
      const rows = await this.db
        .select()
        .from(schema.channelBindings)
        .where(eq(schema.channelBindings.principalId, principalId))
        .orderBy(asc(schema.channelBindings.createdAt));
      return rows.map(mapChannelBinding);
    },

    findByProviderIdentity: async (
      kind,
      providerId,
      providerTenantId,
      providerSubjectId,
    ) => {
      // Every component of the key, and never an empty subject. Subject ids
      // are unique within a provider tenant and not across them, so a lookup
      // on fewer columns lets whoever controls their own workspace mint an
      // identity that resolves to somebody else's binding. The empty-subject
      // guard is belt and braces over
      // `channel_bindings_provider_subject_id_check`, so a caller who sends
      // nothing at all cannot match even if that constraint were ever dropped.
      if (providerSubjectId === "") return null;
      const [row] = await this.db
        .select()
        .from(schema.channelBindings)
        .where(
          and(
            eq(schema.channelBindings.kind, kind),
            eq(schema.channelBindings.providerId, providerId),
            eq(schema.channelBindings.providerTenantId, providerTenantId),
            eq(schema.channelBindings.providerSubjectId, providerSubjectId),
          ),
        )
        .limit(1);
      return row ? mapChannelBinding(row) : null;
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const [row] = await dbOf(uow, this.db)
        .update(schema.channelBindings)
        .set({
          ...(patch.state !== undefined ? { state: patch.state } : undefined),
          ...(patch.verifiedAt !== undefined
            ? { verifiedAt: patch.verifiedAt }
            : undefined),
          ...(patch.revokedAt !== undefined
            ? { revokedAt: patch.revokedAt }
            : undefined),
          ...(patch.expiresAt !== undefined
            ? { expiresAt: patch.expiresAt }
            : undefined),
          ...(patch.displayLabel !== undefined
            ? { displayLabel: patch.displayLabel }
            : undefined),
          version: sql`${schema.channelBindings.version} + 1`,
        })
        .where(
          and(
            eq(schema.channelBindings.id, id),
            eq(schema.channelBindings.version, expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [existing] = await dbOf(uow, this.db)
          .select()
          .from(schema.channelBindings)
          .where(eq(schema.channelBindings.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(`channel binding not found: ${id}`);
        }
        throw new ConflictError(
          `channel binding version conflict: expected ${expectedVersion}, got ${existing.version}`,
        );
      }
      return mapChannelBinding(row);
    },
  };

  readonly channelBindingChallenges: ChannelBindingChallengeRepository = {
    create: async (challenge, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.channelBindingChallenges)
          .values({
            id: challenge.id,
            principalId: challenge.principalId,
            kind: challenge.kind,
            providerId: challenge.providerId,
            nonceDigest: challenge.nonceDigest,
            expectedTenantId: challenge.expectedTenantId ?? null,
            expectedSubjectId: challenge.expectedSubjectId ?? null,
            attempts: challenge.attempts,
            maxAttempts: challenge.maxAttempts,
            createdAt: challenge.createdAt,
            expiresAt: challenge.expiresAt,
            completedAt: challenge.completedAt ?? null,
            version: challenge.version,
          })
          .returning();
        if (!row) {
          throw new Error("insert channel binding challenge returned no row");
        }
        return mapBindingChallenge(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
          throw new ConflictError(
            `channel binding challenge already exists: ${challenge.id}`,
          );
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.channelBindingChallenges)
        .where(eq(schema.channelBindingChallenges.id, id))
        .limit(1);
      return row ? mapBindingChallenge(row) : null;
    },

    consumeAttempt: async (id, now) => {
      // One statement: the budget is read and spent by the same predicate, so
      // a second replica cannot observe it mid-flight and hand out a guess the
      // ledger never counted.
      const [row] = await this.db
        .update(schema.channelBindingChallenges)
        .set({
          attempts: sql`${schema.channelBindingChallenges.attempts} + 1`,
          version: sql`${schema.channelBindingChallenges.version} + 1`,
        })
        .where(
          and(
            eq(schema.channelBindingChallenges.id, id),
            isNull(schema.channelBindingChallenges.completedAt),
            sql`${schema.channelBindingChallenges.expiresAt} > ${now}`,
            sql`${schema.channelBindingChallenges.attempts} < ${schema.channelBindingChallenges.maxAttempts}`,
          ),
        )
        .returning();
      return row ? mapBindingChallenge(row) : null;
    },

    complete: async (id, at) => {
      // Compare-and-set on `completed_at is null`: exactly one caller wins,
      // and the losers are told rather than silently applied.
      const [row] = await this.db
        .update(schema.channelBindingChallenges)
        .set({
          completedAt: at,
          version: sql`${schema.channelBindingChallenges.version} + 1`,
        })
        .where(
          and(
            eq(schema.channelBindingChallenges.id, id),
            isNull(schema.channelBindingChallenges.completedAt),
          ),
        )
        .returning();
      return row ? mapBindingChallenge(row) : null;
    },
  };

  readonly notificationPreferences: NotificationPreferenceRepository = {
    get: async (principalId) => {
      const [row] = await this.db
        .select()
        .from(schema.notificationPreferences)
        .where(eq(schema.notificationPreferences.principalId, principalId))
        .limit(1);
      return row ? mapNotificationPreferences(row) : null;
    },

    upsert: async (preferences, uow) => {
      const [row] = await dbOf(uow, this.db)
        .insert(schema.notificationPreferences)
        .values({
          principalId: preferences.principalId,
          byClass: overlapCast(preferences.byClass),
          updatedAt: preferences.updatedAt,
          version: preferences.version,
        })
        .onConflictDoUpdate({
          target: schema.notificationPreferences.principalId,
          set: {
            byClass: overlapCast(preferences.byClass),
            updatedAt: preferences.updatedAt,
            version: preferences.version,
          },
        })
        .returning();
      if (!row) {
        throw new Error("upsert notification preferences returned no row");
      }
      return mapNotificationPreferences(row);
    },
  };

  readonly notificationDeliveries: NotificationDeliveryRepository = {
    enqueue: async (delivery, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.notificationDeliveries)
          .values({
            id: delivery.id,
            principalId: delivery.principalId,
            kind: delivery.kind,
            bindingId: delivery.bindingId ?? null,
            endpointId: delivery.endpointId ?? null,
            notificationClass: delivery.notificationClass,
            eventType: delivery.eventType,
            outboxEventId: delivery.outboxEventId,
            authReqId: delivery.authReqId ?? null,
            payload: delivery.payload,
            confidentiality: delivery.confidentiality,
            state: delivery.state,
            attempts: delivery.attempts,
            nextAttemptAt: delivery.nextAttemptAt,
            lastError: delivery.lastError ?? null,
            createdAt: delivery.createdAt,
            deliveredAt: delivery.deliveredAt ?? null,
            providerMessageRef: delivery.providerMessageRef ?? null,
          })
          .returning();
        if (!row)
          throw new Error("insert notification delivery returned no row");
        return mapNotificationDelivery(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
          // The unique index did its job: the outbox is at-least-once, and the
          // router reads this as "already fanned out" rather than ringing the
          // same doorbell a second time.
          throw new ConflictError(
            `notification delivery already fanned out: ${delivery.outboxEventId}/${delivery.kind}`,
          );
        }
        throw err;
      }
    },

    claimDue: async (limit, now) => {
      // Same discipline as the outbox drain: SKIP LOCKED so two dispatchers
      // racing split the due set instead of double-delivering it, and the
      // attempt is counted on claim so a crash mid-send still burned a try.
      return this.db.transaction(async (tx) => {
        const candidates = await tx
          .select()
          .from(schema.notificationDeliveries)
          .where(
            and(
              or(
                eq(schema.notificationDeliveries.state, "pending"),
                eq(schema.notificationDeliveries.state, "failed"),
              ),
              sql`${schema.notificationDeliveries.nextAttemptAt} <= ${now}`,
            ),
          )
          .orderBy(asc(schema.notificationDeliveries.nextAttemptAt))
          .limit(limit)
          .for("update", { skipLocked: true });
        const claimed: NotificationDelivery[] = [];
        for (const row of candidates) {
          const [updated] = await tx
            .update(schema.notificationDeliveries)
            .set({ attempts: row.attempts + 1 })
            .where(eq(schema.notificationDeliveries.id, row.id))
            .returning();
          if (updated) claimed.push(mapNotificationDelivery(updated));
        }
        return claimed;
      });
    },

    markDelivered: async (id, at, providerMessageRef) => {
      await this.db
        .update(schema.notificationDeliveries)
        .set({
          state: "delivered",
          deliveredAt: at,
          ...(providerMessageRef !== undefined
            ? { providerMessageRef }
            : undefined),
        })
        .where(eq(schema.notificationDeliveries.id, id));
    },

    recordFailure: async (id, error, nextAttemptAt, dead) => {
      await this.db
        .update(schema.notificationDeliveries)
        .set({
          // A classified reason code, never a provider response body — those
          // routinely echo the notification back.
          lastError: error,
          nextAttemptAt,
          state: dead ? "dead" : "failed",
        })
        .where(eq(schema.notificationDeliveries.id, id));
    },

    existsForEvent: async (outboxEventId, kind, destinationId) => {
      const [row] = await this.db
        .select({ id: schema.notificationDeliveries.id })
        .from(schema.notificationDeliveries)
        .where(
          and(
            eq(schema.notificationDeliveries.outboxEventId, outboxEventId),
            eq(schema.notificationDeliveries.kind, kind),
            eq(schema.notificationDeliveries.destinationId, destinationId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    listForRequest: async (authReqId) => {
      const rows = await this.db
        .select()
        .from(schema.notificationDeliveries)
        .where(eq(schema.notificationDeliveries.authReqId, authReqId))
        .orderBy(asc(schema.notificationDeliveries.createdAt));
      return rows.map(mapNotificationDelivery);
    },
  };

  readonly approvalActivations: ApprovalActivationRepository = {
    create: async (activation, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.approvalActivations)
          .values({
            id: activation.id,
            authReqId: activation.authReqId,
            principalId: activation.principalId,
            transactionDigest: activation.transactionDigest,
            decision: activation.decision,
            policyDigest: activation.policyDigest,
            channelKind: activation.channelKind,
            challengeDigest: activation.challengeDigest,
            state: activation.state,
            createdAt: activation.createdAt,
            activatedAt: activation.activatedAt ?? null,
            consumedAt: activation.consumedAt ?? null,
            expiresAt: activation.expiresAt,
            trustSessionId: activation.trustSessionId ?? null,
            method: activation.method ?? null,
            version: activation.version,
          })
          .returning();
        if (!row) throw new Error("insert approval activation returned no row");
        return mapApprovalActivation(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
          throw new ConflictError(
            `approval activation conflict: ${activation.id}`,
          );
        }
        throw err;
      }
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.approvalActivations)
        .where(eq(schema.approvalActivations.id, id))
        .limit(1);
      return row ? mapApprovalActivation(row) : null;
    },

    findByChallengeDigest: async (digest) => {
      const [row] = await this.db
        .select()
        .from(schema.approvalActivations)
        .where(eq(schema.approvalActivations.challengeDigest, digest))
        .limit(1);
      return row ? mapApprovalActivation(row) : null;
    },

    updateWithVersion: async (id, expectedVersion, patch, uow) => {
      const [row] = await dbOf(uow, this.db)
        .update(schema.approvalActivations)
        .set({
          ...(patch.state !== undefined ? { state: patch.state } : undefined),
          ...(patch.activatedAt !== undefined
            ? { activatedAt: patch.activatedAt }
            : undefined),
          ...(patch.consumedAt !== undefined
            ? { consumedAt: patch.consumedAt }
            : undefined),
          ...(patch.trustSessionId !== undefined
            ? { trustSessionId: patch.trustSessionId }
            : undefined),
          ...(patch.method !== undefined
            ? { method: patch.method }
            : undefined),
          version: sql`${schema.approvalActivations.version} + 1`,
        })
        .where(
          and(
            eq(schema.approvalActivations.id, id),
            eq(schema.approvalActivations.version, expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [existing] = await dbOf(uow, this.db)
          .select()
          .from(schema.approvalActivations)
          .where(eq(schema.approvalActivations.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(`approval activation not found: ${id}`);
        }
        throw new ConflictError(
          `approval activation version conflict: expected ${expectedVersion}, got ${existing.version}`,
        );
      }
      return mapApprovalActivation(row);
    },

    consume: async (id, at) => {
      // Compare-and-set, not read-then-write: `state = 'activated'` is part of
      // the UPDATE, so of two settlements racing on one activation exactly one
      // gets a row back and the loser is told.
      const [row] = await this.db
        .update(schema.approvalActivations)
        .set({
          state: "consumed",
          consumedAt: at,
          version: sql`${schema.approvalActivations.version} + 1`,
        })
        .where(
          and(
            eq(schema.approvalActivations.id, id),
            eq(schema.approvalActivations.state, "activated"),
          ),
        )
        .returning();
      return row ? mapApprovalActivation(row) : null;
    },
  };

  readonly comparisonChallenges: ComparisonChallengeRepository = {
    create: async (challenge, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.comparisonChallenges)
          .values({
            id: challenge.id,
            authReqId: challenge.authReqId,
            valueDigest: challenge.valueDigest,
            attempts: challenge.attempts,
            maxAttempts: challenge.maxAttempts,
            createdAt: challenge.createdAt,
            expiresAt: challenge.expiresAt,
            satisfiedAt: challenge.satisfiedAt ?? null,
            version: challenge.version,
          })
          .returning();
        if (!row)
          throw new Error("insert comparison challenge returned no row");
        return mapComparisonChallenge(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
          // `comparison_challenges_auth_req_id_uidx`. Re-issuing a code must
          // refuse rather than replace: a budget a second POST refills is not
          // a budget, and the value being guessed is six digits.
          throw new ConflictError(
            `comparison challenge already issued for request: ${challenge.authReqId}`,
          );
        }
        throw err;
      }
    },

    getForRequest: async (authReqId) => {
      const [row] = await this.db
        .select()
        .from(schema.comparisonChallenges)
        .where(eq(schema.comparisonChallenges.authReqId, authReqId))
        .limit(1);
      return row ? mapComparisonChallenge(row) : null;
    },

    consumeAttempt: async (authReqId, now) => {
      // The increment and the budget check are the same statement. Reading
      // `attempts` and writing it back would let two guesses in flight both
      // see the same remaining budget.
      const [row] = await this.db
        .update(schema.comparisonChallenges)
        .set({
          attempts: sql`${schema.comparisonChallenges.attempts} + 1`,
          version: sql`${schema.comparisonChallenges.version} + 1`,
        })
        .where(
          and(
            eq(schema.comparisonChallenges.authReqId, authReqId),
            isNull(schema.comparisonChallenges.satisfiedAt),
            sql`${schema.comparisonChallenges.expiresAt} > ${now}`,
            sql`${schema.comparisonChallenges.attempts} < ${schema.comparisonChallenges.maxAttempts}`,
          ),
        )
        .returning();
      return row ? mapComparisonChallenge(row) : null;
    },

    markSatisfied: async (authReqId, at) => {
      const [row] = await this.db
        .update(schema.comparisonChallenges)
        .set({
          satisfiedAt: at,
          version: sql`${schema.comparisonChallenges.version} + 1`,
        })
        .where(
          and(
            eq(schema.comparisonChallenges.authReqId, authReqId),
            isNull(schema.comparisonChallenges.satisfiedAt),
          ),
        )
        .returning();
      return row ? mapComparisonChallenge(row) : null;
    },
  };

  readonly approvalReceipts: ApprovalReceiptRepository = {
    create: async (receipt, uow) => {
      try {
        const [row] = await dbOf(uow, this.db)
          .insert(schema.approvalReceipts)
          .values({
            id: receipt.id,
            authReqId: receipt.authReqId,
            principalId: receipt.principalId,
            decision: receipt.decision,
            decidedByKind: receipt.decidedByKind,
            path: receipt.path,
            channelKind: receipt.channelKind,
            bindingId: receipt.bindingId ?? null,
            requestDigest: receipt.requestDigest,
            transactionDigest: receipt.transactionDigest,
            policyDigest: receipt.policyDigest,
            requiredAssurance: receipt.requiredAssurance,
            achievedAssurance: receipt.achievedAssurance,
            evidenceIds: receipt.evidenceIds,
            trustSessionId: receipt.trustSessionId ?? null,
            activationId: receipt.activationId ?? null,
            comparisonRequired: receipt.comparisonRequired,
            comparisonSatisfied: receipt.comparisonSatisfied,
            callbackDigest: receipt.callbackDigest ?? null,
            decidedAt: receipt.decidedAt,
            receiptVersion: receipt.receiptVersion,
          })
          .returning();
        if (!row) throw new Error("insert approval receipt returned no row");
        return mapApprovalReceipt(row);
      } catch (err) {
        const boundaryError: BoundaryValue = overlapCast(err);
        if (isUniqueViolation(boundaryError)) {
          throw new ConflictError(
            `approval receipt already recorded for request: ${receipt.authReqId}`,
          );
        }
        throw err;
      }
    },

    getForRequest: async (authReqId) => {
      const [row] = await this.db
        .select()
        .from(schema.approvalReceipts)
        .where(eq(schema.approvalReceipts.authReqId, authReqId))
        .limit(1);
      return row ? mapApprovalReceipt(row) : null;
    },
  };

  readonly pushSubscriptions: PushSubscriptionRepository = {
    create: async (sub, uow) => {
      // Upsert onto `endpoint_digest`, not a plain insert. A browser that
      // re-subscribes presents the same endpoint, and the same endpoint is the
      // same destination: the stored keys are replaced in place — the row
      // keeps its id and `created_at`, and a disabled row is revived — so the
      // table can never hold two rows that push the same person.
      const [row] = await dbOf(uow, this.db)
        .insert(schema.pushSubscriptions)
        .values({
          id: sub.id,
          principalId: sub.principalId,
          endpoint: sub.endpoint,
          p256dhKey: sub.p256dhKey,
          authSecret: sub.authSecret,
          endpointDigest: sub.endpointDigest,
          deviceLabel: sub.deviceLabel ?? null,
          createdAt: sub.createdAt,
          lastUsedAt: sub.lastUsedAt ?? null,
          disabledAt: sub.disabledAt ?? null,
        })
        .onConflictDoUpdate({
          target: schema.pushSubscriptions.endpointDigest,
          set: {
            principalId: sub.principalId,
            endpoint: sub.endpoint,
            p256dhKey: sub.p256dhKey,
            authSecret: sub.authSecret,
            deviceLabel: sub.deviceLabel ?? null,
            lastUsedAt: sub.lastUsedAt ?? null,
            disabledAt: sub.disabledAt ?? null,
          },
        })
        .returning();
      if (!row) throw new Error("upsert push subscription returned no row");
      return mapPushSubscription(row);
    },

    listForPrincipal: async (principalId) => {
      const rows = await this.db
        .select()
        .from(schema.pushSubscriptions)
        .where(
          and(
            eq(schema.pushSubscriptions.principalId, principalId),
            // A disabled subscription is not a destination.
            isNull(schema.pushSubscriptions.disabledAt),
          ),
        )
        .orderBy(asc(schema.pushSubscriptions.createdAt));
      return rows.map(mapPushSubscription);
    },

    getById: async (id) => {
      const [row] = await this.db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.id, id))
        .limit(1);
      return row ? mapPushSubscription(row) : null;
    },

    findByEndpointDigest: async (digest) => {
      const [row] = await this.db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.endpointDigest, digest))
        .limit(1);
      return row ? mapPushSubscription(row) : null;
    },

    disable: async (id, at) => {
      // Compare-and-set on `disabled_at is null`: only the caller that really
      // retired the subscription is told it did.
      const rows = await this.db
        .update(schema.pushSubscriptions)
        .set({ disabledAt: at })
        .where(
          and(
            eq(schema.pushSubscriptions.id, id),
            isNull(schema.pushSubscriptions.disabledAt),
          ),
        )
        .returning({ id: schema.pushSubscriptions.id });
      return rows.length === 1;
    },
  };

  readonly callbackReplays: CallbackReplayRepository = {
    claim: async (record) => {
      // The INSERT *is* the claim. `on conflict do nothing ... returning`
      // answers "have I seen this?" in the same round trip that records it, so
      // two replicas handed the same replayed callback cannot both be first.
      // A SELECT then an INSERT is the race the attacker is playing for.
      const rows = await this.db
        .insert(schema.callbackReplays)
        .values({
          id: record.id,
          providerId: record.providerId,
          callbackDigest: record.callbackDigest,
          seenAt: record.seenAt,
          expiresAt: record.expiresAt,
          authReqId: record.authReqId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: schema.callbackReplays.id });
      return rows.length === 1;
    },

    purgeExpired: async (now) => {
      const rows = await this.db
        .delete(schema.callbackReplays)
        .where(sql`${schema.callbackReplays.expiresAt} <= ${now}`)
        .returning({ id: schema.callbackReplays.id });
      return rows.length;
    },
  };

  async transaction<T>(fn: TransactionFn<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      // SAFETY: drizzle's transaction callback receives the same schema-typed
      // Database as the outer client.
      const uow = new PostgresUnitOfWork(overlapCast(tx));
      return fn(uow);
    });
  }
}

export function createPostgresRepositories(db: Database): PostgresRepositories {
  return new PostgresRepositories(db);
}

function mapProject(row: typeof schema.projects.$inferSelect): Project {
  return {
    id: row.id,
    kind: overlapCast(row.kind),
    slug: row.slug,
    displayName: row.displayName,
    state: overlapCast(row.state),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.organizationId
      ? { organizationId: row.organizationId }
      : undefined),
    ...(row.ownerPrincipalId
      ? { ownerPrincipalId: row.ownerPrincipalId }
      : undefined),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : undefined),
    ...(row.claimPolicyId ? { claimPolicyId: row.claimPolicyId } : undefined),
    ...(row.sealedStoreTombName
      ? { sealedStoreTombName: row.sealedStoreTombName }
      : undefined),
    ...(row.pagesVaultFolderId
      ? { pagesVaultFolderId: row.pagesVaultFolderId }
      : undefined),
  };
}

function projectRowValues(project: Project) {
  return {
    id: project.id,
    kind: project.kind,
    organizationId: project.organizationId ?? null,
    ownerPrincipalId: project.ownerPrincipalId ?? null,
    slug: project.slug,
    displayName: project.displayName,
    state: project.state,
    expiresAt: project.expiresAt ?? null,
    claimPolicyId: project.claimPolicyId ?? null,
    sealedStoreTombName: project.sealedStoreTombName ?? null,
    pagesVaultFolderId: project.pagesVaultFolderId ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function mapMembership(
  row: typeof schema.projectMemberships.$inferSelect,
): ProjectMembership {
  return {
    projectId: row.projectId,
    principalId: row.principalId,
    role: overlapCast(row.role),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Postgres project rows behind the `ProjectStore` interface. */
export class PostgresProjectStore implements ProjectStore {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<Project | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .limit(1);
    return row ? mapProject(row) : undefined;
  }

  /** Full-row upsert — the durable equivalent of the former Map `set`. */
  async set(id: string, project: Project): Promise<void> {
    const values = projectRowValues({ ...project, id });
    const { id: _id, ...update } = values;
    await this.db
      .insert(schema.projects)
      .values(values)
      .onConflictDoUpdate({ target: schema.projects.id, set: update });
  }

  async listByOwner(ownerPrincipalId: string): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.ownerPrincipalId, ownerPrincipalId));
    return rows.map(mapProject);
  }

  async findPersonalByOwner(
    ownerPrincipalId: string,
  ): Promise<Project | undefined> {
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.kind, "personal"),
          eq(schema.projects.ownerPrincipalId, ownerPrincipalId),
        ),
      );
    const live = rows.find(
      (row) => row.state !== "deleted" && row.state !== "deleting",
    );
    return live ? mapProject(live) : undefined;
  }

  async ensurePersonal(
    principalId: string,
    organizationId?: string,
    now: Date = new Date(),
  ): Promise<EnsurePersonalProjectResult> {
    const candidate = buildPersonalProject(principalId, now, organizationId);
    // One statement, racing sessions converge: the INSERT targets the
    // `projects_personal_owner_uidx` partial unique index, and on conflict a
    // no-op DO UPDATE lets RETURNING hand back the row that already won.
    // `xmax = 0` distinguishes a fresh insert from the pre-existing row.
    const [row] = await this.db
      .insert(schema.projects)
      .values(projectRowValues(candidate))
      .onConflictDoUpdate({
        target: schema.projects.ownerPrincipalId,
        targetWhere: sql`kind = 'personal'`,
        set: { updatedAt: sql`${schema.projects.updatedAt}` },
      })
      .returning({
        ...getTableColumns(schema.projects),
        inserted: sql<boolean>`(xmax = 0)`,
      });
    if (!row) throw new Error("ensurePersonal returned no row");
    const project = mapProject(row);
    if (row.inserted) {
      await this.db
        .insert(schema.projectMemberships)
        .values({
          projectId: project.id,
          principalId,
          role: "owner",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
    return { project, created: Boolean(row.inserted) };
  }
}

/** Postgres membership rows behind the `ProjectMembershipStore` interface. */
export class PostgresProjectMembershipStore implements ProjectMembershipStore {
  constructor(private readonly db: Database) {}

  async find(
    projectId: string,
    principalId: string,
  ): Promise<ProjectMembership | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.projectMemberships)
      .where(
        and(
          eq(schema.projectMemberships.projectId, projectId),
          eq(schema.projectMemberships.principalId, principalId),
        ),
      )
      .limit(1);
    return row ? mapMembership(row) : undefined;
  }

  async upsert(membership: ProjectMembership): Promise<ProjectMembership> {
    const [row] = await this.db
      .insert(schema.projectMemberships)
      .values({
        projectId: membership.projectId,
        principalId: membership.principalId,
        role: membership.role,
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.projectMemberships.projectId,
          schema.projectMemberships.principalId,
        ],
        set: {
          role: membership.role,
          createdAt: membership.createdAt,
          updatedAt: membership.updatedAt,
        },
      })
      .returning();
    if (!row) throw new Error("upsert project membership returned no row");
    return mapMembership(row);
  }

  async remove(projectId: string, principalId: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.projectMemberships)
      .where(
        and(
          eq(schema.projectMemberships.projectId, projectId),
          eq(schema.projectMemberships.principalId, principalId),
        ),
      )
      .returning({ projectId: schema.projectMemberships.projectId });
    return rows.length > 0;
  }

  async removeByProject(projectId: string): Promise<number> {
    const rows = await this.db
      .delete(schema.projectMemberships)
      .where(eq(schema.projectMemberships.projectId, projectId))
      .returning({ projectId: schema.projectMemberships.projectId });
    return rows.length;
  }

  async listByProject(projectId: string): Promise<ProjectMembership[]> {
    const rows = await this.db
      .select()
      .from(schema.projectMemberships)
      .where(eq(schema.projectMemberships.projectId, projectId));
    return rows.map(mapMembership);
  }

  async listByPrincipal(principalId: string): Promise<ProjectMembership[]> {
    const rows = await this.db
      .select()
      .from(schema.projectMemberships)
      .where(eq(schema.projectMemberships.principalId, principalId));
    return rows.map(mapMembership);
  }

  async countOwners(projectId: string): Promise<number> {
    const rows = await this.db
      .select({ principalId: schema.projectMemberships.principalId })
      .from(schema.projectMemberships)
      .where(
        and(
          eq(schema.projectMemberships.projectId, projectId),
          eq(schema.projectMemberships.role, "owner"),
        ),
      );
    return rows.length;
  }
}

export function createPostgresProjectStores(db: Database): ProjectStores {
  return {
    projects: new PostgresProjectStore(db),
    projectMemberships: new PostgresProjectMembershipStore(db),
  };
}

function mapOrganization(
  row: typeof schema.organizations.$inferSelect,
): Organization {
  return normalizeOrganizationRow({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    state: overlapCast(row.state),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.ssoIssuer ? { ssoIssuer: row.ssoIssuer } : undefined),
    ...(row.ssoClientId ? { ssoClientId: row.ssoClientId } : undefined),
    ...(row.ssoClientSecret
      ? { ssoClientSecret: row.ssoClientSecret }
      : undefined),
    ...(row.samlIssuer ? { samlIssuer: row.samlIssuer } : undefined),
    ...(row.samlMetadataUrl
      ? { samlMetadataUrl: row.samlMetadataUrl }
      : undefined),
    ...(row.samlMetadataXml
      ? { samlMetadataXml: row.samlMetadataXml }
      : undefined),
    ...(row.provisioningEnabled ? { provisioningEnabled: true } : undefined),
  });
}

function organizationRowValues(organization: Organization) {
  return {
    id: organization.id,
    slug: organization.slug,
    displayName: organization.displayName,
    state: organization.state,
    createdBy: organization.createdBy,
    ssoIssuer: organization.ssoIssuer ?? null,
    ssoClientId: organization.ssoClientId ?? null,
    ssoClientSecret: organization.ssoClientSecret ?? null,
    samlIssuer: organization.samlIssuer ?? null,
    samlMetadataUrl: organization.samlMetadataUrl ?? null,
    samlMetadataXml: organization.samlMetadataXml ?? null,
    provisioningEnabled: organization.provisioningEnabled ?? false,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
  };
}

/** `rtrim(col, '/')` — the SQL half of {@link normalizeIssuer}. */
function normalizedIssuerColumn(column: Column) {
  return sql<string>`rtrim(${column}, '/')`;
}

function mapOrganizationMembership(
  row: typeof schema.organizationMemberships.$inferSelect,
): OrganizationMembership {
  return {
    organizationId: row.organizationId,
    principalId: row.principalId,
    role: overlapCast(row.role),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Postgres organization rows behind the `OrganizationStore` interface. */
export class PostgresOrganizationStore implements OrganizationStore {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<Organization | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, id))
      .limit(1);
    return row ? mapOrganization(row) : undefined;
  }

  /** Full-row upsert — the durable equivalent of the former Map `set`. */
  async set(id: string, organization: Organization): Promise<void> {
    const values = organizationRowValues({ ...organization, id });
    const { id: _id, ...update } = values;
    await this.db
      .insert(schema.organizations)
      .values(values)
      .onConflictDoUpdate({ target: schema.organizations.id, set: update });
  }

  async getBySlug(slug: string): Promise<Organization | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1);
    return row ? mapOrganization(row) : undefined;
  }

  async findByIssuer(issuer: string): Promise<Organization | undefined> {
    const target = normalizeIssuer(issuer);
    if (!target) return undefined;
    // The stored spelling is whatever the operator typed; the comparison is
    // normalized on both sides so a trailing slash never hides a tenant.
    const [row] = await this.db
      .select()
      .from(schema.organizations)
      .where(
        or(
          eq(normalizedIssuerColumn(schema.organizations.ssoIssuer), target),
          eq(normalizedIssuerColumn(schema.organizations.samlIssuer), target),
        ),
      )
      .orderBy(
        asc(schema.organizations.createdAt),
        asc(schema.organizations.id),
      )
      .limit(1);
    return row ? mapOrganization(row) : undefined;
  }

  async listByCreator(principalId: string): Promise<Organization[]> {
    const rows = await this.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.createdBy, principalId));
    return rows.map(mapOrganization);
  }
}

/** Postgres membership rows behind the `OrganizationMembershipStore` interface. */
export class PostgresOrganizationMembershipStore
  implements OrganizationMembershipStore
{
  constructor(private readonly db: Database) {}

  async find(
    organizationId: string,
    principalId: string,
  ): Promise<OrganizationMembership | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
        ),
      )
      .limit(1);
    return row ? mapOrganizationMembership(row) : undefined;
  }

  async upsert(
    membership: OrganizationMembership,
  ): Promise<OrganizationMembership> {
    const [row] = await this.db
      .insert(schema.organizationMemberships)
      .values({
        organizationId: membership.organizationId,
        principalId: membership.principalId,
        role: membership.role,
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.organizationMemberships.organizationId,
          schema.organizationMemberships.principalId,
        ],
        set: {
          role: membership.role,
          createdAt: membership.createdAt,
          updatedAt: membership.updatedAt,
        },
      })
      .returning();
    if (!row) throw new Error("upsert organization membership returned no row");
    return mapOrganizationMembership(row);
  }

  async remove(organizationId: string, principalId: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.principalId, principalId),
        ),
      )
      .returning({
        organizationId: schema.organizationMemberships.organizationId,
      });
    return rows.length > 0;
  }

  async listByOrganization(
    organizationId: string,
  ): Promise<OrganizationMembership[]> {
    const rows = await this.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.organizationId, organizationId));
    return rows.map(mapOrganizationMembership);
  }

  async listByPrincipal(
    principalId: string,
  ): Promise<OrganizationMembership[]> {
    const rows = await this.db
      .select()
      .from(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.principalId, principalId));
    return rows.map(mapOrganizationMembership);
  }

  async countOwners(organizationId: string): Promise<number> {
    const rows = await this.db
      .select({ principalId: schema.organizationMemberships.principalId })
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organizationId),
          eq(schema.organizationMemberships.role, "owner"),
        ),
      );
    return rows.length;
  }
}

export function createPostgresOrganizationStores(
  db: Database,
): OrganizationStores {
  return {
    organizations: new PostgresOrganizationStore(db),
    organizationMemberships: new PostgresOrganizationMembershipStore(db),
  };
}

export type { postgres };
