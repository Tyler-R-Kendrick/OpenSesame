import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  assertsNoSecretTools,
  hostTools,
  registerHostTools,
} from "./tools.js";
import {
  clearFrozenIntent,
  getTaskContext,
  requireFrozenIntent,
  requireTaskRunId,
  setTaskContext,
  updateTaskFromResponse,
} from "./task-context.js";
import {
  daemonBase,
  daemonFetch,
  hostApiBase,
  hostAuthHeaders,
  hostFetch,
  isLoopbackBase,
  normalizeBase,
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
    process.env.OPENSESAME_OPERATOR_TOKEN = "opensesame-dev-operator";
    const calls: Array<{ url: string; auth?: string | null }> = [];
    setFetchForTests(async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        auth: headers.get("authorization"),
      });
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
    expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/tasks");
    expect(calls[0]?.auth).toBe("Bearer operator:opensesame-dev-operator");
    expect(body.task_run_id).toBe("task-1");
    delete process.env.OPENSESAME_SERVER;
    delete process.env.OPENSESAME_OPERATOR_TOKEN;
  });

  it("refuses a Host API base that would carry credentials off the machine", () => {
    expect(isLoopbackBase("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackBase("http://127.9.9.9:8787")).toBe(true);
    expect(isLoopbackBase("http://[::1]:8787")).toBe(true);
    expect(isLoopbackBase("https://attacker.example")).toBe(false);

    expect(() => normalizeBase("http://attacker.example", "X")).toThrow("https off loopback");
    expect(() => normalizeBase("ftp://127.0.0.1", "X")).toThrow("http or https");
    expect(() => normalizeBase("http://user:pw@127.0.0.1:8787", "X")).toThrow("credentials");
    expect(() => normalizeBase("nonsense", "X")).toThrow("valid URL");
    expect(normalizeBase("https://api.example.test/base/", "X")).toBe(
      "https://api.example.test/base",
    );
  });

  it("never offers the local operator secret to a remote Host API", () => {
    process.env.OPENSESAME_OPERATOR_TOKEN = "local-only-secret";
    process.env.OPENSESAME_ACCESS_TOKEN = "sess-1";
    expect(hostAuthHeaders("http://127.0.0.1:8787").authorization).toBe(
      "Bearer operator:local-only-secret",
    );
    // A remote Host API gets the session bearer instead — the operator token is a
    // secret shared with this machine's own processes.
    expect(hostAuthHeaders("https://api.example.test").authorization).toBe(
      "Bearer opaque-session:sess-1",
    );
    delete process.env.OPENSESAME_ACCESS_TOKEN;
    expect(hostAuthHeaders("https://api.example.test").authorization).toBeUndefined();
    delete process.env.OPENSESAME_OPERATOR_TOKEN;
  });

  it("authenticates daemon calls and confines the daemon to loopback", async () => {
    process.env.OPENSESAME_OPERATOR_TOKEN = "op-token";
    const calls: Array<{ url: string; auth: string | null }> = [];
    setFetchForTests(async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get("authorization") });
      return new Response("{}", { status: 200 });
    });
    await daemonFetch("/v1/toolbar/status");
    // Every daemon /v1/* route requires this bearer; without it the call 401s.
    expect(calls[0]?.auth).toBe("Bearer operator:op-token");

    process.env.OPENSESAME_DAEMON_URL = "https://daemon.example.test";
    expect(() => daemonBase()).toThrow("loopback");
    delete process.env.OPENSESAME_DAEMON_URL;
    delete process.env.OPENSESAME_OPERATOR_TOKEN;
  });

  it("task context tracks active run", () => {
    setTaskContext({ taskRunId: "abc", stateVersion: 2 });
    expect(getTaskContext()?.taskRunId).toBe("abc");
    expect(requireTaskRunId()).toBe("abc");
  });

  it("a read of another task does not become a move to it", () => {
    setTaskContext({
      taskRunId: "mine",
      stateVersion: 2,
      frozenIntent: {
        intentId: "i1",
        intentDigest: "sha256:i1",
        operation: "read",
        resource: "r",
        audience: "https://api.example.test",
        canonicalArguments: {},
      },
    });

    // task_status passes a task_run_id the model chose.
    updateTaskFromResponse({ task_run_id: "someone-elses", state_version: 9 }, { adopt: false });
    expect(getTaskContext()?.taskRunId).toBe("mine");
    expect(getTaskContext()?.frozenIntent?.intentDigest).toBe("sha256:i1");

    // The same task's state still refreshes, and the intent rides along.
    updateTaskFromResponse({ task_run_id: "mine", state_version: 3 }, { adopt: false });
    expect(getTaskContext()?.stateVersion).toBe(3);
    expect(getTaskContext()?.frozenIntent?.intentDigest).toBe("sha256:i1");

    // Starting a task adopts it, and drops an intent frozen against the old one.
    updateTaskFromResponse({ task_run_id: "fresh", state_version: 1 });
    expect(getTaskContext()?.taskRunId).toBe("fresh");
    expect(getTaskContext()?.frozenIntent).toBeUndefined();
  });

  it("forgets a spent intent", () => {
    setTaskContext({
      taskRunId: "t",
      stateVersion: 1,
      frozenIntent: {
        intentId: "i",
        intentDigest: "sha256:i",
        operation: "read",
        resource: "r",
        audience: "https://api.example.test",
        canonicalArguments: {},
      },
    });
    clearFrozenIntent();
    expect(getTaskContext()?.taskRunId).toBe("t");
    expect(() => requireFrozenIntent()).toThrow("frozen_intent_required");
  });
});
