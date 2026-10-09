import type { BoundaryValue } from "@opensesame/os-domain";
import type { HostRequestContext } from "./http.js";

export interface TaskCapability {
  action: string;
  resource: string;
}

export interface StartTaskRequest {
  principal_id: string;
  organization_id: string;
  capabilities: TaskCapability[];
  ttl_seconds?: number;
}

export interface CreateTaskIntentRequest {
  task_run_id: string;
  expected_state_version: number;
  operation: string;
  resource: string;
  audience: string;
  arguments: BoundaryValue;
  idempotency_key: string;
}

function taskPath(id: string, suffix = ""): string {
  return `/api/v1/tasks/${encodeURIComponent(id)}${suffix}`;
}

export function tasksApi(ctx: HostRequestContext) {
  return {
    async listTasks(): Promise<BoundaryValue> {
      return ctx.requestJson("tasks", "/api/v1/tasks");
    },

    async getTask(id: string): Promise<BoundaryValue> {
      return ctx.requestJson("task", taskPath(id));
    },

    async startTask(body: StartTaskRequest): Promise<BoundaryValue> {
      return ctx.requestJson("task_start", "/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    async terminateTask(
      id: string,
      expectedStateVersion?: number,
    ): Promise<BoundaryValue> {
      return ctx.requestJson("task_terminate", taskPath(id, "/terminate"), {
        method: "POST",
        body: JSON.stringify(
          expectedStateVersion === undefined
            ? {}
            : { expected_state_version: expectedStateVersion },
        ),
      });
    },

    async createTaskIntent(
      body: CreateTaskIntentRequest,
    ): Promise<BoundaryValue> {
      return ctx.requestJson("task_intent_create", "/api/v1/tasks/intents", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    /** Spend a frozen intent by digest — the server holds the frozen bytes. */
    async invokeTaskIntent(intentDigest: string): Promise<BoundaryValue> {
      return ctx.requestJson("task_intent_invoke", "/api/v1/tasks/invoke", {
        method: "POST",
        body: JSON.stringify({ intent_digest: intentDigest }),
      });
    },
  };
}
