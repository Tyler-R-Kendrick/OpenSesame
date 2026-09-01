import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { forAgent, scrubLocalSecrets } from "./agent-payload.js";
import { daemonFetch, hostFetch } from "./host-api.js";
import {
  clearFrozenIntent,
  getTaskContext,
  requireFrozenIntent,
  requireTaskRunId,
  setTaskContext,
  updateTaskFromResponse,
} from "./task-context.js";
import { registerActTools } from "./tools-act.js";
import { registerReadTools } from "./tools-read.js";

export const hostTools = [
  "task_start",
  "task_status",
  "task_invoke",
  "task_terminate",
  "daemon_status",
  "host_ready",
  "operator_invoke_l1",
  "task_list",
  "receipt_read",
  "receipt_verify",
  "delegation_read",
  "delegation_offer_read",
  "relay_request_read",
  "provider_read",
  "connection_read",
  "cert_read",
  "config_read",
  "sync_target_read",
  "rotation_read",
  "agent_runs_read",
  "ceremony_catalog_read",
  "lifecycle_expiring_read",
  "lifecycle_hooks_read",
  "lifecycle_deliveries_read",
  "security_findings_read",
  "changelog_read",
  "backup_status",
  "delegation_narrow",
  "delegation_revoke",
  "connection_rotate",
  "connection_remove",
  "provider_test",
  "cert_issue",
  "config_set",
  "config_rollback",
  "sync_push",
  "sync_pull",
  "rotation_trigger",
  "lifecycle_scan",
  "security_breach_scan",
] as const;

export function assertsNoSecretTools(names: readonly string[]): void {
  if (
    names.some((n) =>
      /secret|materialize|pass_show|sealed_store_show|password_store_read|^show$/i.test(
        n,
      ),
    )
  ) {
    throw new Error("secret_tools_forbidden");
  }
}

const capabilitySchema = z.object({
  action: z.string(),
  resource: z.string(),
});

export const safeTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9:._/-]{1,512}$/, "invalid opaque identifier");

const taskStateResponseSchema = z.object({
  task_run_id: safeTokenSchema.optional(),
  state_version: z.number().int().nonnegative().optional(),
  state_digest: safeTokenSchema.optional(),
  ceiling_digest: safeTokenSchema.optional(),
  status: z
    .enum([
      "pending",
      "active",
      "restricting",
      "completed",
      "failed",
      "cancelled",
    ])
    .optional(),
  capabilities: z.array(capabilitySchema).max(64).optional(),
  capability_ceiling: z.array(capabilitySchema).max(64).optional(),
  current_capabilities: z.array(capabilitySchema).max(64).optional(),
  maximum_expires_at: z.string().datetime().optional(),
});

const intentResponseSchema = z.object({
  intent_id: safeTokenSchema,
  intent_digest: safeTokenSchema,
  task_run_id: safeTokenSchema.optional(),
  task_state_version: z.number().int().nonnegative().optional(),
  canonical_arguments: z.unknown().optional(),
});
const intentAgentResponseSchema = intentResponseSchema.omit({
  canonical_arguments: true,
});

const daemonStatusResponseSchema = z.object({
  daemon: z.literal("ok"),
  uptime_s: z.number().nonnegative().optional(),
  sessions: z.number().int().nonnegative().optional(),
  capabilities: z.number().int().nonnegative().optional(),
  materialize: z.literal("denied_by_default").optional(),
  approvals: z
    .array(z.enum(["approve_device", "approve_claim"]))
    .max(2)
    .optional(),
  auth: z.literal("operator_token_required_for_mutations").optional(),
});

export const errorResponseSchema = z.object({ error: safeTokenSchema });

