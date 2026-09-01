import type { JsonObject } from "@opensesame/os-domain";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
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
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
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

/*
 * Better Auth's own tables (ADR 0057).
 *
 * Declared here, and named with the `better_auth_` prefix `better_auth_subjects`
 * already uses, because they are the upstream library's internal storage and
 * nothing else may read them as identity. Canonical identity is `principals`;
 * these rows reach it only through the `better_auth_subjects` mapping, which is
 * the whole point of keeping the library behind a bridge (T33). The prefix also
 * keeps Better Auth's default model names — `user`, `session`, `account` — from
 * claiming three of the most generic table names in a shared database, which is
 * why every one below is registered with an explicit `modelName`.
 *
 * The field *keys* are Better Auth's camelCase names because its Drizzle
 * adapter looks up columns by them; the column names stay snake_case like the
 * rest of this schema. Shapes are `getAuthTables` in `@better-auth/core` — do
 * not edit one without re-reading it there.
 *
 * Before this existed, `betterAuth()` was constructed with no `database` and
 * fell back to the in-memory adapter, so every magic link was invalidated by a
 * deploy and only ever worked on the replica that minted it.
 */
export const betterAuthUsers = pgTable("better_auth_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  ...timestamps,
});

export const betterAuthSessions = pgTable(
  "better_auth_sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    token: text("token").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => betterAuthUsers.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("better_auth_sessions_token_uidx").on(t.token),
    index("better_auth_sessions_user_idx").on(t.userId),
  ],
);

/** Passwordless relying parties. API secrets are write-only SHA-256 digests. */
export const authenticationApplications = pgTable(
  "authentication_applications",
  {
    id: text("id").primaryKey(),
    ownerPrincipalId: text("owner_principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    displayName: text("display_name").notNull(),
    rpId: text("rp_id").notNull(),
    origins: jsonb("origins").$type<string[]>().notNull(),
    secretHash: text("secret_hash").notNull(),
    secretPrefix: text("secret_prefix").notNull(),
    apiKeys: jsonb("api_keys")
      .$type<
        Array<{
          id: string;
          secretHash: string;
          secretPrefix: string;
          state: "active" | "locked";
          createdAt: string;
        }>
      >()
      .notNull()
      .default([]),
    configurations: jsonb("configurations")
      .$type<
        Array<{
          purpose: string;
          timeToLiveSeconds: number;
          userVerification: "discouraged" | "preferred" | "required";
          hints: Array<"client-device" | "hybrid" | "security-key">;
        }>
      >()
      .notNull()
      .default([]),
    manualTokensEnabled: boolean("manual_tokens_enabled")
      .notNull()
      .default(false),
    magicLinksEnabled: boolean("magic_links_enabled").notNull().default(false),
    state: text("state").notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    index("authentication_applications_owner_idx").on(t.ownerPrincipalId),
    index("authentication_applications_org_idx").on(t.organizationId),
    check(
      "authentication_applications_state_check",
      sql`${t.state} in ('active','suspended','revoked')`,
    ),
  ],
);

/** Application-local users; no OpenSesame principal is minted for them. */
export const authenticationUsers = pgTable(
  "authentication_users",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => authenticationApplications.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull(),
    displayName: text("display_name").notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.userId] }),
    index("authentication_users_app_idx").on(t.applicationId),
  ],
);

/** Alias uniqueness is enforced by the database, per application. */
export const authenticationAliases = pgTable(
  "authentication_aliases",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => authenticationApplications.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    userId: text("user_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.alias] }),
    index("authentication_aliases_user_idx").on(t.applicationId, t.userId),
    foreignKey({
      columns: [t.applicationId, t.userId],
      foreignColumns: [
        authenticationUsers.applicationId,
        authenticationUsers.userId,
      ],
      name: "authentication_aliases_user_fk",
    }).onDelete("cascade"),
  ],
);

/** WebAuthn public keys and monotonic signature counters. */
export const authenticationCredentials = pgTable(
  "authentication_credentials",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => authenticationApplications.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull(),
    userId: text("user_id").notNull(),
    publicKey: bytea("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: jsonb("transports").$type<string[]>().notNull().default([]),
    name: text("name"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.credentialId] }),
    index("authentication_credentials_user_idx").on(t.applicationId, t.userId),
    foreignKey({
      columns: [t.applicationId, t.userId],
      foreignColumns: [
        authenticationUsers.applicationId,
        authenticationUsers.userId,
      ],
      name: "authentication_credentials_user_fk",
    }).onDelete("cascade"),
  ],
);

export const authenticationRegistrationTokens = pgTable(
  "authentication_registration_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => authenticationApplications.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    userName: text("user_name").notNull(),
    displayName: text("display_name").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    aliasHashing: boolean("alias_hashing").notNull().default(true),
    authenticatorAttachment: text("authenticator_attachment"),
    userVerification: text("user_verification").notNull().default("required"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("authentication_registration_tokens_expiry_idx").on(t.expiresAt),
  ],
);

