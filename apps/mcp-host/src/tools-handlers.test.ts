import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetFetchForTests, setFetchForTests } from "./host-api.js";
import { getTaskContext, setTaskContext } from "./task-context.js";
import { registerHostTools } from "./tools.js";
import { overlapCast, type BoundaryValue } from "@opensesame/os-domain";

type AnyFn = (...args: unknown[]) => BoundaryValue;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * The SDK's registered handlers are not reachable outside a live client/server
 * exchange, so — like telemetry.test.ts — this suite registers the host tools on
 * a minimal fake that records the last-arg callback per tool name, then invokes
 * the handlers directly with a stubbed fetch.
 */
function makeRegistrar() {
  const handlers = new Map<string, AnyFn>();
  const server = {
    tool: (...args: unknown[]) => {
      handlers.set(overlapCast(args[0]), overlapCast(args[args.length - 1]));
    },
  };
  const typedServer = overlapCast(server);
  registerHostTools(typedServer);
  return handlers;
}

async function callTool(
  handlers: Map<string, AnyFn>,
  name: string,
  args?: BoundaryValue,
): Promise<ToolResult> {
  const handler = handlers.get(name);
  expect(handler, `tool ${name} registered`).toBeDefined();
  return overlapCast(await handler?.(args));
}

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ENV_KEYS = [
  "OPENSESAME_SERVER",
  "OPENSESAME_OPERATOR_TOKEN",
  "OPENSESAME_DAEMON_URL",
] as const;

