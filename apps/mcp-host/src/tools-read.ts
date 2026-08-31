/**
 * Read-only Host API tools (registry parity, ADR 0065). Every handler goes
 * through the same seams as tools.ts: hostFetch for transport, a per-tool Zod
 * response allowlist projected via agentJson so unknown upstream fields are
 * structurally incapable of reaching agent context
 * (docs/security/audit-2026-08-22-mcp-response-minimization.md).
 *
 * tools.ts imports this module while this module imports the shared fence
 * helpers back from tools.ts. That cycle is deliberate and safe: everything
 * here that touches a tools.ts binding does so inside registerReadTools,
 * which only runs after both modules have finished evaluating.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostFetch } from "./host-api.js";
import { agentJson, safeTokenSchema, textContent, toolError } from "./tools.js";

/** RFC3339-ish timestamps in either `Z` or `+00:00` spelling, nothing wordier. */
const TIMESTAMP_PATTERN = /^[0-9:.TZ+-]{10,40}$/;
/** Grant scopes may carry wildcards on top of the opaque-token alphabet. */
const SCOPE_PATTERN = /^[A-Za-z0-9:._/*-]{1,256}$/;

export function registerReadTools(server: McpServer): void {
  const timeSchema = z.string().regex(TIMESTAMP_PATTERN);
  const scopeSchema = z.string().regex(SCOPE_PATTERN);

  /**
   * Expiry lifecycle (ADR 0074). Metadata only by construction upstream, and
   * narrowed again here: the Host's hook views never carry a signing secret,
   * and this allowlist would drop one if a future field tried to.
   */
  const lifecycleSubjectSchema = z.object({
    subject_kind: safeTokenSchema,
    subject_id: scopeSchema,
    organization_id: safeTokenSchema.optional(),
    label: z.string().max(128).nullable().optional(),
    expires_at: timeSchema.optional(),
    remaining_seconds: z.number().int().optional(),
    renew_before_seconds: z.number().int().optional(),
    auto_respond: z.boolean().optional(),
    responder: safeTokenSchema.nullable().optional(),
    alerting: z.boolean().optional(),
    ladder: z
      .array(
        z.object({
          stage: safeTokenSchema,
          track: safeTokenSchema,
          event_type: scopeSchema,
          fires_at: timeSchema.nullable().optional(),
          crossed: z.boolean().optional(),
        }),
      )
      .max(16)
      .optional(),
  });

  const lifecycleExpiringResponseSchema = z.object({
    subjects: z.array(lifecycleSubjectSchema).max(512),
    event_types: z.array(scopeSchema).max(32).optional(),
    subject_kinds: z.array(safeTokenSchema).max(32).optional(),
    stages: z.array(safeTokenSchema).max(32).optional(),
  });

  // A run is metadata: which relying party, which rung of the ladder, where the
  // control lease is. Deliberately no lane bodies — the observation log is
  // sealed to the owner's viewer key and excluded from every agent surface
  // (ADR 0078 §8), so there is no field here that could carry one.
  const agentRunSchema = z.object({
    id: safeTokenSchema,
    job_id: safeTokenSchema.optional(),
    origin: z.string().max(2048),
    tier: safeTokenSchema.optional(),
    control_state: safeTokenSchema,
    quiescence: safeTokenSchema.optional(),
    handoff_queued: z.boolean().optional(),
    driver: safeTokenSchema.optional(),
    lease_expires_at: z.string().max(64).nullable().optional(),
    blocked_reason: z.string().max(256).nullable().optional(),
    next_seq: z.number().int().optional(),
    expires_at: z.string().max(64).optional(),
    closed_at: z.string().max(64).nullable().optional(),
    version: z.number().int().optional(),
    created_at: z.string().max(64).optional(),
    updated_at: z.string().max(64).optional(),
    secrets_returned: z.literal(false).optional(),
    observation_included: z.literal(false).optional(),
  });

  const agentRunsResponseSchema = z.object({
    runs: z.array(agentRunSchema).max(256),
    secrets_returned: z.literal(false).optional(),
  });

  const lifecycleHooksResponseSchema = z.object({
    hooks: z
      .array(
        z.object({
          id: safeTokenSchema,
          name: z.string().max(120),
          organization_id: safeTokenSchema.optional(),
          event_types: z.array(scopeSchema).max(32).optional(),
          delivery: safeTokenSchema.optional(),
          endpoint_url: z.string().max(2048).nullable().optional(),
          subject_kinds: z.array(safeTokenSchema).max(32).nullable().optional(),
          enabled: z.boolean().optional(),
          last_delivered_at: timeSchema.nullable().optional(),
          last_error: z.string().max(160).nullable().optional(),
        }),
      )
      .max(256),
  });

  const lifecycleDeliveriesResponseSchema = z.object({
    deliveries: z
      .array(
        z.object({
          id: safeTokenSchema,
          hook_id: safeTokenSchema,
          event_type: scopeSchema,
          subject_kind: safeTokenSchema,
          subject_id: scopeSchema,
          state: safeTokenSchema,
          attempts: z.number().int().nonnegative().optional(),
          available_at: timeSchema.nullable().optional(),
          last_error: z.string().max(160).nullable().optional(),
          delivered_at: timeSchema.nullable().optional(),
          created_at: timeSchema.optional(),
        }),
      )
      .max(256),
  });

  const taskListResponseSchema = z.object({
    tasks: z
      .array(
        z.object({
          task_run_id: safeTokenSchema,
          state_version: z.number().int().nonnegative().optional(),
          status: safeTokenSchema.optional(),
          principal_id: safeTokenSchema.optional(),
        }),
      )
      .max(256),
  });

  const receiptResponseSchema = z.object({
    id: safeTokenSchema,
    invocation_id: safeTokenSchema.optional(),
    intent_digest: safeTokenSchema.optional(),
    principal_id: safeTokenSchema.optional(),
    organization_id: safeTokenSchema.optional(),
    actor_id: safeTokenSchema.optional(),
    connection_id: safeTokenSchema.nullable().optional(),
    delegation_chain: z.array(safeTokenSchema).max(32).optional(),
    operation: scopeSchema.optional(),
    resource: scopeSchema.optional(),
    policy_decision_id: safeTokenSchema.optional(),
    policy_version_digest: safeTokenSchema.optional(),
    outcome: z.enum(["succeeded", "failed", "denied", "cancelled"]).optional(),
    started_at: timeSchema.optional(),
    completed_at: timeSchema.optional(),
    authority_key_id: safeTokenSchema.optional(),
    receipt_schema_version: z.number().int().nonnegative().optional(),
    task_run_id: safeTokenSchema.optional(),
    task_state_version: z.number().int().nonnegative().optional(),
  });

  const receiptVerifyResponseSchema = z.object({ valid: z.boolean() });

  const delegationViewSchema = z.object({
    id: safeTokenSchema,
    offer_id: safeTokenSchema.optional(),
    connection_id: safeTokenSchema.optional(),
    claimant_subject: safeTokenSchema.optional(),
    grant_id: safeTokenSchema.optional(),
    execution_mode: z.enum(["broker", "relay"]).optional(),
    actions: z.array(scopeSchema).max(64).optional(),
    resources: z.array(scopeSchema).max(64).optional(),
    expires_at: timeSchema.optional(),
    revoked_at: timeSchema.nullable().optional(),
  });

  const delegationListResponseSchema = z.object({
    delegations: z.array(delegationViewSchema).max(256),
  });

  const offerListResponseSchema = z.object({
    offers: z
      .array(
        z.object({
          id: safeTokenSchema,
          state: safeTokenSchema.optional(),
          manifest_digest: safeTokenSchema.optional(),
          expires_at: timeSchema.optional(),
          items: z
            .array(
              z.object({
                id: safeTokenSchema,
                connection_id: safeTokenSchema.optional(),
                provider_id: safeTokenSchema.optional(),
                actions: z.array(scopeSchema).max(64).optional(),
                resources: z.array(scopeSchema).max(64).optional(),
                expires_in_seconds: z.number().int().optional(),
                execution_mode: z.enum(["broker", "relay"]).optional(),
                required: z.boolean().optional(),
                dependencies: z.array(safeTokenSchema).max(32).optional(),
              }),
            )
            .max(64)
            .optional(),
        }),
      )
      .max(256),
  });

  const relayPendingResponseSchema = z.object({
    requests: z
      .array(
        // Deliberately no `parameters`: the delegate authored them, which is
        // exactly the free-form channel this projection exists to close.
        z.object({
          id: safeTokenSchema,
          delegation_id: safeTokenSchema.optional(),
          connection_id: safeTokenSchema.optional(),
          operation: scopeSchema.optional(),
          resource: scopeSchema.optional(),
          request_digest: safeTokenSchema.optional(),
          state: safeTokenSchema.optional(),
        }),
      )
      .max(64),
  });

  const providerListResponseSchema = z.object({
    providers: z
      .array(
        z.object({
          id: safeTokenSchema,
          category: safeTokenSchema.optional(),
          auth_kind: safeTokenSchema.optional(),
          supports_refresh: z.boolean().optional(),
          configured: z.boolean().optional(),
          auto_configurable: z.boolean().optional(),
          operations: z.array(scopeSchema).max(128).optional(),
        }),
      )
      .max(512),
  });

  const connectionViewSchema = z.object({
    connection_id: safeTokenSchema,
    connection_ref: safeTokenSchema.optional(),
    integration_id: safeTokenSchema.nullable().optional(),
    logical_name: safeTokenSchema.optional(),
    provider_id: safeTokenSchema.optional(),
    status: safeTokenSchema.optional(),
    organization_id: safeTokenSchema.optional(),
    project_id: safeTokenSchema.nullable().optional(),
    owner_kind: safeTokenSchema.optional(),
    shareability: safeTokenSchema.optional(),
    requested_scopes: z.array(scopeSchema).max(64).optional(),
    granted_scopes: z.array(scopeSchema).max(64).optional(),
    expires_at: timeSchema.nullable().optional(),
    refreshable: z.boolean().optional(),
    last_refreshed_at: timeSchema.nullable().optional(),
    max_invoke_level: z.number().int().nonnegative().optional(),
  });

  const connectionListResponseSchema = z.object({
    connections: z.array(connectionViewSchema).max(256),
  });

  const connectionEventsResponseSchema = z.object({
    events: z
      .array(
        z.object({
          id: safeTokenSchema,
          kind: safeTokenSchema.optional(),
          at: timeSchema.optional(),
        }),
      )
      .max(256),
  });

  const certListResponseSchema = z.object({
    certificates: z
      .array(
        z.object({
          id: safeTokenSchema.optional(),
          serial: safeTokenSchema.optional(),
          common_name: scopeSchema.optional(),
          dns_names: z.array(scopeSchema).max(32).optional(),
          not_before: timeSchema.optional(),
          not_after: timeSchema.optional(),
          issued_at: timeSchema.optional(),
          issuer_kind: safeTokenSchema.optional(),
          trust_scope: safeTokenSchema.optional(),
        }),
      )
      .max(256),
  });

  const configKeyMetaSchema = z.object({
    key_name: safeTokenSchema,
    version: z.number().int().nonnegative().optional(),
    updated_at: timeSchema.optional(),
  });

  // Metadata, key names, history, and diff only: no field in any branch can
  // hold a config value, so value leakage is structurally impossible here.
  const configReadResponseSchema = z.object({
    configs: z
      .array(
        z.object({
          id: safeTokenSchema,
          project_id: safeTokenSchema.optional(),
          slug: safeTokenSchema.optional(),
          environment: safeTokenSchema.optional(),
          parent_config_id: safeTokenSchema.nullable().optional(),
          created_at: timeSchema.optional(),
          updated_at: timeSchema.optional(),
        }),
      )
      .max(256)
      .optional(),
    keys: z.array(configKeyMetaSchema).max(512).optional(),
    versions: z
      .array(
        z.object({
          version: z.number().int().nonnegative(),
          deleted: z.boolean().optional(),
          actor_id: safeTokenSchema.nullable().optional(),
          created_at: timeSchema.optional(),
        }),
      )
      .max(512)
      .optional(),
    only_in_a: z.array(safeTokenSchema).max(512).optional(),
    only_in_b: z.array(safeTokenSchema).max(512).optional(),
    in_both: z
      .array(
        z.object({
          key_name: safeTokenSchema,
          a_version: z.number().int().nonnegative().optional(),
          b_version: z.number().int().nonnegative().optional(),
        }),
      )
      .max(512)
      .optional(),
  });

  const syncTargetListResponseSchema = z.object({
    sync_targets: z
      .array(
        z.object({
          id: safeTokenSchema,
          project_id: safeTokenSchema.optional(),
          config_id: safeTokenSchema.optional(),
          connection_id: safeTokenSchema.optional(),
          provider_id: safeTokenSchema.optional(),
          operation: scopeSchema.optional(),
          status: safeTokenSchema.optional(),
          content_version: safeTokenSchema.nullable().optional(),
          last_synced_at: timeSchema.nullable().optional(),
          created_at: timeSchema.optional(),
          updated_at: timeSchema.optional(),
        }),
      )
      .max(256),
  });

  const rotationTargetSchema = z.object({
    connection: z.object({ connection_id: safeTokenSchema }).optional(),
    store_path: z.object({ path: scopeSchema }).optional(),
  });

  const rotationReadResponseSchema = z.object({
    rotations: z
      .array(
        z.object({
          id: safeTokenSchema,
          policy_id: safeTokenSchema.nullable().optional(),
          organization_id: safeTokenSchema.optional(),
          target: rotationTargetSchema.optional(),
          state: safeTokenSchema.optional(),
          status: safeTokenSchema.optional(),
          created_at: timeSchema.optional(),
          updated_at: timeSchema.optional(),
        }),
      )
      .max(256)
      .optional(),
    policies: z
      .array(
        z.object({
          id: safeTokenSchema,
          organization_id: safeTokenSchema.optional(),
          target: rotationTargetSchema.optional(),
          interval_seconds: z.number().int().nonnegative().optional(),
          last_rotated_at: timeSchema.nullable().optional(),
          enabled: z.boolean().optional(),
          created_at: timeSchema.optional(),
          updated_at: timeSchema.optional(),
        }),
      )
      .max(256)
      .optional(),
    secrets_returned: z.literal(false).optional(),
  });

  const changelogResponseSchema = z.object({
    project_id: safeTokenSchema.optional(),
    events: z
      .array(
        z.object({
          seq: z.number().int().optional(),
          id: safeTokenSchema,
          event_type: safeTokenSchema.optional(),
          project_id: safeTokenSchema.optional(),
          organization_id: safeTokenSchema.nullable().optional(),
          actor_id: safeTokenSchema.nullable().optional(),
          config_id: safeTokenSchema.nullable().optional(),
          environment: safeTokenSchema.nullable().optional(),
          key_names: z.array(safeTokenSchema).max(128).optional(),
          version_id: safeTokenSchema.nullable().optional(),
          target_id: safeTokenSchema.nullable().optional(),
          content_version: safeTokenSchema.nullable().optional(),
          occurred_at: timeSchema.optional(),
        }),
      )
      .max(256),
    next_before_seq: z.number().int().nullable().optional(),
  });

  // Provider/repo/status posture only — a backup target's credential lives in
  // its connection, and nothing token-shaped is ever part of this projection.
  const backupStatusResponseSchema = z.object({
    target: z
      .object({
        kind: safeTokenSchema.optional(),
        provider_id: safeTokenSchema.nullable().optional(),
        connection_id: safeTokenSchema.nullable().optional(),
        integration_id: safeTokenSchema.nullable().optional(),
        installation_id: safeTokenSchema.nullable().optional(),
        owner: safeTokenSchema.optional(),
        repo: safeTokenSchema.optional(),
        branch: safeTokenSchema.optional(),
        enabled: z.boolean().optional(),
        status: safeTokenSchema.optional(),
        last_commit_sha: safeTokenSchema.nullable().optional(),
        last_synced_at: timeSchema.nullable().optional(),
      })
      .nullable()
      .optional(),
    pending_events: z.number().int().nonnegative().optional(),
  });

  server.tool(
    "task_list",
    "List the caller's task runs (ids, state versions, status; never intents or secrets)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/tasks");
        const body = await res.json();
        return {
          content: textContent(agentJson(body, res.ok, taskListResponseSchema)),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "task_list_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "receipt_read",
    "Read one invocation receipt by id (identifiers, digests, outcome; never result bodies)",
    { receipt_id: safeTokenSchema },
    async ({ receipt_id }) => {
      try {
        const res = await hostFetch(
          `/api/v1/receipts/${encodeURIComponent(receipt_id)}`,
        );
        const body = await res.json();
        return {
          content: textContent(agentJson(body, res.ok, receiptResponseSchema)),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "receipt_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "receipt_verify",
    "Verify a receipt's signature against the Host authority keys",
    { receipt_id: safeTokenSchema },
    async ({ receipt_id }) => {
      try {
        const res = await hostFetch(
          `/api/v1/receipts/${encodeURIComponent(receipt_id)}/verify`,
          { method: "POST" },
        );
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, receiptVerifyResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "receipt_verify_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "delegation_read",
    "List delegations where the caller is owner or claimant (grant ids and scopes, never token bytes)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/delegations");
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, delegationListResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "delegation_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "delegation_offer_read",
    "List delegation offers the caller minted (states and item scopes; claim tokens are never re-shown)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/delegations/offers");
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, offerListResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "delegation_offer_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "relay_request_read",
    "Read pending relay approval requests addressed to the caller (metadata and digests only)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/relay/requests/pending");
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, relayPendingResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "relay_request_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "provider_read",
    "Browse the provider catalog (ids, categories, auth kinds, operations)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/providers");
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, providerListResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "provider_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "connection_read",
    "List connections, inspect one, or read one connection's event log (ConnectionRefs only, never credentials)",
    {
      connection_id: safeTokenSchema.optional(),
      include_events: z.boolean().optional(),
    },
    async ({ connection_id, include_events }) => {
      try {
        if (include_events && !connection_id) {
          throw new Error("connection_id_required_for_events");
        }
        const path = connection_id
          ? `/api/v1/connections/${encodeURIComponent(connection_id)}${include_events ? "/events" : ""}`
          : "/api/v1/connections";
        const res = await hostFetch(path);
        const body = await res.json();
        const schema = include_events
          ? connectionEventsResponseSchema
          : connection_id
            ? connectionViewSchema
            : connectionListResponseSchema;
        return {
          content: textContent(agentJson(body, res.ok, schema)),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "connection_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "cert_read",
    "List issued certificates (serials, names, validity; never key material)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/certs");
        const body = await res.json();
        return {
          content: textContent(agentJson(body, res.ok, certListResponseSchema)),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "cert_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "config_read",
    "Browse secret-config metadata: configs for a project, key names/versions for a config, one key's history, or a two-config diff — never values",
    {
      project_id: safeTokenSchema.optional(),
      config_id: safeTokenSchema.optional(),
      key: safeTokenSchema.optional(),
      compare_with: safeTokenSchema.optional(),
    },
    async ({ project_id, config_id, key, compare_with }) => {
      try {
        let path: string;
        if (config_id && compare_with) {
          path = `/api/v1/configs/${encodeURIComponent(config_id)}/compare/${encodeURIComponent(compare_with)}`;
        } else if (config_id && key) {
          path = `/api/v1/configs/${encodeURIComponent(config_id)}/secrets/${encodeURIComponent(key)}/versions`;
        } else if (config_id) {
          path = `/api/v1/configs/${encodeURIComponent(config_id)}/secrets`;
        } else if (project_id) {
          path = `/api/v1/projects/${encodeURIComponent(project_id)}/configs`;
        } else {
          throw new Error("project_id_or_config_id_required");
        }
        const res = await hostFetch(path);
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, configReadResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "config_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "sync_target_read",
    "Read replication sync targets (ids, status, versions; never secrets)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/sync-targets");
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, syncTargetListResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "sync_target_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "rotation_read",
    "Read the rotation queue or the durable rotation policies (metadata only)",
    { view: z.enum(["jobs", "policies"]).optional() },
    async ({ view }) => {
      try {
        const path =
          view === "policies"
            ? "/api/v1/rotation/policies"
            : "/api/v1/rotations";
        const res = await hostFetch(path);
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, rotationReadResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "rotation_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "changelog_read",
    "Read a project's secret/config changelog feed (event metadata, never values)",
    {
      project_id: safeTokenSchema,
      limit: z.number().int().min(1).max(200).optional(),
      before_seq: z.number().int().nonnegative().optional(),
    },
    async ({ project_id, limit, before_seq }) => {
      try {
        const query = new URLSearchParams({ limit: String(limit ?? 50) });
        if (before_seq !== undefined) {
          query.set("before_seq", String(before_seq));
        }
        const res = await hostFetch(
          `/api/v1/projects/${encodeURIComponent(project_id)}/changelog?${query.toString()}`,
        );
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, changelogResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "changelog_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "backup_status",
    "Read the server-side backup posture (provider, repo, status; never target credentials)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/backup/target");
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, backupStatusResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "backup_status_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "lifecycle_expiring_read",
    "Read every tracked expiry deadline and where it sits on the alert and renewal ladders (metadata only)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/lifecycle/expiring");
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, lifecycleExpiringResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "lifecycle_expiring_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "agent_runs_read",
    "Read sandboxed agent runs and where each one is — relying party, tier, control state, and whether it is blocked waiting for a person. Metadata only: the observation log itself is sealed to its owner and is not available on any agent surface",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/agent/runs");
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, agentRunsResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "agent_runs_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "lifecycle_hooks_read",
    "Read registered expiry lifecycle subscriptions (never their signing secrets)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/lifecycle/hooks");
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, lifecycleHooksResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "lifecycle_hooks_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "lifecycle_deliveries_read",
    "Read the outbound lifecycle delivery ledger — which hook received what, and whether it landed",
    { limit: z.number().int().min(1).max(500).optional() },
    async ({ limit }) => {
      try {
        const query = new URLSearchParams({ limit: String(limit ?? 50) });
        const res = await hostFetch(
          `/api/v1/lifecycle/deliveries?${query.toString()}`,
        );
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, lifecycleDeliveriesResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "lifecycle_deliveries_read_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );
}