/** One-use ceremony challenges; durable so another replica may verify them. */
export const authenticationChallenges = pgTable(
  "authentication_challenges",
  {
    challenge: text("challenge").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => authenticationApplications.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    authenticationPurpose: text("authentication_purpose"),
    requireUserVerification: boolean("require_user_verification")
      .notNull()
      .default(true),
    origin: text("origin").notNull(),
    userId: text("user_id"),
    registrationTokenHash: text("registration_token_hash"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    index("authentication_challenges_expiry_idx").on(t.expiresAt),
    check(
      "authentication_challenges_purpose_check",
      sql`${t.purpose} in ('registration','authentication')`,
    ),
  ],
);

/** Authentication results exchanged once by the application's backend. */
export const authenticationSigninTokens = pgTable(
  "authentication_signin_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => authenticationApplications.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    purpose: text("purpose").notNull().default("sign-in"),
    type: text("type").notNull().default("passkey"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("authentication_signin_tokens_expiry_idx").on(t.expiresAt),
    foreignKey({
      columns: [t.applicationId, t.userId],
      foreignColumns: [
        authenticationUsers.applicationId,
        authenticationUsers.userId,
      ],
      name: "authentication_signin_tokens_user_fk",
    }).onDelete("cascade"),
  ],
);

export const betterAuthAccounts = pgTable(
  "better_auth_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => betterAuthUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("better_auth_accounts_user_idx").on(t.userId)],
);

/**
 * Where a magic link actually lives.
 *
 * `value` is the link token, and Better Auth is configured with
 * `storeToken: "hashed"`, so a read of this table is not a set of usable
 * sign-in links. Rows are consumed on verification and expire on `expiresAt`.
 */
export const betterAuthVerifications = pgTable(
  "better_auth_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    ...timestamps,
  },
  (t) => [index("better_auth_verifications_identifier_idx").on(t.identifier)],
);

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
    /**
     * Tenant federation config. Queried by issuer on the login path (home-realm
     * routing and trust resolution), so these are columns and not a jsonb blob.
     */
    ssoIssuer: text("sso_issuer"),
    /**
     * Credentials this deployment presents at `ssoIssuer`, registered by the
     * tenant admin in their own IdP. Null falls back to the origin-profile
     * client, which only a broker accepts.
     */
    ssoClientId: text("sso_client_id"),
    ssoClientSecret: text("sso_client_secret"),
    samlIssuer: text("saml_issuer"),
    samlMetadataUrl: text("saml_metadata_url"),
    samlMetadataXml: text("saml_metadata_xml"),
    /** SCIM is authoritative for membership when true (ADR 0056). */
    provisioningEnabled: boolean("provisioning_enabled")
      .notNull()
      .default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("organizations_slug_uidx").on(t.slug),
    check(
      "organizations_state_check",
      sql`${t.state} in ('provisional','active','suspended','deleted')`,
    ),
    index("organizations_sso_issuer_idx").on(t.ssoIssuer),
    index("organizations_saml_issuer_idx").on(t.samlIssuer),
  ],
);

/**
 * Organization membership — durable for the same reason as the org row: an
 * enterprise sign-in that JIT-joins a tenant must still be a member after a
 * restart, and owner counts fence the last-owner removal.
 */
export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("organization_memberships_org_principal_uidx").on(
      t.organizationId,
      t.principalId,
    ),
    index("organization_memberships_principal_id_idx").on(t.principalId),
    check(
      "organization_memberships_role_check",
      sql`${t.role} in ('owner','admin','member')`,
    ),
  ],
);

/**
 * Bring-your-own upstreams registered by visitors at sign-in (ADR 0055).
 *
 * Durable because re-entry depends on it: a returning user types their issuer
 * again and the server reuses this record instead of re-registering. The
 * issuer is stored trailing-slash-normalized so the unique index is the
 * anti-duplication fence.
 */
export const byoUpstreams = pgTable(
  "byo_upstreams",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    label: text("label").notNull(),
    clientId: text("client_id").notNull(),
    /**
     * Presented to the upstream verbatim, so it cannot be a digest. Same trust
     * boundary as env-held provider secrets; never agent-facing.
     */
    clientSecret: text("client_secret"),
    clientAuth: text("client_auth").notNull(),
    registrationSource: text("registration_source").notNull(),
    state: text("state").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => [
    uniqueIndex("byo_upstreams_issuer_uidx").on(t.issuer),
    check(
      "byo_upstreams_state_check",
      sql`${t.state} in ('active','disabled')`,
    ),
    check(
      "byo_upstreams_client_auth_check",
      sql`${t.clientAuth} in ('none','client_secret_post')`,
    ),
    check(
      "byo_upstreams_registration_source_check",
      sql`${t.registrationSource} in ('manual','dcr')`,
    ),
  ],
);

/**
 * SP-initiated SAML requests awaiting their response (ADR 0056).
 *
 * Server-side, not a cookie: the ACS receives a cross-site POST that carries
 * no SameSite=Lax cookies, and the response is matched on `InResponseTo`.
 */
export const samlPending = pgTable(
  "saml_pending",
  {
    requestId: text("request_id").primaryKey(),
    interactionUid: text("interaction_uid").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("saml_pending_created_at_idx").on(t.createdAt)],
);

/**
 * Assertion ids already consumed. IdP-initiated sign-in has no request to bind
 * to, so re-posting a captured assertion is refused here instead; rows live at
 * least as long as the assertion's own validity window.
 */
