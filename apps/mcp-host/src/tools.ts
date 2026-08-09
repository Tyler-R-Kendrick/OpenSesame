import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export const hostTools = [
  "task_start",
  "task_status",
  "task_invoke",
  "task_terminate",
  "daemon_status",
  "host_ready",
  "operator_invoke_l1",
] as const;

export function assertsNoSecretTools(names: readonly string[]): void {
  if (names.some((n) => /secret|materialize/i.test(n))) {
    throw new Error("secret_tools_forbidden");
  }
}

const capabilitySchema = z.object({
  action: z.string(),
  resource: z.string(),
});

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
        if (res.ok) {
          updateTaskFromResponse(body);
        }
        return {
          content: textContent(forAgent(JSON.stringify(body))),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError("task_start_failed", e);
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
        if (res.ok) {
          // A status read refreshes the active task; it does not switch to another.
          updateTaskFromResponse(body, { adopt: false });
        }
        return {
          content: textContent(forAgent(JSON.stringify(body))),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError("task_status_failed", e);
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
        if (res.ok) {
          setTaskContext({
            taskRunId: ctx.taskRunId,
            stateVersion: body.task_state_version ?? ctx.stateVersion,
            frozenIntent: {
              intentId: body.intent_id,
              intentDigest: body.intent_digest,
              operation,
              resource,
              audience,
              canonicalArguments: body.canonical_arguments ?? args,
            },
          });
        }
        return {
          content: textContent(forAgent(JSON.stringify(body))),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError("task_invoke_failed", e);
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
          content: textContent(forAgent(JSON.stringify(body))),
          isError: !res.ok,
        };
      } catch (e) {
        return toolError("task_terminate_failed", e);
      }
    },
  );

  server.tool("daemon_status", "Probe local host daemon", {}, async () => {
    try {
      const res = await daemonFetch("/v1/toolbar/status");
      const body = await res.json();
      return { content: textContent(forAgent(JSON.stringify(body))) };
    } catch (e) {
      return toolError("daemon_unavailable", e);
    }
  });

  server.tool("host_ready", "Host API readiness", {}, async () => {
    try {
      const res = await hostFetch("/health/ready");
      const text = await res.text();
      return {
        content: textContent(
          forAgent(
            JSON.stringify({
              status: res.status,
              body: text,
              tools: hostTools,
            }),
          ),
        ),
      };
    } catch (e) {
      return toolError("host_unavailable", e);
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
        // The digest has been spent. Keeping it in context invites a second call
        // that can only be refused, and describes authority that no longer exists.
        clearFrozenIntent();
        return {
          content: textContent(forAgent(JSON.stringify(body))),
          isError: !res.ok || body?.error === "materialize_denied",
        };
      } catch (e) {
        return toolError("operator_invoke_failed", e);
      }
    },
  );
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function toolError(label: string, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return {
    // An error message can carry a URL, a header, or a quoted request body, so it
    // goes through the same fence as a success. A refusal here is reported as the
    // refusal it is rather than being retried into the model's context.
    content: textContent(scrubLocalSecrets(`${label}: ${message}`)),
    isError: true,
  };
}
