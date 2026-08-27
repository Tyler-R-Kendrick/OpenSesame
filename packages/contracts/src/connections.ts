import { z } from "zod";

/**
 * Connection broker wire contract (ADR 0032, docs/architecture/connection-broker.md).
 * Field names are snake_case because they are the wire names, not the house
 * camelCase used by the identity-plane contracts.
 *
 * Every object here is `.strict()`: ADR 0032 §6 forbids credential material on
 * any response, so an unexpected `access_token`/`refresh_token`/`client_secret`
 * must fail parsing loudly rather than be silently stripped.
 */

export const ProviderCategorySchema = z.enum([
  "encryption",
  "cloud_secret_storage",
  "password_managers",
  "local_storage",
  "developer",
  "productivity",
  "communication",
  "storage",
  "crm",
  "payments",
  "identity",
  "testing",
  "custom",
]);
export type ProviderCategory = z.infer<typeof ProviderCategorySchema>;

export const ProviderAuthKindSchema = z.enum([
  "oauth2_authorization_code",
  "api_key",
  "configuration",
]);
export type ProviderAuthKind = z.infer<typeof ProviderAuthKindSchema>;

export const ConfigurationFieldDefSchema = z
  .object({
    name: z.string().min(1),
    secret: z.boolean(),
    required: z.boolean(),
  })
  .strict();
export type ConfigurationFieldDef = z.infer<typeof ConfigurationFieldDefSchema>;
export const ConfiguredFieldSchema = z
  .object({
    name: z.string().min(1),
    hint: z.string().nullable(),
  })
  .strict();
export type ConfiguredField = z.infer<typeof ConfiguredFieldSchema>;
const ConfigurationSchema = z
  .record(
    z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    z
      .string()
      .min(1)
      .max(8 * 1024),
  )
  .refine((configuration) => Object.keys(configuration).length <= 64, {
    message: "configuration exceeds 64 fields",
  })
  .refine(
    (configuration) =>
      Object.entries(configuration).reduce(
        (bytes, [name, value]) => bytes + name.length + value.length,
        0,
      ) <=
      24 * 1024,
    { message: "configuration exceeds 24576 bytes" },
  );

export const ScopeDefSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    sensitive: z.boolean(),
    default: z.boolean(),
  })
  .strict();
export type ScopeDef = z.infer<typeof ScopeDefSchema>;

/** Derived from the provider, so ADR 0005 egress allowlisting cannot be widened by a caller. */
export const EgressSchema = z
  .object({
    scheme: z.string().min(1),
    authorities: z.array(z.string()),
    path_prefixes: z.array(z.string()),
  })
  .strict();
export type Egress = z.infer<typeof EgressSchema>;

export const ProviderSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    category: ProviderCategorySchema,
    docs_url: z.string().url(),
    provenance_url: z.string().url(),
    catalog_revision: z.string().min(1),
    auth_kind: ProviderAuthKindSchema,
    supports_refresh: z.boolean(),
    configured: z.boolean(),
    auto_configurable: z.boolean().default(false),
    callback_url: z.string().url().nullable(),
    missing_config: z.array(z.string()),
    scopes: z.array(ScopeDefSchema),
    egress: EgressSchema,
    operations: z.array(z.string()),
    integration_configuration_fields: z
      .array(ConfigurationFieldDefSchema)
      .default([]),
    connection_configuration_fields: z
      .array(ConfigurationFieldDefSchema)
      .default([]),
  })
  .strict();
export type Provider = z.infer<typeof ProviderSchema>;