export const samlAssertionReplay = pgTable(
  "saml_assertion_replay",
  {
    assertionId: text("assertion_id").primaryKey(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("saml_assertion_replay_expires_at_idx").on(t.expiresAt)],
);

/**
 * SCIM 2.0 provisioned users (ADR 0056). No principal is minted at provision
 * time — the row is the org's answer to "may this subject join?" at sign-in.
 */
export const scimUsers = pgTable(
  "scim_users",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    userName: text("user_name").notNull(),
    active: boolean("active").notNull().default(true),
    displayName: text("display_name"),
    /** Attributes as the IdP sent them; SCIM leniency means we keep the rest. */
    raw: jsonb("raw").$type<JsonObject>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("scim_users_org_user_name_uidx").on(
      t.organizationId,
      t.userName,
    ),
    index("scim_users_org_external_id_idx").on(t.organizationId, t.externalId),
  ],
);

/**
 * Org-scoped SCIM provisioning tokens. Only the hash is stored — the plaintext
 * `sct_` value exists exactly once, in the mint response.
 */
export const scimTokens = pgTable(
  "scim_tokens",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("scim_tokens_token_hash_uidx").on(t.tokenHash),
    index("scim_tokens_organization_id_idx").on(t.organizationId),
  ],
);

/**
 * Email domains an organization claims, for home-realm discovery (ADR 0056).
 * The domain is the primary key: one organization owns a domain globally, or
 * routing would be ambiguous. Only `verifiedAt` rows route anything.
 */
export const orgEmailDomains = pgTable(
  "org_email_domains",
  {
    domain: text("domain").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    verificationToken: text("verification_token").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("org_email_domains_organization_id_idx").on(t.organizationId)],
);

/** Per-organization LDAP directory configuration (ADR 0057). */
export const orgLdapConfig = pgTable(
  "org_ldap_config",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    bindMode: text("bind_mode").notNull(),
    bindTemplate: text("bind_template"),
    searchBaseDn: text("search_base_dn"),
    searchFilter: text("search_filter"),
    serviceBindDn: text("service_bind_dn"),
    /** Presented to the directory verbatim, so it cannot be a digest. */
    serviceBindSecret: text("service_bind_secret"),
    /** Stable subject attribute — never the DN, which moves. */
    subjectAttribute: text("subject_attribute").notNull(),
    attributeMap: jsonb("attribute_map")
      .$type<JsonObject>()
      .notNull()
      .default({}),
    groupRoleMap: jsonb("group_role_map")
      .$type<JsonObject>()
      .notNull()
      .default({}),
    ...timestamps,
  },
  (t) => [
    check(
      "org_ldap_config_bind_mode_check",
      sql`${t.bindMode} in ('bind_template','search_bind')`,
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
    /** personal = auto-provisioned default; standard = user-created; temporary = TTL/claim flow. */
    kind: text("kind").notNull().default("standard"),
    organizationId: text("organization_id").references(() => organizations.id),
    ownerPrincipalId: text("owner_principal_id").references(
      () => principals.id,
    ),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    state: text("state").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    claimPolicyId: text("claim_policy_id"),
    /** Opaque sealed-store tomb name (Host/CLI); never a secret value. */
    sealedStoreTombName: text("sealed_store_tomb_name"),
    /** Opaque Pages vault folder id (client plane); Host never decrypts. */
    pagesVaultFolderId: text("pages_vault_folder_id"),
    ...timestamps,
  },
  (t) => [
    index("projects_organization_id_idx").on(t.organizationId),
    index("projects_owner_principal_id_idx").on(t.ownerPrincipalId),
    // One personal project per principal — the always-present default scope.
    uniqueIndex("projects_personal_owner_uidx")
      .on(t.ownerPrincipalId)
      .where(sql`${t.kind} = 'personal'`),
    uniqueIndex("projects_owner_personal_slug_uidx")
      .on(t.ownerPrincipalId, t.slug)
      .where(sql`${t.slug} = 'personal' and ${t.ownerPrincipalId} is not null`),
    check(
      "projects_kind_check",
      sql`${t.kind} in ('personal','standard','temporary')`,
    ),
    check(
      "projects_state_check",
      sql`${t.state} in ('provisional','active','expired','deleting','deleted')`,
    ),
  ],
);

/** Optional sharing: grants a principal a role on a project. */
export const projectMemberships = pgTable(
  "project_memberships",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("project_memberships_project_principal_uidx").on(
      t.projectId,
      t.principalId,
    ),
    index("project_memberships_principal_id_idx").on(t.principalId),
    check(
      "project_memberships_role_check",
      sql`${t.role} in ('owner','admin','member')`,
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
    manifest: jsonb("manifest").$type<JsonObject>().notNull().default({}),
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
    /** Project the agent belongs to (defaults to the owner's personal project). */
    projectId: text("project_id").references(() => projects.id),
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
    index("agents_project_id_idx").on(t.projectId),
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
    /** Canonical web origin for origin_profile clients (`https://app.example.com`). */
    origin: text("origin"),
    /** Origin-profile clients begin unclaimed until the F5 claim flow runs. */
    ownershipStatus: text("ownership_status").notNull().default("unclaimed"),
    firstSeenAt: timestamp("first_seen_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
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
    check(
      "oauth_clients_ownership_status_check",
      sql`${t.ownershipStatus} in ('unclaimed','claimed')`,
    ),
    index("oauth_clients_owner_principal_id_idx").on(t.ownerPrincipalId),
    uniqueIndex("oauth_clients_origin_uidx")
      .on(t.origin)
      .where(sql`${t.origin} is not null`),
  ],
);

/** Verified origin aliases attached to a claimed application (stable sector). */
export const clientOrigins = pgTable(
  "client_origins",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    canonicalOrigin: text("canonical_origin").notNull(),
    publicClientId: text("public_client_id").notNull(),
    verificationMethod: text("verification_method"),
    status: text("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    check(
      "client_origins_status_check",
      sql`${t.status} in ('active','revoked','pending')`,
    ),
    uniqueIndex("client_origins_canonical_uidx").on(t.canonicalOrigin),
    uniqueIndex("client_origins_public_client_uidx").on(t.publicClientId),
    index("client_origins_application_idx").on(t.applicationId),
  ],
);

