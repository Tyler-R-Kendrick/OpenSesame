import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** bytea column mapped to Uint8Array */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value);
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
};

export const principals = pgTable(
  "principals",
  {
    id: text("id").primaryKey(),
    state: text("state").notNull(),
    assurance: text("assurance").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    suspendedAt: timestamp("suspended_at", {
      withTimezone: true,
      mode: "date",
    }),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    check(
      "principals_state_check",
      sql`${t.state} in ('provisional','active','suspended','closed')`,
    ),
    check(
      "principals_assurance_check",
      sql`${t.assurance} in ('provisional','self_asserted','verified','mfa','phishing_resistant','enterprise_managed','workload_attested')`,
    ),
  ],
);

/**
 * External identities.
 * Unique on (kind, issuer, tenant, subject) — tenant coalesced to '' for uniqueness.
 * NO unique constraint on email.
 */
export const externalIdentities = pgTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    issuer: text("issuer").notNull(),
    tenant: text("tenant").notNull().default(""),
    subject: text("subject").notNull(),
    displayHint: text("display_hint"),
    emailNormalized: text("email_normalized"),
    emailVerified: boolean("email_verified"),
    assurance: text("assurance").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", {
      withTimezone: true,
      mode: "date",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => [
    uniqueIndex("external_identities_kind_issuer_tenant_subject_uidx").on(
      t.kind,
      t.issuer,
      t.tenant,
      t.subject,
    ),
    index("external_identities_principal_id_idx").on(t.principalId),
    index("external_identities_email_normalized_idx").on(t.emailNormalized),
  ],
);

/** Better Auth user id → OpenSesame principal mapping (canonical id never changes). */
export const betterAuthSubjects = pgTable("better_auth_subjects", {
  betterAuthUserId: text("better_auth_user_id").primaryKey(),
  principalId: text("principal_id")
    .notNull()
    .references(() => principals.id, { onDelete: "cascade" }),
  linkedAt: timestamp("linked_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    state: text("state").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => principals.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("organizations_slug_uidx").on(t.slug),
    check(
      "organizations_state_check",
      sql`${t.state} in ('provisional','active','suspended','deleted')`,
    ),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("teams_org_slug_uidx").on(t.organizationId, t.slug),
    index("teams_organization_id_idx").on(t.organizationId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id),
    ownerPrincipalId: text("owner_principal_id").references(
      () => principals.id,
    ),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    state: text("state").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    claimPolicyId: text("claim_policy_id"),
    ...timestamps,
  },
  (t) => [
    index("projects_organization_id_idx").on(t.organizationId),
    index("projects_owner_principal_id_idx").on(t.ownerPrincipalId),
    check(
      "projects_state_check",
      sql`${t.state} in ('provisional','active','expired','deleting','deleted')`,
    ),
  ],
);

export const resources = pgTable(
  "resources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    organizationId: text("organization_id").references(() => organizations.id),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    ownerPrincipalId: text("owner_principal_id").references(
      () => principals.id,
    ),
    manifest: jsonb("manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index("resources_project_id_idx").on(t.projectId),
    index("resources_organization_id_idx").on(t.organizationId),
    check(
      "resources_state_check",
      sql`${t.state} in ('provisional','active','expired','deleting','deleted','quarantined')`,
    ),
  ],
);

export const ownerships = pgTable(
  "ownerships",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    relation: text("relation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    sourceClaimId: text("source_claim_id"),
  },
  (t) => [
    uniqueIndex("ownerships_subject_object_relation_uidx").on(
      t.subjectType,
      t.subjectId,
      t.objectType,
      t.objectId,
      t.relation,
    ),
    index("ownerships_object_idx").on(t.objectType, t.objectId),
    check(
      "ownerships_subject_type_check",
      sql`${t.subjectType} in ('principal','organization')`,
    ),
    check(
      "ownerships_object_type_check",
      sql`${t.objectType} in ('project','resource','agent','device','connection')`,
    ),
    check(
      "ownerships_relation_check",
      sql`${t.relation} in ('owner','custodian','administrator')`,
    ),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    ownerPrincipalId: text("owner_principal_id").references(
      () => principals.id,
    ),
    displayName: text("display_name").notNull(),
    provider: text("provider"),
    softwareIdentity: text("software_identity"),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "agents_state_check",
      sql`${t.state} in ('provisional','claimed','suspended','revoked')`,
    ),
    index("agents_owner_principal_id_idx").on(t.ownerPrincipalId),
  ],
);

export const agentInstances = pgTable(
  "agent_instances",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    publicKeyJkt: text("public_key_jkt").notNull(),
    clientId: text("client_id"),
    runtimeProvider: text("runtime_provider"),
    attestationDigest: text("attestation_digest"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("agent_instances_agent_id_idx").on(t.agentId),
    uniqueIndex("agent_instances_public_key_jkt_uidx").on(t.publicKeyJkt),
  ],
);

