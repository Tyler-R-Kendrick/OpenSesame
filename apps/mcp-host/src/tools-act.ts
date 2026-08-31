/**
 * Consequential (write/act) Host API tools (registry parity, ADR 0065). These
 * are plain authenticated calls like task_terminate — none of them spend a
 * frozen intent, and operator_invoke_l1 in tools.ts stays the only tool that
 * can. Responses go through per-tool Zod allowlists exactly like the read
 * tools (docs/security/audit-2026-08-22-mcp-response-minimization.md); the
 * one deliberate exception is cert_issue, whose successful upstream body
 * carries key material by design and is therefore projected before the
 * credential fence via agentJsonProjected.
 *
 * tools.ts imports this module while this module imports the shared fence
 * helpers back from tools.ts; every tools.ts binding is only touched inside
 * registerActTools, after both modules have evaluated.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { forAgent } from "./agent-payload.js";
import { hostFetch } from "./host-api.js";
import {
  agentJson,
  agentJsonProjected,
  safeTokenSchema,
  textContent,
  toolError,
} from "./tools.js";

const TIMESTAMP_PATTERN = /^[0-9:.TZ+-]{10,40}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9:._/*-]{1,256}$/;
const NAME_PATTERN = /^[A-Za-z0-9.*-]{1,253}$/;
const KEY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
/** Mirrors the gateway's 2 MiB per-blob ciphertext ceiling, base64-expanded. */
const MAX_CIPHERTEXT_B64 = 2_800_000;