/** Short-lived proof-of-control challenges for application claim (F5). */
export const clientClaimChallenges = pgTable(
  "client_claim_challenges",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    ownerPrincipalId: text("owner_principal_id")
      .notNull()
      .references(() => principals.id),
    challenge: text("challenge").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("client_claim_challenges_challenge_uidx").on(t.challenge),
    index("client_claim_challenges_app_idx").on(t.applicationId),
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
  (t) => [
    index("consents_principal_client_idx").on(t.principalId, t.clientId),
    // At most one live (unrevoked) consent per principal+client: concurrent
    // confirmations race one insert, and the loser widens the winner's row.
    uniqueIndex("consents_active_principal_client_uidx")
      .on(t.principalId, t.clientId)
      .where(sql`${t.revokedAt} is null`),
  ],
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
      .$type<JsonObject>()
      .notNull()
      .default({}),
    targetManifestDigest: text("target_manifest_digest").notNull(),
    requestedDestination: jsonb("requested_destination").$type<JsonObject>(),
    requestedGrant: jsonb("requested_grant").$type<JsonObject>(),
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
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
    /** Hash chain over the trail: each event names the digest of the one before it. */
    previousDigest: text("previous_digest"),
    digest: text("digest"),
    /**
     * Append order, which is the order the chain was built in. `occurred_at` is
     * not that order: it comes from a clock, ties are common, and a tie sorts
     * arbitrarily — so a trail read back by timestamp cannot be re-walked and a
     * deletion cannot be told from a reordering.
     */
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("audit_events_previous_digest_uidx")
      .on(t.previousDigest)
      .where(sql`${t.previousDigest} is not null and ${t.digest} is not null`),
    index("audit_events_seq_idx").on(t.seq),
    index("audit_events_occurred_at_idx").on(t.occurredAt),
    index("audit_events_correlation_id_idx").on(t.correlationId),
    index("audit_events_principal_id_idx").on(t.principalId),
    check(
      "audit_events_outcome_check",
      sql`${t.outcome} in ('succeeded','failed','denied')`,
    ),
  ],
);

/**
 * Registered webhook receivers for a principal's authorization-request
 * events (ADR 0046 decision 12). The secret column holds the whsec_ signing
 * key — signing requires the raw bytes, so unlike claim tokens it cannot be
 * stored as a hash; GET surfaces mask it and it is shown whole only at
 * registration.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("webhook_endpoints_principal_id_idx").on(t.principalId)],
);

/**
 * One attempted delivery per endpoint per event. Durable so a receiver that
 * is down retries with backoff instead of silently missing the event; the
 * inbox itself stays the source of truth either way.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
    deadAt: timestamp("dead_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("webhook_deliveries_next_attempt_idx").on(t.nextAttemptAt)],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
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
  organizationMemberships,
  byoUpstreams,
  samlPending,
  samlAssertionReplay,
  scimUsers,
  scimTokens,
  orgEmailDomains,
  orgLdapConfig,
  teams,
  projects,
  projectMemberships,
  resources,
  ownerships,
  agents,
  agentInstances,
  delegations,
  oauthClients,
  clientOrigins,
  clientClaimChallenges,
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
    payload: jsonb("payload").$type<JsonObject>().notNull(),
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

/**
 * Pending authorization requests — the inbox (ADR 0046).
 *
 * A request is CIBA-shaped: it has an opaque id the requester polls, a TTL, a
 * poll interval, and a binding message rendered identically to both sides. It
 * outlives a process restart on purpose; an inbox that forgets what was asked
 * is worse than none, because the requester keeps waiting for an answer that
 * can no longer arrive.
 */