export const ConnectionStatusSchema = z.enum([
  "pending",
  "active",
  "needs_reauth",
  "expired",
  "revoked",
  "error",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const ConnectionShareabilitySchema = z.enum([
  "private",
  "delegable",
  "organization_wide",
]);
export type ConnectionShareability = z.infer<
  typeof ConnectionShareabilitySchema
>;

export const ConnectionMaterializationSchema = z.enum([
  "deny",
  "derived_short_lived",
]);
export type ConnectionMaterialization = z.infer<
  typeof ConnectionMaterializationSchema
>;

export const BindingTargetKindSchema = z.enum([
  "organization",
  "project",
  "agent",
  "group",
  "device",
  "identity",
]);
export type BindingTargetKind = z.infer<typeof BindingTargetKindSchema>;

export const BindingSchema = z
  .object({
    id: z.string().min(1),
    target_kind: BindingTargetKindSchema,
    target_id: z.string().min(1),
    target_label: z.string().nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type Binding = z.infer<typeof BindingSchema>;

export const ConnectionSchema = z
  .object({
    connection_id: z.string().min(1),
    integration_id: z.string().min(1).nullable(),
    connection_ref: z.string().min(1),
    logical_name: z.string().min(1),
    display_name: z.string(),
    provider_id: z.string().min(1),
    status: ConnectionStatusSchema,
    status_detail: z.string().nullable(),
    organization_id: z.string().min(1),
    project_id: z.string().nullable(),
    owner_kind: z.string().min(1),
    shareability: ConnectionShareabilitySchema,
    materialization: ConnectionMaterializationSchema,
    requested_scopes: z.array(z.string()),
    granted_scopes: z.array(z.string()),
    account_label: z.string().nullable(),
    expires_at: z.string().datetime({ offset: true }).nullable(),
    refreshable: z.boolean(),
    configured_fields: z.array(ConfiguredFieldSchema).default([]),
    last_refreshed_at: z.string().datetime({ offset: true }).nullable(),
    max_invoke_level: z.number().int(),
    egress: EgressSchema,
    bindings: z.array(BindingSchema),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type Connection = z.infer<typeof ConnectionSchema>;

export const ConnectionEventKindSchema = z.enum([
  "created",
  "authorize_started",
  "authorized",
  "refreshed",
  "refresh_failed",
  "bound",
  "unbound",
  "policy_updated",
  "revoked",
  "error",
]);
export type ConnectionEventKind = z.infer<typeof ConnectionEventKindSchema>;

export const ConnectionEventSchema = z
  .object({
    id: z.string().min(1),
    kind: ConnectionEventKindSchema,
    at: z.string().datetime({ offset: true }),
    detail: z.string().nullable(),
  })
  .strict();
export type ConnectionEvent = z.infer<typeof ConnectionEventSchema>;

export const CreateConnectionRequestSchema = z
  .object({
    integration_id: z.string().min(1).optional(),
    provider_id: z.string().min(1).optional(),
    display_name: z.string().min(1).optional(),
    logical_name: z.string().min(1).optional(),
    project_id: z.string().min(1).optional(),
    scopes: z.array(z.string()).optional(),
    shareability: ConnectionShareabilitySchema.optional(),
  })
  .strict();
export type CreateConnectionRequest = z.infer<
  typeof CreateConnectionRequestSchema
>;

export const IntegrationSourceSchema = z.enum([
  "organization",
  "shared_dev",
  "deployment",
]);
export const IntegrationSchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1),
    provider_id: z.string().min(1),
    display_name: z.string().min(1),
    source: IntegrationSourceSchema,
    enabled: z.boolean(),
    configured: z.boolean(),
    callback_url: z.string().url().nullable(),
    scopes: z.array(z.string()),
    client_id_hint: z.string().nullable(),
    has_client_secret: z.boolean(),
    configured_fields: z.array(ConfiguredFieldSchema).default([]),
    connection_count: z.number().int().nonnegative(),
    created_by: z.string().min(1),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type Integration = z.infer<typeof IntegrationSchema>;

export const CreateIntegrationRequestSchema = z
  .object({
    key: z.string().min(1),
    provider_id: z.string().min(1),
    display_name: z.string().min(1),
    scopes: z.array(z.string()).optional(),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
    configuration: ConfigurationSchema.optional(),
  })
  .strict();
export type CreateIntegrationRequest = z.infer<
  typeof CreateIntegrationRequestSchema
>;

export const UpdateIntegrationRequestSchema = z
  .object({
    key: z.string().min(1).optional(),
    display_name: z.string().min(1).optional(),
    scopes: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    configuration_set: ConfigurationSchema.optional(),
    configuration_clear: z.array(z.string().min(1)).max(64).optional(),
  })
  .strict();
export type UpdateIntegrationRequest = z.infer<
  typeof UpdateIntegrationRequestSchema
>;

export const ListIntegrationsResponseSchema = z
  .object({ integrations: z.array(IntegrationSchema) })
  .strict();
export type ListIntegrationsResponse = z.infer<
  typeof ListIntegrationsResponseSchema
>;

export const AuthorizeRequestSchema = z
  .object({
    redirect_uri: z.string().url().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .strict();
export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;

export const SetCredentialRequestSchema = z
  .object({
    value: z
      .string()
      .min(1)
      .max(8 * 1024)
      .optional(),
    configuration_set: ConfigurationSchema.optional(),
    configuration_clear: z.array(z.string().min(1)).max(64).optional(),
  })
  .strict()
  .refine(
    (request) =>
      request.value !== undefined ||
      Object.keys(request.configuration_set ?? {}).length > 0 ||
      (request.configuration_clear?.length ?? 0) > 0,
    { message: "configuration_set or configuration_clear is required" },
  );
export type SetCredentialRequest = z.infer<typeof SetCredentialRequestSchema>;

export const CreateBindingRequestSchema = z
  .object({
    target_kind: BindingTargetKindSchema,
    target_id: z.string().min(1),
    target_label: z.string().min(1).optional(),
  })
  .strict();
export type CreateBindingRequest = z.infer<typeof CreateBindingRequestSchema>;

export const UpdateConnectionPolicyRequestSchema = z
  .object({
    shareability: ConnectionShareabilitySchema,
    max_invoke_level: z.number().int().min(1).max(2),
  })
  .strict();
export type UpdateConnectionPolicyRequest = z.infer<
  typeof UpdateConnectionPolicyRequestSchema
>;

export const ListProvidersResponseSchema = z
  .object({
    providers: z.array(ProviderSchema),
  })
  .strict();
export type ListProvidersResponse = z.infer<typeof ListProvidersResponseSchema>;

export const ListConnectionsResponseSchema = z
  .object({
    connections: z.array(ConnectionSchema),
  })
  .strict();
export type ListConnectionsResponse = z.infer<
  typeof ListConnectionsResponseSchema
>;

export const DiscoverConnectionsResponseSchema = z
  .object({
    configured: z.number().int().nonnegative(),
  })
  .strict();
export type DiscoverConnectionsResponse = z.infer<
  typeof DiscoverConnectionsResponseSchema
>;

export const AuthorizeResponseSchema = z
  .object({
    authorization_url: z.string().url(),
    state: z.string().min(1),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;

export const ProviderRevocationSchema = z.enum(["ok", "unsupported", "failed"]);
export type ProviderRevocation = z.infer<typeof ProviderRevocationSchema>;

export const RevokeResponseSchema = z
  .object({
    revoked: z.boolean(),
    provider_revocation: ProviderRevocationSchema,
  })
  .strict();
export type RevokeResponse = z.infer<typeof RevokeResponseSchema>;

export const ListEventsResponseSchema = z
  .object({
    events: z.array(ConnectionEventSchema),
  })
  .strict();
export type ListEventsResponse = z.infer<typeof ListEventsResponseSchema>;

export const ConnectionErrorCodeSchema = z.enum([
  "catalog_unavailable",
  "provider_unknown",
  "provider_unconfigured",
  "connection_not_found",
  "integration_not_found",
  "integration_required",
  "integration_conflict",
  "integration_read_only",
  "integration_in_use",
  "invalid_state",
  "state_expired",
  "exchange_failed",
  "not_refreshable",
  "needs_reauth",
  "redirect_not_allowed",
  "binding_exists",
  "binding_not_found",
  "sync_target_not_found",
  "unsupported_credential",
  "invalid_request",
  "internal_error",
  "unauthorized",
  "forbidden",
]);
export type ConnectionErrorCode = z.infer<typeof ConnectionErrorCodeSchema>;

export const ConnectionErrorResponseSchema = z
  .object({
    error: ConnectionErrorCodeSchema,
    hint: z.string(),
  })
  .strict();
export type ConnectionErrorResponse = z.infer<
  typeof ConnectionErrorResponseSchema
>;