export function registerHostTools(server: McpServer): void {
  assertsNoSecretTools(hostTools);

  server.tool(
    "task_start",
    "Start a task with an immutable capability ceiling (Host API). Returns task_run_id for later invoke.",
    {
      principal_id: z.string(),
      organization_id: z.string(),
      // Bounds mirror the Host API's: a ceiling is a short list, and a task's
      // authority should not outlive the reason it was granted.
      capabilities: z.array(capabilitySchema).min(1).max(64),
      ttl_seconds: z.number().int().positive().max(86_400).optional(),
    },
    async ({ principal_id, organization_id, capabilities, ttl_seconds }) => {
      try {
        const res = await hostFetch("/api/v1/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            principal_id,
            organization_id,
            capabilities,
            ttl_seconds: ttl_seconds ?? 3600,
          }),
        });
        const body = await res.json();
        const taskState = taskStateResponseSchema.safeParse(body);
        if (
          res.ok &&
          taskState.success &&
          taskState.data.task_run_id !== undefined &&
          taskState.data.state_version !== undefined
        ) {
          updateTaskFromResponse({
            task_run_id: taskState.data.task_run_id,
            state_version: taskState.data.state_version,
          });
        }
        return {
          content: textContent(
            agentJson(body, res.ok, taskStateResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "task_start_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "task_status",
    "Show ceiling vs current capabilities for a task (defaults to active task context)",
    {
      task_run_id: z.string().optional(),
    },
    async ({ task_run_id }) => {
      try {
        const id = task_run_id ?? requireTaskRunId();
        const res = await hostFetch(`/api/v1/tasks/${encodeURIComponent(id)}`);
        const body = await res.json();
        const taskState = taskStateResponseSchema.safeParse(body);
        if (
          res.ok &&
          taskState.success &&
          taskState.data.task_run_id !== undefined &&
          taskState.data.state_version !== undefined
        ) {
          // A status read refreshes the active task; it does not switch to another.
          updateTaskFromResponse(
            {
              task_run_id: taskState.data.task_run_id,
              state_version: taskState.data.state_version,
            },
            { adopt: false },
          );
        }
        return {
          content: textContent(
            agentJson(body, res.ok, taskStateResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "task_status_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "task_invoke",
    "Freeze a task-bound intent (stores frozen intent in MCP task context)",
    {
      operation: z.string(),
      resource: z.string(),
      audience: z.string(),
      arguments: z.record(z.unknown()).default({}),
      idempotency_key: z.string().optional(),
    },
    async ({
      operation,
      resource,
      audience,
      arguments: args,
      idempotency_key,
    }) => {
      try {
        const ctx = getTaskContext();
        if (!ctx?.taskRunId) {
          throw new Error("task_context_required");
        }
        const res = await hostFetch("/api/v1/tasks/intents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            task_run_id: ctx.taskRunId,
            expected_state_version: ctx.stateVersion,
            operation,
            resource,
            audience,
            arguments: args,
            idempotency_key: idempotency_key ?? crypto.randomUUID(),
          }),
        });
        const body = await res.json();
        const intentResponse = intentResponseSchema.safeParse(body);
        if (res.ok && intentResponse.success) {
          setTaskContext({
            taskRunId: ctx.taskRunId,
            stateVersion:
              intentResponse.data.task_state_version ?? ctx.stateVersion,
            frozenIntent: {
              intentId: intentResponse.data.intent_id,
              intentDigest: intentResponse.data.intent_digest,
              operation,
              resource,
              audience,
              canonicalArguments:
                intentResponse.data.canonical_arguments ?? args,
            },
          });
        }
        return {
          content: textContent(
            agentJson(body, res.ok, intentAgentResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "task_invoke_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool(
    "task_terminate",
    "Terminate task run — no further capability assertions",
    {
      task_run_id: z.string().optional(),
      expected_state_version: z.number().int().optional(),
    },
    async ({ task_run_id, expected_state_version }) => {
      try {
        const id = task_run_id ?? requireTaskRunId();
        const ctx = getTaskContext();
        const res = await hostFetch(
          `/api/v1/tasks/${encodeURIComponent(id)}/terminate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expected_state_version:
                expected_state_version ?? ctx?.stateVersion ?? undefined,
            }),
          },
        );
        const body = await res.json();
        if (res.ok && ctx?.taskRunId === id) {
          setTaskContext(null);
        }
        return {
          content: textContent(
            agentJson(body, res.ok, taskStateResponseSchema),
          ),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError(
          "task_terminate_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  server.tool("daemon_status", "Probe local host daemon", {}, async () => {
    try {
      const res = await daemonFetch("/v1/toolbar/status");
      const body = await res.json();
      const result = {
        content: textContent(
          agentJson(body, res.ok, daemonStatusResponseSchema),
        ),
      };
      if (!res.ok) return { ...result, isError: true };
      return result;
    } catch (e) {
      return toolError(
        "daemon_unavailable",
        e instanceof Error ? e : String(e),
      );
    }
  });

  server.tool("host_ready", "Host API readiness", {}, async () => {
    try {
      const res = await hostFetch("/health/ready");
      return {
        content: textContent(
          forAgent(
            JSON.stringify({
              status: res.status,
              ready: res.ok,
              tools: hostTools,
            }),
          ),
        ),
      };
    } catch (e) {
      return toolError("host_unavailable", e instanceof Error ? e : String(e));
    }
  });

  server.tool(
    "operator_invoke_l1",
    "Policy-gated L1 invoke via daemon — executes the frozen intent in task context, nothing else",
    {
      connection_ref: z.string(),
    },
    async ({ connection_ref }) => {
      try {
        const taskRunId = requireTaskRunId();
        const intent = requireFrozenIntent();
        // Operation, resource, and arguments are whatever was frozen: letting the
        // model restate them here would execute one call while presenting another
        // call's digest.
        const res = await daemonFetch("/v1/operator/invoke_l1", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opensesame-task-run-id": taskRunId,
            "x-opensesame-intent-digest": intent.intentDigest,
          },
          body: JSON.stringify({
            connection_ref,
            invoke_level: 1,
            task_run_id: taskRunId,
            intent_digest: intent.intentDigest,
          }),
        });
        const body = await res.json();
        const errorResponse = errorResponseSchema.safeParse(body);
        // The digest has been spent. Keeping it in context invites a second call
        // that can only be refused, and describes authority that no longer exists.
        clearFrozenIntent();
        return {
          content: textContent(forAgent(JSON.stringify(body) ?? "null")),
          isError:
            !res.ok ||
            (errorResponse.success &&
              errorResponse.data.error === "materialize_denied"),
        };
      } catch (e) {
        return toolError(
          "operator_invoke_failed",
          e instanceof Error ? e : String(e),
        );
      }
    },
  );

  registerReadTools(server);
  registerActTools(server);
}

export function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

export function agentJson(
  body: BoundaryValue,
  ok: boolean,
  successSchema: z.ZodType,
) {
  // Refuse a compromised response containing credential-shaped material even
  // when that field is not part of the agent-visible allowlist.
  forAgent(JSON.stringify(body));
  const parsed = (ok ? successSchema : errorResponseSchema).safeParse(body);
  return forAgent(
    JSON.stringify(
      parsed.success ? parsed.data : { error: "upstream_response_invalid" },
    ),
  );
}

export function toolError(label: string, e: Error | string) {
  const message = e instanceof Error ? e.message : String(e);
  try {
    return {
      content: textContent(forAgent(`${label}: ${message}`)),
      isError: true,
    };
  } catch {
    return {
      content: textContent(`${label}: refused`),
      isError: true,
    };
  }
}

/**
 * Projection-first variant of agentJson, for the one route whose successful
 * body legitimately carries key material by design: cert issuance returns the
 * certificate and private key for out-of-band device delivery. Fencing the
 * raw body first (agentJson) would refuse every successful issuance, so this
 * projects through the allowlist first — which never includes the PEM fields
 * — and the credential fence then runs on the projection, so nothing
 * credential-shaped can survive into agent context either way.
 */
export function agentJsonProjected(
  body: BoundaryValue,
  ok: boolean,
  successSchema: z.ZodType,
) {
  const parsed = (ok ? successSchema : errorResponseSchema).safeParse(body);
  return forAgent(
    JSON.stringify(
      parsed.success ? parsed.data : { error: "upstream_response_invalid" },
    ),
  );
}
