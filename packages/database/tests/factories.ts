import { randomBytes, randomUUID } from "node:crypto";
import type {
  ApprovalActivation,
  ApprovalReceipt,
  AuditEvent,
  CallbackReplayRecord,
  ClaimItem,
  ClaimSession,
  ComparisonChallenge,
  ExternalChannelBinding,
  ExternalIdentity,
  NotificationDelivery,
  NotificationPreferences,
  Principal,
  Project,
} from "@opensesame/os-domain";
import type {
  ChannelBindingChallenge,
  PushSubscription,
} from "../src/repos/interfaces.js";

export function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date();
  return {
    id: overrides.id ?? `prj_${randomUUID()}`,
    kind: "standard",
    slug: overrides.slug ?? `proj-${randomUUID().slice(0, 8)}`,
    displayName: "Test Project",
    state: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  const now = new Date();
  return {
    id: overrides.id ?? randomUUID(),
    state: "active",
    assurance: "provisional",
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

export function makeIdentity(
  principalId: string,
  overrides: Partial<ExternalIdentity> = {},
): ExternalIdentity {
  return {
    id: overrides.id ?? randomUUID(),
    principalId,
    kind: "oidc",
    issuer: "https://idp.example",
    subject: overrides.subject ?? randomUUID(),
    assurance: "verified",
    linkedAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

export function makeClaim(overrides: Partial<ClaimSession> = {}): ClaimSession {
  const now = new Date();
  return {
    id: overrides.id ?? randomUUID(),
    type: "resource_bundle",
    state: "pending",
    // Random default: claim_sessions.token_digest is unique in Postgres, and
    // tests in the Postgres suites share one database per file.
    tokenDigest: overrides.tokenDigest ?? new Uint8Array(randomBytes(8)),
    targetManifest: {},
    targetManifestDigest: "sha256:deadbeef",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    version: 1,
    ...overrides,
  };
}

export function makeClaimItem(
  claimId: string,
  overrides: Partial<ClaimItem> = {},
): ClaimItem {
  return {
    id: overrides.id ?? randomUUID(),
    claimId,
    targetType: "project",
    targetId: randomUUID(),
    required: true,
    dependencies: [],
    requestedAction: "attach",
    state: "pending",
    snapshotVersion: 1,
    snapshotDigest: "sha256:cafe",
    ...overrides,
  };
}

export function makeAuditEvent(
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return {
    id: overrides.id ?? randomUUID(),
    occurredAt: new Date(),
    eventType: "principal.created",
    outcome: "succeeded",
    correlationId: randomUUID(),
    metadata: {},
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * External notification channels and approval ceremonies (ADR 0081)
 * ------------------------------------------------------------------ */

/**
 * Provider tenant and subject default to fresh random values: the binding
 * table holds (kind, provider, tenant, subject) unique, and the Postgres
 * suites share one database per file.
 */
export function makeChannelBinding(
  principalId: string,
  overrides: Partial<ExternalChannelBinding> = {},
): ExternalChannelBinding {
  const now = new Date();
  return {
    id: overrides.id ?? `chb_${randomUUID()}`,
    principalId,
    kind: "slack",
    providerId: "slack",
    providerTenantId:
      overrides.providerTenantId ?? `T_${randomUUID().slice(0, 8)}`,
    providerSubjectId:
      overrides.providerSubjectId ?? `U_${randomUUID().slice(0, 8)}`,
    state: "active",
    verification: "provider_oauth_install",
    createdAt: now,
    metadata: {},
    version: 1,
    ...overrides,
  };
}

export function makeBindingChallenge(
  principalId: string,
  overrides: Partial<ChannelBindingChallenge> = {},
): ChannelBindingChallenge {
  const now = new Date();
  return {
    id: overrides.id ?? `cbc_${randomUUID()}`,
    principalId,
    kind: "slack",
    providerId: "slack",
    // A digest, never the nonce — the store never sees the plaintext.
    nonceDigest: `sha256:${randomUUID()}`,
    attempts: 0,
    maxAttempts: 3,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    version: 1,
    ...overrides,
  };
}

export function makeNotificationPreferences(
  principalId: string,
  overrides: Partial<NotificationPreferences> = {},
): NotificationPreferences {
  return {
    principalId,
    byClass: {
      authorization_request: { channels: ["in_app"], fanOut: false },
    },
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  };
}

export function makeNotificationDelivery(
  principalId: string,
  overrides: Partial<NotificationDelivery> = {},
): NotificationDelivery {
  const now = new Date();
  return {
    id: overrides.id ?? `nd_${randomUUID()}`,
    principalId,
    kind: "slack",
    notificationClass: "authorization_request",
    eventType: "authorization_request.created",
    outboxEventId: overrides.outboxEventId ?? randomUUID(),
    payload: {},
    confidentiality: "minimal",
    state: "pending",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    ...overrides,
  };
}

export function makeApprovalActivation(
  principalId: string,
  overrides: Partial<ApprovalActivation> = {},
): ApprovalActivation {
  const now = new Date();
  return {
    id: overrides.id ?? `act_${randomUUID()}`,
    authReqId: overrides.authReqId ?? `areq_${randomUUID()}`,
    principalId,
    transactionDigest: `v1:${randomUUID()}`,
    decision: "approved",
    policyDigest: `v1:${randomUUID()}`,
    channelKind: "in_app",
    // A digest, never the challenge; `approval_activations` holds it unique.
    challengeDigest: overrides.challengeDigest ?? `sha256:${randomUUID()}`,
    state: "activated",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    version: 1,
    ...overrides,
  };
}

export function makeComparisonChallenge(
  overrides: Partial<ComparisonChallenge> = {},
): ComparisonChallenge {
  const now = new Date();
  return {
    id: overrides.id ?? `cmp_${randomUUID()}`,
    authReqId: overrides.authReqId ?? `areq_${randomUUID()}`,
    // The plaintext lives in one response body and is never persisted.
    valueDigest: `sha256:${randomUUID()}`,
    attempts: 0,
    maxAttempts: 3,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    version: 1,
    ...overrides,
  };
}

export function makeApprovalReceipt(
  principalId: string,
  overrides: Partial<ApprovalReceipt> = {},
): ApprovalReceipt {
  return {
    id: overrides.id ?? `rcpt_${randomUUID()}`,
    authReqId: overrides.authReqId ?? `areq_${randomUUID()}`,
    principalId,
    decision: "approved",
    decidedByKind: "human",
    path: "in_app",
    channelKind: "in_app",
    requestDigest: `v2:${randomUUID()}`,
    transactionDigest: `v1:${randomUUID()}`,
    policyDigest: `v1:${randomUUID()}`,
    requiredAssurance: ["user_verification"],
    achievedAssurance: ["user_verification"],
    evidenceIds: [],
    comparisonRequired: false,
    comparisonSatisfied: false,
    decidedAt: new Date(),
    receiptVersion: 1,
    ...overrides,
  };
}

export function makeCallbackReplay(
  overrides: Partial<CallbackReplayRecord> = {},
): CallbackReplayRecord {
  const now = new Date();
  return {
    id: overrides.id ?? `slack:${randomUUID()}`,
    providerId: "slack",
    callbackDigest: `sha256:${randomUUID()}`,
    seenAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    ...overrides,
  };
}

/**
 * `endpointDigest` defaults to a fresh random value: it is unique in Postgres
 * and re-subscribing replaces rather than duplicates, so a test that wants the
 * replace path passes the same digest deliberately.
 */
export function makePushSubscription(
  principalId: string,
  overrides: Partial<PushSubscription> = {},
): PushSubscription {
  return {
    id: overrides.id ?? `psub_${randomUUID()}`,
    principalId,
    endpoint: overrides.endpoint ?? `https://push.example/${randomUUID()}`,
    p256dhKey: `p256dh_${randomUUID()}`,
    // Secret material in the fixture as in production: it exists so the
    // encryption can happen, and it never leaves the repository layer.
    authSecret: `auth_${randomUUID()}`,
    endpointDigest: overrides.endpointDigest ?? `sha256:${randomUUID()}`,
    createdAt: new Date(),
    ...overrides,
  };
}