export function registerActTools(server: McpServer): void {
  const timeSchema = z.string().regex(TIMESTAMP_PATTERN);
  const scopeSchema = z.string().regex(SCOPE_PATTERN);

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

  const narrowResponseSchema = z.object({ delegation: delegationViewSchema });

  const rotationTargetSchema = z.object({
    connection: z.object({ connection_id: safeTokenSchema }).optional(),
    store_path: z.object({ path: scopeSchema }).optional(),
  });

  const rotationJobResponseSchema = z.object({
    id: safeTokenSchema,
    policy_id: safeTokenSchema.nullable().optional(),
    organization_id: safeTokenSchema.optional(),
    target: rotationTargetSchema.optional(),
    state: safeTokenSchema.optional(),
    status: safeTokenSchema.optional(),
    event_type: safeTokenSchema.optional(),
    created_at: timeSchema.optional(),
    updated_at: timeSchema.optional(),
  });

  const revokeOutcomeResponseSchema = z.object({
    revoked: z.boolean(),
    provider_revocation: z.enum(["ok", "unsupported", "failed"]).optional(),
  });

  const providerProbeResponseSchema = z.object({
    available: z.boolean().optional(),
    live: z.boolean().optional(),
    adapter: safeTokenSchema.optional(),
  });

  // Issuance acknowledgement only. The certificate, private key, and CA
  // bundle in the upstream body are for out-of-band device delivery and must
  // never appear in agent context, so no PEM-bearing field exists here.
  const certIssueResponseSchema = z.object({
    serial: safeTokenSchema.optional(),
    common_name: scopeSchema.optional(),
    dns_names: z.array(scopeSchema).max(32).optional(),
    not_before: timeSchema.optional(),
    not_after: timeSchema.optional(),
    delivery_id: safeTokenSchema.nullable().optional(),
    issuer_kind: safeTokenSchema.optional(),
    purpose: safeTokenSchema.optional(),
    trust_scope: safeTokenSchema.optional(),
    persistent: z.boolean().optional(),
  });

  const configKeysResponseSchema = z.object({
    keys: z
      .array(
        z.object({
          key_name: safeTokenSchema,
          version: z.number().int().nonnegative().optional(),
          updated_at: timeSchema.optional(),
        }),
      )
      .max(512),
  });

  const rollbackResponseSchema = z.object({
    key_name: safeTokenSchema,
    version: z.number().int().nonnegative(),
  });

  const syncPushResponseSchema = z.object({
    accepted: z.number().int().nonnegative().optional(),
    rejected_foreign_owner: z.number().int().nonnegative().optional(),
    rejected_oversize: z.number().int().nonnegative().optional(),
    rejected_session_quota: z.number().int().nonnegative().optional(),
    rejected_stale_epoch: z.number().int().nonnegative().optional(),
    rejected_batch: z.number().int().nonnegative().optional(),
    owner_capacity: z.number().int().nonnegative().optional(),
    max_ciphertext_bytes: z.number().int().nonnegative().optional(),
  });

  const syncPullResponseSchema = z.object({
    blobs: z
      .array(
        z
          .object({
            id: safeTokenSchema,
            epoch: z.number().int().nonnegative(),
            ciphertext: z
              .array(z.number().int().min(0).max(255))
              .max(2_097_152),
          })
          .transform((blob) => ({
            id: blob.id,
            epoch: blob.epoch,
            ciphertext_b64: Buffer.from(blob.ciphertext).toString("base64"),
          })),
      )
      .max(4096),
    device_cursor: z.number().int().nonnegative().nullable().optional(),
  });

  server.tool(
    "delegation_narrow",
    "Narrow a delegation — restriction only; widening is refused by the Host",
    {
      delegation_id: safeTokenSchema,
      actions: z.array(scopeSchema).max(64).optional(),
      resources: z.array(scopeSchema).max(64).optional(),
      expires_in_seconds: z
        .number()
        .int()
        .positive()
        .max(31_536_000)
        .optional(),
    },
    async ({ delegation_id, actions, resources, expires_in_seconds }) => {
      try {
        const res = await hostFetch(
          `/api/v1/delegations/${encodeURIComponent(delegation_id)}/narrow`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ actions, resources, expires_in_seconds }),
          },
        );
        const body = await res.json();
        return {
          content: textContent(agentJson(body, res.ok, narrowResponseSchema)),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "delegation_narrow_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "delegation_revoke",
    "Revoke a delegation, or a delegation offer (and every delegation claimed from it)",
    {
      id: safeTokenSchema,
      kind: z.enum(["delegation", "offer"]).optional(),
    },
    async ({ id, kind }) => {
      try {
        const target = kind ?? "delegation";
        const path =
          target === "offer"
            ? `/api/v1/delegations/offers/${encodeURIComponent(id)}`
            : `/api/v1/delegations/${encodeURIComponent(id)}`;
        const res = await hostFetch(path, { method: "DELETE" });
        if (res.status === 204) {
          return {
            content: textContent(
              forAgent(JSON.stringify({ revoked: true, kind: target, id })),
            ),
          };
        }
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, z.object({ revoked: z.boolean() })),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "delegation_revoke_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "connection_rotate",
    "Enqueue a credential rotation for one connection (never returns secrets)",
    {
      connection_id: safeTokenSchema,
      execute_now: z.boolean().optional(),
    },
    async ({ connection_id, execute_now }) => {
      try {
        const res = await hostFetch("/api/v1/rotations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connection_id,
            execute_now: execute_now ?? false,
          }),
        });
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, rotationJobResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "connection_rotate_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "connection_remove",
    "Revoke a connection — its ConnectionRef stops resolving",
    { connection_id: safeTokenSchema },
    async ({ connection_id }) => {
      try {
        const res = await hostFetch(
          `/api/v1/connections/${encodeURIComponent(connection_id)}`,
          { method: "DELETE" },
        );
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, revokeOutcomeResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "connection_remove_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "provider_test",
    "Probe a credential provider adapter's readiness (booleans only, no probe output)",
    { provider_id: safeTokenSchema },
    async ({ provider_id }) => {
      try {
        const res = await hostFetch(
          `/api/v1/credential-providers/${encodeURIComponent(provider_id)}/test`,
          { method: "POST" },
        );
        if (res.status === 404) {
          return toolError("provider_test_failed", "unknown_provider");
        }
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, providerProbeResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "provider_test_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "cert_issue",
    "Issue a certificate; returns the issuance acknowledgement only — key material is delivered out-of-band, never through this tool",
    {
      common_name: z.string().regex(NAME_PATTERN),
      dns_names: z.array(z.string().regex(NAME_PATTERN)).max(16).optional(),
      ip_addrs: z
        .array(z.string().regex(/^[0-9a-fA-F:.]{2,45}$/))
        .max(16)
        .optional(),
      ttl_hours: z.number().int().positive().max(8760).optional(),
      issuer_connection_id: safeTokenSchema.optional(),
    },
    async ({
      common_name,
      dns_names,
      ip_addrs,
      ttl_hours,
      issuer_connection_id,
    }) => {
      try {
        const res = await hostFetch("/api/v1/certs/issue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            common_name,
            dns_names: dns_names ?? [],
            ip_addrs: ip_addrs ?? [],
            ttl_hours,
            issuer_connection_id,
          }),
        });
        const body = await res.json();
        return {
          content: textContent(
            agentJsonProjected(body, res.ok, certIssueResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "cert_issue_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "config_set",
    "Write secret-config values (write-only intake): values go in, only key names and versions come back",
    {
      config_id: safeTokenSchema,
      secrets: z
        .record(z.string().regex(KEY_NAME_PATTERN), z.string().min(1).max(8192))
        .refine((entries) => {
          const count = Object.keys(entries).length;
          return count >= 1 && count <= 64;
        }, "between 1 and 64 keys per write"),
    },
    async ({ config_id, secrets }) => {
      try {
        const res = await hostFetch(
          `/api/v1/configs/${encodeURIComponent(config_id)}/secrets`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ secrets }),
          },
        );
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, configKeysResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "config_set_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "config_rollback",
    "Roll one secret-config key back to a prior version (re-sealed as a new head version)",
    {
      config_id: safeTokenSchema,
      key: safeTokenSchema,
      to_version: z.number().int().nonnegative(),
    },
    async ({ config_id, key, to_version }) => {
      try {
        const res = await hostFetch(
          `/api/v1/configs/${encodeURIComponent(config_id)}/secrets/${encodeURIComponent(key)}/rollback`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ to_version }),
          },
        );
        const body = await res.json();
        return {
          content: textContent(agentJson(body, res.ok, rollbackResponseSchema)),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "config_rollback_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "sync_push",
    "Push E2EE sync blobs (opaque ciphertext, base64) to the Host API",
    {
      blobs: z
        .array(
          z.object({
            id: safeTokenSchema,
            epoch: z.number().int().nonnegative(),
            ciphertext_b64: z
              .string()
              .min(1)
              .max(MAX_CIPHERTEXT_B64)
              .regex(BASE64_PATTERN),
          }),
        )
        .min(1)
        .max(64),
    },
    async ({ blobs }) => {
      try {
        const res = await hostFetch("/api/v1/sync/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            blobs: blobs.map((blob) => ({
              id: blob.id,
              epoch: blob.epoch,
              ciphertext: Array.from(
                Buffer.from(blob.ciphertext_b64, "base64"),
              ),
            })),
          }),
        });
        const body = await res.json();
        return {
          content: textContent(agentJson(body, res.ok, syncPushResponseSchema)),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "sync_push_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "sync_pull",
    "Pull E2EE sync blobs (opaque ciphertext, base64) from the Host API",
    {
      since_epoch: z.number().int().nonnegative().optional(),
      device_id: safeTokenSchema.optional(),
    },
    async ({ since_epoch, device_id }) => {
      try {
        const res = await hostFetch("/api/v1/sync/pull", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            since_epoch: since_epoch ?? 0,
            device_id,
          }),
        });
        const body = await res.json();
        return {
          content: textContent(agentJson(body, res.ok, syncPullResponseSchema)),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "sync_pull_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "rotation_trigger",
    "Enqueue a rotation run for a connection or a sealed-store path, optionally installing an interval policy",
    {
      connection_id: safeTokenSchema.optional(),
      store_path: scopeSchema.optional(),
      interval: z
        .string()
        .regex(/^[0-9]{1,7}[smhd]?$/)
        .optional(),
      project_id: safeTokenSchema.optional(),
      execute_now: z.boolean().optional(),
    },
    async ({
      connection_id,
      store_path,
      interval,
      project_id,
      execute_now,
    }) => {
      try {
        if (Boolean(connection_id) === Boolean(store_path)) {
          throw new Error("exactly_one_of_connection_id_or_store_path");
        }
        const res = await hostFetch("/api/v1/rotations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connection_id,
            store_path,
            interval,
            project_id,
            execute_now: execute_now ?? false,
          }),
        });
        const body = await res.json();
        return {
          content: textContent(
            agentJson(body, res.ok, rotationJobResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "rotation_trigger_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "lifecycle_scan",
    "Run one expiry lifecycle scan now instead of waiting for the Host tick; idempotent (published counts only newly crossed rungs)",
    {},
    async () => {
      try {
        const res = await hostFetch("/api/v1/lifecycle/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = await res.json();
        return {
          content: textContent(
            agentJson(
              body,
              res.ok,
              z.object({ published: z.number().int().nonnegative() }),
            ),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "lifecycle_scan_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );
}