export const authorizationRequests = pgTable(
  "authorization_requests",
  {
    /** CIBA `auth_req_id`. Opaque — never derived from the requester. */
    id: text("id").primaryKey(),
    /** The approver: whose authority is being asked for. */
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    /**
     * Who is asking, as an opaque reference. Canonical principal ids do not go
     * here: this value reaches inboxes and, later, public bus subjects.
     */
    requesterRef: text("requester_ref").notNull(),
    /** RFC 9396 authorization_details — constraint, prompt, and echo in one shape. */
    authorizationDetails: jsonb("authorization_details")
      .$type<JsonObject[]>()
      .notNull()
      .default([]),
    /**
     * Canonical digest of the exact request consented to. An executor refuses
     * when what it is about to run does not hash to this, so a request cannot
     * be swapped after approval.
     */
    requestDigest: text("request_digest").notNull(),
    bindingMessage: text("binding_message").notNull(),
    status: text("status").notNull(),
    intervalSeconds: integer("interval_seconds").notNull().default(5),
    connectionId: text("connection_id"),
    delegationId: text("delegation_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    decidedByPrincipalId: text("decided_by_principal_id").references(
      () => principals.id,
    ),
    /** `human` or `agent`. Recorded, never inferred from the identity. */
    decidedByKind: text("decided_by_kind"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    check(
      "authorization_requests_status_check",
      sql`${t.status} in ('pending','approved','denied','expired','cancelled')`,
    ),
    check(
      "authorization_requests_decided_by_kind_check",
      sql`${t.decidedByKind} is null or ${t.decidedByKind} in ('human','agent')`,
    ),
    index("authorization_requests_principal_idx").on(t.principalId, t.status),
    index("authorization_requests_pending_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/* ------------------------------------------------------------------ *
 * External notification channels and approval ceremonies (ADR 0084)
 * ------------------------------------------------------------------ */

/**
 * Where a principal can be reached, and who they are at the provider.
 *
 * The authority-bearing key is the whole tuple
 * (kind, provider_id, provider_tenant_id, provider_subject_id), and the unique
 * index is on all four. Subject ids are unique *within* a provider tenant and
 * not across them, so a key that omitted the tenant would let anyone who can
 * create their own workspace mint a subject that collides with somebody
 * else's binding. `display_label` is deliberately outside the key: an email
 * address, a @username and a display name are all things another person can
 * come to own.
 */
export const channelBindings = pgTable(
  "channel_bindings",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    /** Issuer/provider identifier, e.g. `slack`, `telegram`, a push origin. */
    providerId: text("provider_id").notNull(),
    /** Workspace/tenant/account. Empty string where the provider has none. */
    providerTenantId: text("provider_tenant_id").notNull(),
    /** Stable provider subject. Never a display name, handle, or address. */
    providerSubjectId: text("provider_subject_id").notNull(),
    /** Non-authoritative, for showing the person which destination this is. */
    displayLabel: text("display_label"),
    state: text("state").notNull(),
    verification: text("verification").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    /** Digest-shaped, never secret material. */
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("channel_bindings_provider_identity_uidx").on(
      t.kind,
      t.providerId,
      t.providerTenantId,
      t.providerSubjectId,
    ),
    index("channel_bindings_principal_id_idx").on(t.principalId),
    check(
      "channel_bindings_kind_check",
      sql`${t.kind} in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook')`,
    ),
    check(
      "channel_bindings_state_check",
      sql`${t.state} in ('pending','active','revoked','expired')`,
    ),
    check(
      "channel_bindings_verification_check",
      sql`${t.verification} in ('provider_oauth_install','provider_callback_challenge','push_subscription','operator_provisioned')`,
    ),
    /**
     * An empty subject is not an identity. Without this fence a provider that
     * omits the field, or a callback that sends `""`, would resolve to any
     * binding stored the same way — one row every unauthenticated caller
     * matches.
     */
    check(
      "channel_bindings_provider_subject_id_check",
      sql`${t.providerSubjectId} <> ''`,
    ),
  ],
);

/**
 * The ceremony that adds a destination.
 *
 * Adding a destination changes where authorization prompts can appear, so it
 * is itself security-sensitive: bound to a principal, a channel and (when
 * pinned) the proposed provider identity, expiring, attempt-fenced, and
 * completable exactly once.
 *
 * `nonce_digest` and never the nonce: the nonce is one-time secret-ish
 * material that exists in one response body and in the provider round-trip,
 * and has no reason to be readable at rest. A dump of this table must not let
 * the reader complete a pending binding.
 */
export const channelBindingChallenges = pgTable(
  "channel_binding_challenges",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    providerId: text("provider_id").notNull(),
    /** Digest of the one-time nonce. Never the nonce. */
    nonceDigest: text("nonce_digest").notNull(),
    /** The provider identity this challenge may complete against, if pinned. */
    expectedTenantId: text("expected_tenant_id"),
    expectedSubjectId: text("expected_subject_id"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("channel_binding_challenges_principal_id_idx").on(t.principalId),
    index("channel_binding_challenges_expires_at_idx").on(t.expiresAt),
    check(
      "channel_binding_challenges_kind_check",
      sql`${t.kind} in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook')`,
    ),
  ],
);

/**
 * Where a person wants to hear about things — a preference, never a policy.
 *
 * One row per principal, so the primary key is the principal: a second row
 * would be a second answer to a question that has one.
 */
export const notificationPreferences = pgTable("notification_preferences", {
  principalId: text("principal_id")
    .primaryKey()
    .references(() => principals.id, { onDelete: "cascade" }),
  /** `{ [NotificationClass]: { channels, fanOut } }`. */
  byClass: jsonb("by_class").$type<JsonObject>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  version: integer("version").notNull().default(1),
});

/**
 * One attempt to tell one person on one channel.
 *
 * A separate state machine from the authorization request on purpose: nothing
 * here may move the request. A dead-lettered delivery has not denied
 * anything; a delivered one has not approved anything.
 *
 * `destination_id` is generated rather than written by the caller, because it
 * exists only to key the idempotence index and a column the fan-out fills in
 * by hand is a column the fan-out can forget. Together with
 * `(outbox_event_id, kind)` it is unique: the outbox is at-least-once, so a
 * retried drain must collide instead of ringing the same doorbell twice.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    bindingId: text("binding_id"),
    /** Set for the generic-webhook adapter, which routes by endpoint. */
    endpointId: text("endpoint_id"),
    /** Derived key: the binding, else the endpoint, else "no destination". */
    destinationId: text("destination_id")
      .notNull()
      .generatedAlwaysAs(sql`coalesce("binding_id", "endpoint_id", '')`),
    notificationClass: text("notification_class").notNull(),
    eventType: text("event_type").notNull(),
    /** Correlates back to the outbox row that produced this. */
    outboxEventId: text("outbox_event_id").notNull(),
    authReqId: text("auth_req_id"),
    /** Rendered body, already reduced to the step's confidentiality. */
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    confidentiality: text("confidentiality").notNull(),
    state: text("state").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    /**
     * A classified reason code — `provider_rejected`, `timeout` — and never a
     * provider response body, which routinely echoes the message back.
     */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Provider handle for a message we may later revise or withdraw. */
    providerMessageRef: text("provider_message_ref"),
  },
  (t) => [
    uniqueIndex("notification_deliveries_event_kind_destination_uidx").on(
      t.outboxEventId,
      t.kind,
      t.destinationId,
    ),
    index("notification_deliveries_next_attempt_idx").on(t.nextAttemptAt),
    index("notification_deliveries_principal_id_idx").on(t.principalId),
    index("notification_deliveries_auth_req_id_idx").on(t.authReqId),
    check(
      "notification_deliveries_kind_check",
      sql`${t.kind} in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook')`,
    ),
    check(
      "notification_deliveries_confidentiality_check",
      sql`${t.confidentiality} in ('minimal','descriptive','full')`,
    ),
    check(
      "notification_deliveries_state_check",
      sql`${t.state} in ('pending','delivered','failed','dead','skipped')`,
    ),
  ],
);

/**
 * A WebAuthn ceremony pinned to one approval transaction.
 *
 * Durable and multi-instance safe: the consumption is a compare-and-set on
 * this row, not a delete from a process-local map, so two settlements racing
 * on one activation cannot both win.
 *
 * `challenge_digest` rather than the challenge, for the same reason as the
 * binding nonce — it is one-time material with no reason to be readable at
 * rest, and the row is looked up *by* the digest of what the caller presents.
 */
export const approvalActivations = pgTable(
  "approval_activations",
  {
    id: text("id").primaryKey(),
    authReqId: text("auth_req_id").notNull(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    /** Commits to the request *and* the decision, so a "deny" cannot be spent as an "approve". */
    transactionDigest: text("transaction_digest").notNull(),
    decision: text("decision").notNull(),
    policyDigest: text("policy_digest").notNull(),
    channelKind: text("channel_kind").notNull(),
    /** Digest of the one-time challenge. Never the challenge. */
    challengeDigest: text("challenge_digest").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    activatedAt: timestamp("activated_at", {
      withTimezone: true,
      mode: "date",
    }),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    trustSessionId: text("trust_session_id"),
    method: text("method"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    // Unique: a challenge is one-time, so a digest that resolved to two rows
    // would make "which activation did this assertion answer?" ambiguous.
    uniqueIndex("approval_activations_challenge_digest_uidx").on(
      t.challengeDigest,
    ),
    index("approval_activations_auth_req_idx").on(t.authReqId, t.state),
    index("approval_activations_principal_id_idx").on(t.principalId),
    check(
      "approval_activations_decision_check",
      sql`${t.decision} in ('approved','denied')`,
    ),
    check(
      "approval_activations_state_check",
      sql`${t.state} in ('pending','activated','consumed')`,
    ),
    check(
      "approval_activations_channel_kind_check",
      sql`${t.channelKind} in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook')`,
    ),
  ],
);

/**
 * Number matching, per ADR 0046's anti-fatigue requirement.
 *
 * `value_digest` only: the plaintext exists in one response body, on the
 * initiating surface, and nowhere else — never in the external notification,
 * whose job is to send the person to the surface that has it, and never in a
 * log or a table somebody can read.
 *
 * One live challenge per request (`auth_req_id` is unique), which is what
 * makes the attempt budget mean something: re-issuing a code collides instead
 * of handing back a fresh set of guesses against a six-digit value.
 */
export const comparisonChallenges = pgTable(
  "comparison_challenges",
  {
    id: text("id").primaryKey(),
    authReqId: text("auth_req_id").notNull(),
    /** Digest of the plaintext. The plaintext is never persisted. */
    valueDigest: text("value_digest").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    satisfiedAt: timestamp("satisfied_at", {
      withTimezone: true,
      mode: "date",
    }),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("comparison_challenges_auth_req_id_uidx").on(t.authReqId),
    index("comparison_challenges_expires_at_idx").on(t.expiresAt),
  ],
);

/**
 * Why a request was allowed — the record that outlives the policy.
 *
 * `principal_id` carries no foreign key on purpose: a receipt must survive
 * the deletion of everything it refers to, exactly as `audit_events` does.
 * Both the required and the achieved assurance are kept, so a later policy
 * change cannot silently re-characterise a historical approval.
 */
export const approvalReceipts = pgTable(
  "approval_receipts",
  {
    id: text("id").primaryKey(),
    authReqId: text("auth_req_id").notNull(),
    principalId: text("principal_id").notNull(),
    decision: text("decision").notNull(),
    decidedByKind: text("decided_by_kind").notNull(),
    path: text("path").notNull(),
    channelKind: text("channel_kind").notNull(),
    bindingId: text("binding_id"),
    requestDigest: text("request_digest").notNull(),
    transactionDigest: text("transaction_digest").notNull(),
    policyDigest: text("policy_digest").notNull(),
    /** Reason codes from the assurance evaluator, not a scalar. */
    requiredAssurance: jsonb("required_assurance")
      .$type<string[]>()
      .notNull()
      .default([]),
    achievedAssurance: jsonb("achieved_assurance")
      .$type<string[]>()
      .notNull()
      .default([]),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default([]),
    trustSessionId: text("trust_session_id"),
    activationId: text("activation_id"),
    comparisonRequired: boolean("comparison_required").notNull().default(false),
    comparisonSatisfied: boolean("comparison_satisfied")
      .notNull()
      .default(false),
    /** Digest of the provider callback that settled it, when one did. */
    callbackDigest: text("callback_digest"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    receiptVersion: integer("receipt_version").notNull().default(1),
  },
  (t) => [
    // One decision per request: a second receipt would be a second answer.
    uniqueIndex("approval_receipts_auth_req_id_uidx").on(t.authReqId),
    index("approval_receipts_principal_id_idx").on(t.principalId),
    check(
      "approval_receipts_decision_check",
      sql`${t.decision} in ('approved','denied')`,
    ),
    check(
      "approval_receipts_decided_by_kind_check",
      sql`${t.decidedByKind} in ('human','agent')`,
    ),
    check(
      "approval_receipts_path_check",
      sql`${t.path} in ('in_app','external_rendezvous','external_direct','agent')`,
    ),
    check(
      "approval_receipts_channel_kind_check",
      sql`${t.channelKind} in ('in_app','native_push','slack','teams','telegram','wechat','sms','webhook')`,
    ),
  ],
);

/**
 * Callbacks we have already processed.
 *
 * The primary key *is* the claim: an insert that conflicts is the answer to
 * "have I seen this?", asked in one round trip that two replicas cannot both
 * win. Asking with a SELECT and answering with an INSERT is a race an
 * attacker replaying an approval into two instances wins.
 */
export const callbackReplays = pgTable(
  "callback_replays",
  {
    /** `${providerId}:${callbackDigest}`. */
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    callbackDigest: text("callback_digest").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    authReqId: text("auth_req_id"),
  },
  (t) => [
    index("callback_replays_expires_at_idx").on(t.expiresAt),
    index("callback_replays_auth_req_id_idx").on(t.authReqId),
  ],
);

/**
 * W3C Push subscriptions.
 *
 * Deliberately its own table rather than a `channel_bindings` row: a binding's
 * `metadata` is digest-shaped and never secret, and both `endpoint` and
 * `auth_secret` are the opposite. The endpoint is a capability URL — whoever
 * holds it can push to that browser — and `auth_secret` is the RFC 8291 shared
 * secret the content encryption is keyed from. Neither can be stored as a
 * hash, because sending needs the raw bytes (the same reason
 * `webhook_endpoints.secret` is not a digest), and neither may ever appear in
 * an API response, a log line, or a notification body. `endpoint_digest` is
 * what deduplicates and names a subscription without disclosing either.
 *
 * `endpoint_digest` is unique: a browser that re-subscribes presents the same
 * endpoint, and a second row for it would push the same person twice.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    /** Capability URL. Never returned by an API, never logged. */
    endpoint: text("endpoint").notNull(),
    /** Subscriber public key (P-256, base64url). Not secret, not useful alone. */
    p256dhKey: text("p256dh_key").notNull(),
    /** RFC 8291 auth secret. Secret material — write-only above this layer. */
    authSecret: text("auth_secret").notNull(),
    /** Digest of the endpoint: the dedupe key, and the safe name for a log. */
    endpointDigest: text("endpoint_digest").notNull(),
    deviceLabel: text("device_label"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_digest_uidx").on(t.endpointDigest),
    index("push_subscriptions_principal_id_idx").on(t.principalId),
  ],
);

/**
 * The canonical cross-device interaction (ADR 0086).
 *
 * One row per handoff, whatever surface renders it. A QR on a laptop, a Google
 * Wallet pass, a phone notification and a CLI poll are four views of this row,
 * which is the point: the alternative is four link formats and four separate
 * places to get expiry, replay and enumeration wrong.
 *
 * The row does not replace the ceremony it fronts. The device-authorization
 * session, the authorization request and the claim session keep their own
 * tables and their own state machines; `subject_kind` + `subject_id` address
 * one. Nothing here is a bearer — `id` is unguessable and the public reference
 * over it is MAC-bound (see `crypto/interaction-ref.ts`), so a photographed QR
 * buys the finder an opaque handle and no authority at all.
 *
 * Storage deliberately does not re-implement `machines/interaction.ts`. The
 * checks below are the invariants a *stored* row must satisfy no matter which
 * code path wrote it — a second line under the machine, not a copy of it.
 */
export const interactions = pgTable(
  "interactions",
  {
    /** `int_<base64url>` — 144 bits of randomness, never derived from the subject. */
    id: text("id").primaryKey(),
    /** Which ceremony this fronts. Kinds are not interchangeable (ADR 0009). */
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    /**
     * The subject, flattened from `Interaction.subject`. Two columns rather
     * than a jsonb blob because the live-subject uniqueness below has to be an
     * index the database can enforce, and you cannot index your way out of
     * JSON without giving up the constraint.
     */
    subjectKind: text("subject_kind").notNull(),
    /**
     * The underlying ceremony's own primary key. Server-side only: a caller
     * resolving a reference learns the interaction, never the row behind it,
     * so a scanned QR cannot be turned into a device-session id.
     */
    subjectId: text("subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /**
     * Not null, and no default. Every interaction lapses; a row that could be
     * written without a deadline would be a QR that works forever.
     */
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /**
     * Who is asking, as the opaque handle the authorization-request inbox
     * uses. Canonical principal ids do not go on a screen a stranger may be
     * holding.
     */
    requesterRef: text("requester_ref"),
    /**
     * Whose authority is being asked for.
     *
     * `set null`, deliberately not `cascade`: an interaction is the record of
     * a decision somebody made, and deleting the principal must not delete the
     * evidence that the decision happened. The audit trail outlives the
     * account — losing the approver's identity is the cost of an erasure
     * request, losing the fact of the approval is destroying an audit record.
     */
    approverPrincipalId: text("approver_principal_id").references(
      () => principals.id,
      { onDelete: "set null" },
    ),
    /**
     * Canonical digest of exactly what is being consented to. An executor
     * hashes what it is about to run and refuses on mismatch, so an approved
     * interaction cannot be pointed at a different operation afterwards.
     */
    requestDigest: text("request_digest"),
    /** Digest of the binding message, so a receipt can prove the words without carrying them. */
    bindingMessageDigest: text("binding_message_digest"),
    /** Short display string rendered identically on both devices (CIBA). */
    bindingMessage: text("binding_message"),
    /** RFC 9396 authorization_details — constraint, prompt, and consent echo. */
    authorizationDetails: jsonb("authorization_details")
      .$type<JsonObject[]>()
      .notNull()
      .default([]),
    /** Opaque reference to the target. Never a credential or a secret ref. */
    resourceRef: text("resource_ref"),
    /** `AssuranceRequirement`: what the approval must clear before it counts. */
    assuranceRequired: jsonb("assurance_required").$type<JsonObject>(),
    /**
     * `ApprovalProof` — mechanism, bound digest, assurance, verification time.
     * Never the assertion or presentation bytes: those are proof *inputs*,
     * verified once at the protocol edge and dropped, because a store of
     * replayable proof material is a store of replayable approvals.
     *
     * Typed as `JsonObject` rather than `ApprovalProof` on purpose — jsonb
     * returns `verifiedAt` as a string, and a column type that claimed `Date`
     * would be a lie the repositories would then have to launder.
     */
    approvalProof: jsonb("approval_proof").$type<JsonObject>(),
    presentedAt: timestamp("presented_at", {
      withTimezone: true,
      mode: "date",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    check(
      "interactions_kind_check",
      sql`${t.kind} in ('device_authorization','pairing','claim','grant_claim','authorization_request','transaction_authorization')`,
    ),
    check(
      "interactions_status_check",
      sql`${t.status} in ('pending','presented','awaiting_approval','approved','denied','consumed','expired','revoked')`,
    ),
    check(
      "interactions_subject_kind_check",
      sql`${t.subjectKind} in ('device_authorization','pairing','claim','grant_claim','authorization_request','transaction_authorization')`,
    ),
    /**
     * At most one live interaction per underlying ceremony.
     *
     * Without it, two QR codes could address the same device-authorization
     * session: the attacker mints a second interaction over a victim's live
     * ceremony, gets that one approved, and the ceremony settles on an
     * envelope its initiator never saw. Partial because terminal rows are the
     * audit trail — history must accumulate, only the live slot is exclusive,
     * and a re-issued QR after an expiry is legitimate.
     */
    uniqueIndex("interactions_live_subject_idx")
      .on(t.subjectKind, t.subjectId)
      .where(
        sql`${t.status} in ('pending','presented','awaiting_approval','approved')`,
      ),
    /**
     * The sweeper's index. Expiry is enforced on every read (`assertLive`),
     * but a lapsed row that stays live in the table is an approval window that
     * never closes if the read path is ever bypassed — so the sweep must be
     * able to find due rows without scanning the whole history.
     */
    index("interactions_expiry_idx")
      .on(t.expiresAt)
      .where(
        sql`${t.status} in ('pending','presented','awaiting_approval','approved')`,
      ),
    /**
     * The approver's inbox read. Composite with `status` so listing one
     * principal's pending questions never widens into a scan another
     * principal's rows pass through — an inbox that has to filter in the
     * application is an inbox that can leak by forgetting to.
     */
    index("interactions_approver_idx").on(t.approverPrincipalId, t.status),
    /**
     * A consumption time only exists on a consumed row.
     *
     * `consumed_at` is what proves an approval was spent exactly once. A row
     * carrying one while claiming any other status would let a replayed
     * execution look unspent to a reader that trusts the status column.
     */
    check(
      "interactions_consumed_at_check",
      sql`${t.consumedAt} is null or ${t.status} = 'consumed'`,
    ),
    /**
     * A settled decision names when it was made.
     *
     * `denied` and `consumed` only exist because a human answered: `deny`
     * stamps `decided_at`, and `consumed` is reachable only from `approved`,
     * which stamps it too. A row in either state without one is an approval
     * with no moment attached — unauditable, and indistinguishable from one
     * written around the machine.
     *
     * `expired` and `revoked` are excluded because neither has a decider.
     * Expiry is the clock running out, and revocation is reachable from
     * `pending`, where nobody has been asked yet. Widening this check to all
     * four terminal states would be a constraint the legitimate paths cannot
     * satisfy.
     */
    check(
      "interactions_decided_at_check",
      sql`${t.status} not in ('denied','consumed') or ${t.decidedAt} is not null`,
    ),
  ],
);