describe("mcp-host tool handlers", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    setTaskContext(null);
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.OPENSESAME_SERVER = "http://127.0.0.1:8787";
    process.env.OPENSESAME_OPERATOR_TOKEN = "opensesame-dev-operator";
  });

  afterEach(() => {
    resetFetchForTests();
    setTaskContext(null);
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedEnv.clear();
  });

  describe("task_start", () => {
    it("posts the ceiling to the Host API, defaults ttl, and adopts the task", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return jsonResponse(
          { task_run_id: "t-1", state_version: 1, status: "active" },
          201,
        );
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_start", {
        principal_id: "p1",
        organization_id: "o1",
        capabilities: [{ action: "read", resource: "r1" }],
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/tasks");
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent.principal_id).toBe("p1");
      expect(sent.ttl_seconds).toBe(3600);
      expect(sent.capabilities).toEqual([{ action: "read", resource: "r1" }]);
      // The created task becomes the active context for later invoke.
      expect(getTaskContext()).toEqual({ taskRunId: "t-1", stateVersion: 1 });
      expect(result.content[0]?.text).toContain("t-1");
    });

    it("forwards an explicit ttl_seconds", async () => {
      const bodies: string[] = [];
      setFetchForTests(async (_input, init) => {
        bodies.push(String(init?.body));
        return jsonResponse({ task_run_id: "t-2", state_version: 1 }, 201);
      });
      const handlers = makeRegistrar();

      await callTool(handlers, "task_start", {
        principal_id: "p1",
        organization_id: "o1",
        capabilities: [{ action: "read", resource: "r1" }],
        ttl_seconds: 60,
      });

      expect(JSON.parse(bodies[0] ?? "{}").ttl_seconds).toBe(60);
    });

    it("flags a non-ok Host API response as a tool error and adopts nothing", async () => {
      setFetchForTests(async () =>
        jsonResponse({ error: "capability_ceiling_exceeded" }, 403),
      );
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_start", {
        principal_id: "p1",
        organization_id: "o1",
        capabilities: [{ action: "read", resource: "r1" }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("capability_ceiling_exceeded");
      expect(getTaskContext()).toBeNull();
    });

    it("maps a fetch failure to task_start_failed", async () => {
      setFetchForTests(async () => {
        throw new Error("ECONNREFUSED");
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_start", {
        principal_id: "p1",
        organization_id: "o1",
        capabilities: [{ action: "read", resource: "r1" }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("task_start_failed");
      expect(result.content[0]?.text).toContain("ECONNREFUSED");
    });

    it("refuses the whole error payload when even the error looks like a credential", async () => {
      setFetchForTests(async () => {
        throw new Error('upstream replied {"access_token":"x"}');
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_start", {
        principal_id: "p1",
        organization_id: "o1",
        capabilities: [{ action: "read", resource: "r1" }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe("task_start_failed: refused");
      expect(result.content[0]?.text).not.toContain("access_token");
    });
  });

  describe("task_status", () => {
    it("requires a task_run_id or an active task context", async () => {
      const handlers = makeRegistrar();
      const result = await callTool(handlers, "task_status", {});
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "task_status_failed: task_context_required",
      );
    });

    it("reads an explicit task and refreshes the active task's state version", async () => {
      setTaskContext({ taskRunId: "t-1", stateVersion: 1 });
      const urls: string[] = [];
      setFetchForTests(async (input) => {
        urls.push(String(input));
        return jsonResponse({ task_run_id: "t-1", state_version: 7 });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_status", {
        task_run_id: "t-1",
      });

      expect(result.isError).toBe(false);
      expect(urls[0]).toBe("http://127.0.0.1:8787/api/v1/tasks/t-1");
      expect(getTaskContext()?.stateVersion).toBe(7);
    });

    it("defaults to the active task context and keeps isError on failure", async () => {
      setTaskContext({ taskRunId: "t-9", stateVersion: 2 });
      setFetchForTests(async () => jsonResponse({ error: "not_found" }, 404));
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_status", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("not_found");
      // A failed read must not disturb the active context.
      expect(getTaskContext()?.taskRunId).toBe("t-9");
    });
  });

  describe("task_invoke", () => {
    it("requires an active task context", async () => {
      const handlers = makeRegistrar();
      const result = await callTool(handlers, "task_invoke", {
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "task_invoke_failed: task_context_required",
      );
    });

    it("freezes the returned intent into the task context", async () => {
      setTaskContext({ taskRunId: "t-1", stateVersion: 2 });
      const bodies: string[] = [];
      setFetchForTests(async (_input, init) => {
        bodies.push(String(init?.body));
        return jsonResponse({
          intent_id: "i-1",
          intent_digest: "sha256:abc",
          task_state_version: 3,
          canonical_arguments: { path: "/tmp/x" },
        });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_invoke", {
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
        arguments: { path: "/tmp/x" },
      });

      expect(result.isError).toBe(false);
      const sent = JSON.parse(bodies[0] ?? "{}");
      expect(sent.task_run_id).toBe("t-1");
      expect(sent.expected_state_version).toBe(2);
      // No caller-supplied key: one is minted per call.
      expect(sent.idempotency_key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const ctx = getTaskContext();
      expect(ctx?.stateVersion).toBe(3);
      expect(ctx?.frozenIntent).toEqual({
        intentId: "i-1",
        intentDigest: "sha256:abc",
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
        canonicalArguments: { path: "/tmp/x" },
      });
    });

    it("forwards a caller-supplied idempotency key and falls back to raw arguments", async () => {
      setTaskContext({ taskRunId: "t-1", stateVersion: 1 });
      const bodies: string[] = [];
      setFetchForTests(async (_input, init) => {
        bodies.push(String(init?.body));
        // No task_state_version / canonical_arguments: the handler must fall back.
        return jsonResponse({ intent_id: "i-2", intent_digest: "sha256:def" });
      });
      const handlers = makeRegistrar();

      await callTool(handlers, "task_invoke", {
        operation: "write",
        resource: "r2",
        audience: "https://api.example.test",
        arguments: { a: 1 },
        idempotency_key: "key-123",
      });

      expect(JSON.parse(bodies[0] ?? "{}").idempotency_key).toBe("key-123");
      const ctx = getTaskContext();
      expect(ctx?.stateVersion).toBe(1);
      expect(ctx?.frozenIntent?.canonicalArguments).toEqual({ a: 1 });
    });

    it("does not freeze an intent when the Host API refuses", async () => {
      setTaskContext({ taskRunId: "t-1", stateVersion: 1 });
      setFetchForTests(async () => jsonResponse({ error: "stale_state" }, 409));
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_invoke", {
        operation: "read",
        resource: "r1",
        audience: "https://api.example.test",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(getTaskContext()?.frozenIntent).toBeUndefined();
    });
  });

  describe("task_terminate", () => {
    it("sends the active state version and clears the matching context", async () => {
      setTaskContext({ taskRunId: "t-1", stateVersion: 5 });
      const bodies: string[] = [];
      setFetchForTests(async (_input, init) => {
        bodies.push(String(init?.body));
        return jsonResponse({ task_run_id: "t-1", status: "terminated" });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "task_terminate", {});

      expect(result.isError).toBe(false);
      expect(JSON.parse(bodies[0] ?? "{}").expected_state_version).toBe(5);
      expect(getTaskContext()).toBeNull();
    });

    it("forwards an explicit expected_state_version", async () => {
      const bodies: string[] = [];
      setFetchForTests(async (_input, init) => {
        bodies.push(String(init?.body));
        return jsonResponse({ status: "terminated" });
      });
      const handlers = makeRegistrar();

      await callTool(handlers, "task_terminate", {
        task_run_id: "t-2",
        expected_state_version: 11,
      });

      expect(JSON.parse(bodies[0] ?? "{}").expected_state_version).toBe(11);
    });

    it("keeps the active context when terminating a different task or on failure", async () => {
      setTaskContext({ taskRunId: "mine", stateVersion: 1 });
      setFetchForTests(async () => jsonResponse({ status: "terminated" }));
      const handlers = makeRegistrar();

      await callTool(handlers, "task_terminate", { task_run_id: "other" });
      expect(getTaskContext()?.taskRunId).toBe("mine");

      setFetchForTests(async () => jsonResponse({ error: "conflict" }, 409));
      const failed = await callTool(handlers, "task_terminate", {
        task_run_id: "mine",
      });
      expect(failed.isError).toBe(true);
      expect(getTaskContext()?.taskRunId).toBe("mine");
    });

    it("requires a task_run_id or an active task context", async () => {
      const handlers = makeRegistrar();
      const result = await callTool(handlers, "task_terminate", {});
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "task_terminate_failed: task_context_required",
      );
    });
  });

  describe("daemon_status", () => {
    it("returns the daemon's status payload", async () => {
      const urls: string[] = [];
      setFetchForTests(async (input) => {
        urls.push(String(input));
        return jsonResponse({ ok: true, version: "0.1.0" });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "daemon_status");

      expect(result.isError).toBeUndefined();
      expect(urls[0]).toBe("http://127.0.0.1:18790/v1/toolbar/status");
      expect(result.content[0]?.text).toContain('"ok":true');
    });

    it("maps a daemon outage to daemon_unavailable", async () => {
      setFetchForTests(async () => {
        throw new Error("ECONNREFUSED");
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "daemon_status");

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("daemon_unavailable");
    });
  });

  describe("host_ready", () => {
    it("reports the readiness status, body, and tool catalog", async () => {
      setFetchForTests(async () => new Response("ready", { status: 200 }));
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "host_ready");

      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0]?.text ?? "{}");
      expect(payload.status).toBe(200);
      expect(payload.body).toBe("ready");
      expect(payload.tools).toContain("task_start");
      expect(payload.tools).toContain("operator_invoke_l1");
    });

    it("maps an unreachable Host API to host_unavailable", async () => {
      setFetchForTests(async () => {
        throw new Error("ECONNREFUSED");
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "host_ready");

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("host_unavailable");
    });
  });

  describe("operator_invoke_l1", () => {
    const frozen = {
      intentId: "i-1",
      intentDigest: "sha256:abc",
      operation: "read",
      resource: "r1",
      audience: "https://api.example.test",
      canonicalArguments: {},
    };

    it("requires an active task and a frozen intent", async () => {
      const handlers = makeRegistrar();

      const noTask = await callTool(handlers, "operator_invoke_l1", {
        connection_ref: "conn://demo",
      });
      expect(noTask.content[0]?.text).toContain(
        "operator_invoke_failed: task_context_required",
      );

      setTaskContext({ taskRunId: "t-1", stateVersion: 1 });
      const noIntent = await callTool(handlers, "operator_invoke_l1", {
        connection_ref: "conn://demo",
      });
      expect(noIntent.content[0]?.text).toContain(
        "operator_invoke_failed: frozen_intent_required",
      );
    });

    it("executes exactly the frozen intent and spends the digest", async () => {
      setTaskContext({
        taskRunId: "t-1",
        stateVersion: 2,
        frozenIntent: frozen,
      });
      const calls: Array<{
        url: string;
        headers: Headers;
        body: string;
      }> = [];
      setFetchForTests(async (input, init) => {
        calls.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return jsonResponse({ receipt_id: "rcpt-1", status: "executed" });
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "operator_invoke_l1", {
        connection_ref: "conn://demo",
      });

      expect(result.isError).toBe(false);
      expect(calls[0]?.url).toBe(
        "http://127.0.0.1:18790/v1/operator/invoke_l1",
      );
      expect(calls[0]?.headers.get("x-opensesame-task-run-id")).toBe("t-1");
      expect(calls[0]?.headers.get("x-opensesame-intent-digest")).toBe(
        "sha256:abc",
      );
      const sent = JSON.parse(calls[0]?.body ?? "{}");
      expect(sent).toEqual({
        connection_ref: "conn://demo",
        invoke_level: 1,
        task_run_id: "t-1",
        intent_digest: "sha256:abc",
      });
      // The digest is spent: the frozen intent must not survive the call.
      expect(getTaskContext()?.taskRunId).toBe("t-1");
      expect(getTaskContext()?.frozenIntent).toBeUndefined();
    });

    it("flags a materialize_denied response as a tool error", async () => {
      setTaskContext({
        taskRunId: "t-1",
        stateVersion: 2,
        frozenIntent: frozen,
      });
      setFetchForTests(async () =>
        jsonResponse({ error: "materialize_denied" }, 200),
      );
      const handlers = makeRegistrar();

      const denied = await callTool(handlers, "operator_invoke_l1", {
        connection_ref: "conn://demo",
      });

      // Even a 200 carrying the denial marker is surfaced as a refusal.
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.text).toContain("materialize_denied");
    });

    it("flags materialize_denied and daemon failures as tool errors", async () => {
      setTaskContext({
        taskRunId: "t-1",
        stateVersion: 2,
        frozenIntent: frozen,
      });
      setFetchForTests(async () => {
        throw new Error("ECONNREFUSED");
      });
      const handlers = makeRegistrar();

      const result = await callTool(handlers, "operator_invoke_l1", {
        connection_ref: "conn://demo",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("operator_invoke_failed");
      // A failed call never reaches the daemon, so the intent stays frozen.
      expect(getTaskContext()?.frozenIntent?.intentDigest).toBe("sha256:abc");
    });
  });
});