export const delegations = pgTable(
  "delegations",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    projectId: text("project_id").references(() => projects.id),
    grantId: text("grant_id"),
    relationship: text("relationship").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("delegations_principal_id_idx").on(t.principalId),
    index("delegations_agent_id_idx").on(t.agentId),
    check(
      "delegations_relationship_check",
      sql`${t.relationship} in ('owns','operates','delegates_to')`,
    ),
  ],
);

export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    /** Registering principal — reads and mutations are fenced to them. */
    ownerPrincipalId: text("owner_principal_id").references(
      () => principals.id,
    ),
    admissionMode: text("admission_mode").notNull(),
    displayName: text("display_name").notNull(),
    redirectUris: jsonb("redirect_uris")
      .$type<string[]>()
      .notNull()
      .default([]),
    sectorIdentifier: text("sector_identifier").notNull(),
    grantTypes: jsonb("grant_types").$type<string[]>().notNull().default([]),
    responseTypes: jsonb("response_types")
      .$type<string[]>()
      .notNull()
      .default([]),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),
    allowedScopes: jsonb("allowed_scopes")
      .$type<string[]>()
      .notNull()
      .default([]),
    allowedResources: jsonb("allowed_resources")
      .$type<string[]>()
      .notNull()
      .default([]),
    metadataUri: text("metadata_uri"),
    metadataDigest: text("metadata_digest"),
    state: text("state").notNull(),
    ...timestamps,
  },
  (t) => [
    check(
      "oauth_clients_admission_mode_check",
      sql`${t.admissionMode} in ('pre_registered','dynamic_registration','client_metadata_document','origin_profile')`,
    ),
    check(
      "oauth_clients_state_check",
      sql`${t.state} in ('active','suspended','revoked')`,
    ),
    index("oauth_clients_owner_principal_id_idx").on(t.ownerPrincipalId),
  ],
);

export const pairwiseSubjects = pgTable(
  "pairwise_subjects",
  {
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    sectorIdentifier: text("sector_identifier").notNull(),
    subject: text("subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.sectorIdentifier] }),
    uniqueIndex("pairwise_subjects_sector_subject_uidx").on(
      t.sectorIdentifier,
      t.subject,
    ),
  ],
);

export const consents = pgTable(
  "consents",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id),
    sectorIdentifier: text("sector_identifier").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    resources: jsonb("resources").$type<string[]>().notNull().default([]),
    claims: jsonb("claims").$type<string[]>().notNull().default([]),
    organizationId: text("organization_id").references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    version: integer("version").notNull().default(1),
  },
  (t) => [index("consents_principal_client_idx").on(t.principalId, t.clientId)],
);

