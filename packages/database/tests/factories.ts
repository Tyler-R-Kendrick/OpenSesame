import { randomBytes, randomUUID } from "node:crypto";
import type {
  AuditEvent,
  ClaimItem,
  ClaimSession,
  ExternalIdentity,
  Principal,
} from "@opensesame/os-domain";

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
