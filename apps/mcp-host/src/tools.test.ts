import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertSourceOrder } from "@opensesame/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentPayloadRefused,
  REDACTED,
  forAgent,
  looksLikeCredential,
  scrubLocalSecrets,
} from "./agent-payload.js";
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
import {
  clearFrozenIntent,
  getTaskContext,
  requireFrozenIntent,
  requireTaskRunId,
  setTaskContext,
  updateTaskFromResponse,
} from "./task-context.js";
import { assertsNoSecretTools, hostTools, registerHostTools } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));

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
    expect(() =>
      assertsNoSecretTools([...hostTools, "materialize_credential"]),
    ).toThrow("secret_tools_forbidden");
  });

  it("forbids sealed-store reveal tool names", () => {
    for (const name of [
      "show",
      "pass_show",
      "sealed_store_show",
      "password_store_read",
      "get_secret",
    ]) {
      expect(() => assertsNoSecretTools([...hostTools, name])).toThrow(
        /secret_tools_forbidden|forbidden/i,
      );
    }
    expect(hostTools.join(" ")).not.toMatch(/getSecret|materialize|pass_show/i);
  });

  it("does not hand the model the operator token it holds", () => {
    const env = {
      OPENSESAME_OPERATOR_TOKEN: "opensesame-dev-operator",
      OPENSESAME_ACCESS_TOKEN: "opaque-session:abcdef123456",
    } as NodeJS.ProcessEnv;
    // The shape an echo takes: an upstream error quoting what it received.
    const echoed = JSON.stringify({
      error: "unauthorized",
      received: "Bearer operator:opensesame-dev-operator",
    });
    const scrubbed = scrubLocalSecrets(echoed, env);
    expect(scrubbed).not.toContain("opensesame-dev-operator");
    expect(scrubbed).toContain(REDACTED);
    expect(
      scrubLocalSecrets(JSON.stringify({ t: "abcdef123456" }), env),
    ).not.toContain("abcdef123456");

    // A short value is not treated as a secret: scrubbing it would mangle output
    // for no gain.
    const short = { OPENSESAME_OPERATOR_TOKEN: "dev" } as NodeJS.ProcessEnv;
    expect(scrubLocalSecrets("a dev payload", short)).toBe("a dev payload");
  });

  it("refuses a payload that still looks like a credential", () => {
    const env = {} as NodeJS.ProcessEnv;
    for (const body of [
      '{"uri":"secret://org/proj/github"}',
      '{"refresh_token":"x"}',
      '{"access_token":"y"}',
      '{"client_secret":"z"}',
      '{"key":"-----BEGIN PRIVATE KEY-----"}',
      '{"pat":"ghp_aaaaaaaaaaaaaaaa"}',
    ]) {
      expect(looksLikeCredential(body)).toBe(true);
      expect(() => forAgent(body, env)).toThrow(AgentPayloadRefused);
    }

    // What these tools actually return is unaffected.
    const ordinary = JSON.stringify({
      task_run_id: "task-1",
      state_version: 2,
      capabilities: [{ action: "read", resource: "r1" }],
      connection_ref: "conn://demo",
    });
    expect(forAgent(ordinary, env)).toBe(ordinary);
  });

  it("prefers scrubbing an echo over refusing the whole result", () => {
    const env = {
      OPENSESAME_OPERATOR_TOKEN: "opensesame-dev-operator",
    } as NodeJS.ProcessEnv;
    // A body whose only offence was quoting our token is usable once it is gone;
    // refusing it would turn a leak into an outage.
    const body = JSON.stringify({
      ok: true,
      note: "sent with opensesame-dev-operator",
    });
    expect(forAgent(body, env)).toContain(REDACTED);
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
    Reflect.deleteProperty(process.env, "OPENSESAME_SERVER");
    Reflect.deleteProperty(process.env, "OPENSESAME_OPERATOR_TOKEN");
  });

  it("refuses a Host API base that would carry credentials off the machine", () => {
    expect(isLoopbackBase("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackBase("http://127.9.9.9:8787")).toBe(true);
    expect(isLoopbackBase("http://[::1]:8787")).toBe(true);
    expect(isLoopbackBase("https://attacker.example")).toBe(false);

    expect(() => normalizeBase("http://attacker.example", "X")).toThrow(
      "https off loopback",
    );
    expect(() => normalizeBase("ftp://127.0.0.1", "X")).toThrow(
      "http or https",
    );
    expect(() => normalizeBase("http://user:pw@127.0.0.1:8787", "X")).toThrow(
      "credentials",
    );
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
    Reflect.deleteProperty(process.env, "OPENSESAME_ACCESS_TOKEN");
    expect(
      hostAuthHeaders("https://api.example.test").authorization,
    ).toBeUndefined();
    Reflect.deleteProperty(process.env, "OPENSESAME_OPERATOR_TOKEN");
  });

  it("refuses a session token aimed at a Host API outside OPENSESAME_HOST_AUDIENCE", () => {
    process.env.OPENSESAME_ACCESS_TOKEN = "sess-1";
    process.env.OPENSESAME_HOST_AUDIENCE = "https://host.example.test";
    expect(() => hostAuthHeaders("https://evil.example.test")).toThrow(
      /HOST_AUDIENCE/,
    );
    expect(hostAuthHeaders("https://host.example.test").authorization).toBe(
      "Bearer opaque-session:sess-1",
    );
    Reflect.deleteProperty(process.env, "OPENSESAME_ACCESS_TOKEN");
    Reflect.deleteProperty(process.env, "OPENSESAME_HOST_AUDIENCE");
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
    Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_URL");
    Reflect.deleteProperty(process.env, "OPENSESAME_OPERATOR_TOKEN");
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
    updateTaskFromResponse(
      { task_run_id: "someone-elses", state_version: 9 },
      { adopt: false },
    );
    expect(getTaskContext()?.taskRunId).toBe("mine");
    expect(getTaskContext()?.frozenIntent?.intentDigest).toBe("sha256:i1");

    // The same task's state still refreshes, and the intent rides along.
    updateTaskFromResponse(
      { task_run_id: "mine", state_version: 3 },
      { adopt: false },
    );
    expect(getTaskContext()?.stateVersion).toBe(3);
    expect(getTaskContext()?.frozenIntent?.intentDigest).toBe("sha256:i1");

    // Starting a task adopts it, and drops an intent frozen against the old one.
    updateTaskFromResponse({ task_run_id: "fresh", state_version: 1 });
    expect(getTaskContext()?.taskRunId).toBe("fresh");
    expect(getTaskContext()?.frozenIntent).toBeUndefined();
  });

  it("PACT — tool errors and Host auth go through forAgent / audience pin", () => {
    assertSourceOrder(readFileSync(join(here, "tools.ts"), "utf8"), [
      "function toolError",
      "forAgent(`${label}: ${message}`)",
    ]);
    assertSourceOrder(readFileSync(join(here, "host-api.ts"), "utf8"), [
      "OPENSESAME_HOST_AUDIENCE",
      "does not match OPENSESAME_HOST_AUDIENCE",
    ]);
    expect(hostTools.join(" ")).not.toMatch(/secret|materialize/i);
  });

  it("chaos: Host partition fails closed and host_ready maps it to toolError", async () => {
    process.env.OPENSESAME_SERVER = "http://127.0.0.1:8787";
    process.env.OPENSESAME_OPERATOR_TOKEN = "opensesame-dev-operator";
    setFetchForTests(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(hostFetch("/health/ready")).rejects.toThrow(/ECONNREFUSED/);
    assertSourceOrder(readFileSync(join(here, "tools.ts"), "utf8"), [
      'const res = await hostFetch("/health/ready")',
      'toolError("host_unavailable"',
    ]);
    Reflect.deleteProperty(process.env, "OPENSESAME_SERVER");
    Reflect.deleteProperty(process.env, "OPENSESAME_OPERATOR_TOKEN");
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
