import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  assertsNoSecretTools,
  hostTools,
  registerHostTools,
} from "./tools.js";
import {
  getTaskContext,
  requireTaskRunId,
  setTaskContext,
} from "./task-context.js";
import {
  hostApiBase,
  hostFetch,
  resetFetchForTests,
  setFetchForTests,
} from "./host-api.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("mcp-host tools", () => {
  beforeEach(() => {
    setTaskContext(null);
  });

  afterEach(() => {
    resetFetchForTests();
    setTaskContext(null);
  });

  it("forbids secret tools in catalog", () => {
    expect(() => assertsNoSecretTools(hostTools)).not.toThrow();
    expect(() => assertsNoSecretTools([...hostTools, "getSecret"])).toThrow(
      "secret_tools_forbidden",
    );
    expect(() => assertsNoSecretTools([...hostTools, "materialize_credential"])).toThrow(
      "secret_tools_forbidden",
    );
  });

  it("includes all required task tools", () => {
    for (const name of [
      "task_start",
      "task_status",
      "task_invoke",
      "task_terminate",
      "daemon_status",
      "host_ready",
      "operator_invoke_l1",
    ]) {
      expect(hostTools).toContain(name);
    }
  });

  it("operator_invoke_l1 rejects without task_run_id", async () => {
    setTaskContext(null);
    expect(() => requireTaskRunId()).toThrow("task_context_required");
  });

  it("task_start calls Host API when OPENSESAME_SERVER set", async () => {
    process.env.OPENSESAME_SERVER = "http://127.0.0.1:8787";
    const calls: string[] = [];
    setFetchForTests(async (input, init) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          task_run_id: "task-1",
          state_version: 1,
          status: "active",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerHostTools(server);

    // Exercise hostFetch wiring (SDK tool handlers are not directly invokable here).
    const res = await hostFetch("/api/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principal_id: "p1",
        organization_id: "o1",
        capabilities: [{ action: "read", resource: "r1" }],
      }),
    });
    const body = await res.json();
    expect(hostApiBase()).toBe("http://127.0.0.1:8787");
    expect(calls[0]).toBe("http://127.0.0.1:8787/api/v1/tasks");
    expect(body.task_run_id).toBe("task-1");
    delete process.env.OPENSESAME_SERVER;
  });

  it("task context tracks active run", () => {
    setTaskContext({ taskRunId: "abc", stateVersion: 2 });
    expect(getTaskContext()?.taskRunId).toBe("abc");
    expect(requireTaskRunId()).toBe("abc");
  });
});