export const provisionalSessions = pgTable(
  "provisional_sessions",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    instanceKeyJkt: text("instance_key_jkt"),
    quotaProfile: text("quota_profile").notNull(),
    allowedActions: jsonb("allowed_actions")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("provisional_sessions_principal_id_idx").on(t.principalId),
    index("provisional_sessions_active_idx")
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} is null and ${t.claimedAt} is null`),
  ],
);

export const claimSessions = pgTable(
  "claim_sessions",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    state: text("state").notNull(),
    creatorPrincipalId: text("creator_principal_id").references(
      () => principals.id,
    ),
    creatorAgentId: text("creator_agent_id").references(() => agents.id),
    creatorInstanceId: text("creator_instance_id").references(
      () => agentInstances.id,
    ),
    tokenDigest: bytea("token_digest").notNull(),
    userCodeDigest: bytea("user_code_digest"),
    proofKeyJkt: text("proof_key_jkt"),
    targetManifest: jsonb("target_manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    targetManifestDigest: text("target_manifest_digest").notNull(),
    requestedDestination: jsonb("requested_destination").$type<
      Record<string, unknown>
    >(),
    requestedGrant: jsonb("requested_grant").$type<Record<string, unknown>>(),
    presentedAt: timestamp("presented_at", {
      withTimezone: true,
      mode: "date",
    }),
    authenticatedAt: timestamp("authenticated_at", {
      withTimezone: true,
      mode: "date",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    completedByPrincipalId: text("completed_by_principal_id").references(
      () => principals.id,
    ),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("claim_sessions_token_digest_uidx").on(t.tokenDigest),
    // Partial unique index: only one active claim may hold a given user code
    uniqueIndex("claim_sessions_active_user_code_uidx")
      .on(t.userCodeDigest)
      .where(
        sql`${t.userCodeDigest} is not null and ${t.state} in ('pending','presented','authenticated','reviewed') and ${t.revokedAt} is null`,
      ),
    index("claim_sessions_active_idx")
      .on(t.state, t.expiresAt)
      .where(
        sql`${t.state} in ('pending','presented','authenticated','reviewed') and ${t.revokedAt} is null`,
      ),
    check(
      "claim_sessions_type_check",
      sql`${t.type} in ('principal','agent','project','resource_bundle','device','connection')`,
    ),
    check(
      "claim_sessions_state_check",
      sql`${t.state} in ('pending','presented','authenticated','reviewed','completed','denied','revoked','expired')`,
    ),
  ],
);

export const claimItems = pgTable(
  "claim_items",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id")
      .notNull()
      .references(() => claimSessions.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    required: boolean("required").notNull().default(true),
    dependencies: jsonb("dependencies").$type<string[]>().notNull().default([]),
    requestedAction: text("requested_action").notNull(),
    state: text("state").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
  },
  (t) => [
    index("claim_items_claim_id_idx").on(t.claimId),
    check(
      "claim_items_target_type_check",
      sql`${t.targetType} in ('project','resource','agent','device','connection')`,
    ),
    check(
      "claim_items_action_check",
      sql`${t.requestedAction} in ('attach','transfer','delegate','verify')`,
    ),
    check(
      "claim_items_state_check",
      sql`${t.state} in ('pending','accepted','rejected')`,
    ),
  ],
);

/** Domain projection of RFC 8628 device authorization (oidc-provider remains source of truth for protocol). */
export const deviceAuthorizationSessions = pgTable(
  "device_authorization_sessions",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id),
    deviceCodeDigest: bytea("device_code_digest").notNull(),
    userCodeDigest: bytea("user_code_digest").notNull(),
    requestedScopes: jsonb("requested_scopes")
      .$type<string[]>()
      .notNull()
      .default([]),
    requestedResources: jsonb("requested_resources")
      .$type<string[]>()
      .notNull()
      .default([]),
    proofKeyJkt: text("proof_key_jkt"),
    state: text("state").notNull(),
    intervalSeconds: integer("interval_seconds").notNull().default(5),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    approvedByPrincipalId: text("approved_by_principal_id").references(
      () => principals.id,
    ),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    pollCount: integer("poll_count").notNull().default(0),
    lastPolledAt: timestamp("last_polled_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => [
    uniqueIndex("device_auth_device_code_digest_uidx").on(t.deviceCodeDigest),
    uniqueIndex("device_auth_active_user_code_uidx")
      .on(t.userCodeDigest)
      .where(sql`${t.state} = 'pending'`),
    index("device_auth_active_idx")
      .on(t.state, t.expiresAt)
      .where(sql`${t.state} = 'pending'`),
    check(
      "device_auth_state_check",
      sql`${t.state} in ('pending','approved','denied','expired','consumed')`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    eventType: text("event_type").notNull(),
    principalId: text("principal_id"),
    actorType: text("actor_type"),
    actorId: text("actor_id"),
    agentInstanceId: text("agent_instance_id"),
    clientId: text("client_id"),
    organizationId: text("organization_id"),
    projectId: text("project_id"),
    claimId: text("claim_id"),
    sessionId: text("session_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    outcome: text("outcome").notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Hash chain over the trail: each event names the digest of the one before it. */
    previousDigest: text("previous_digest"),
    digest: text("digest"),
  },
  (t) => [
    index("audit_events_occurred_at_idx").on(t.occurredAt),
    index("audit_events_correlation_id_idx").on(t.correlationId),
    index("audit_events_principal_id_idx").on(t.principalId),
    check(
      "audit_events_outcome_check",
      sql`${t.outcome} in ('succeeded','failed','denied')`,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [
    index("outbox_events_unpublished_idx")
      .on(t.availableAt)
      .where(sql`${t.publishedAt} is null`),
    index("outbox_events_aggregate_idx").on(t.aggregateType, t.aggregateId),
  ],
);

export const schema = {
  principals,
  externalIdentities,
  betterAuthSubjects,
  organizations,
  teams,
  projects,
  resources,
  ownerships,
  agents,
  agentInstances,
  delegations,
  oauthClients,
  pairwiseSubjects,
  consents,
  provisionalSessions,
  claimSessions,
  claimItems,
  deviceAuthorizationSessions,
  auditEvents,
  outboxEvents,
};

/**
 * oidc-provider adapter storage.
 *
 * The provider's own models — sessions, authorization codes, refresh tokens,
 * device flows, grants — held where they survive a restart. Running the issuer on
 * the in-memory adapter means every deploy silently invalidates live sessions and
 * consumed codes stop being remembered as consumed.
 */
export const oidcPayloads = pgTable(
  "oidc_payloads",
  {
    model: text("model").notNull(),
    id: text("id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Null for models the provider stores without a TTL. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    /** Set once a single-use artifact (an authorization code) has been redeemed. */
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    /** Interaction/session lookup keys, and the grant a token hangs off. */
    uid: text("uid"),
    userCode: text("user_code"),
    grantId: text("grant_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.model, t.id] }),
    index("oidc_payloads_uid_idx").on(t.model, t.uid),
    index("oidc_payloads_user_code_idx").on(t.model, t.userCode),
    index("oidc_payloads_grant_id_idx").on(t.grantId),
    index("oidc_payloads_expires_at_idx").on(t.expiresAt),
  ],
);
