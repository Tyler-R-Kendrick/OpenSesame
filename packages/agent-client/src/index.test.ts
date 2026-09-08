import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient, exactResource } from "./index.js";

afterEach(() => vi.unstubAllEnvs());

function launch() {
  const client = randomUUID();
  const handle = randomBytes(32).toString("hex");
  vi.stubEnv("OPENSESAME_AGENT_LAUNCH_HANDLE", handle);
  vi.stubEnv("OPENSESAME_AGENT_CLIENT_ID", client);
  vi.stubEnv("OPENSESAME_AGENT_SOCK", "/tmp/agent-test.sock");
  return { client, handle };
}

it("exchanges once, binds client/audience/resource, and forgets bootstrap environment", async () => {
  const { client, handle } = launch();
  const token = `agent-capability:${randomBytes(32).toString("hex")}`;
  const exchange = vi.fn(async (_socket: string, body: string) => {
    expect(JSON.parse(body)).toEqual({
      launch_handle: handle,
      client_id: client,
      audience: "urn:opensesame:agent:mcp-host",
    });
    expect(process.env.OPENSESAME_AGENT_LAUNCH_HANDLE).toBeUndefined();
    return JSON.stringify({
      access_token: token,
      token_type: "Bearer",
      expires_in: 300,
      client_id: client,
      audience: "urn:opensesame:agent:mcp-host",
      scope: ["host.tasks.read"],
    });
  });
  const agent = new AgentClient(
    "urn:opensesame:agent:mcp-host",
    fetch,
    exchange,
  );
  const [first, second] = await Promise.all([
    agent.headers("https://host.example"),
    agent.headers("https://host.example"),
  ]);
  expect(first).toEqual(second);
  expect(first.authorization).toBe(`Bearer ${token}`);
  expect(Object.keys(first).sort()).toEqual([
    "authorization",
    "x-opensesame-agent-audience",
    "x-opensesame-agent-client",
  ]);
  expect(exchange).toHaveBeenCalledTimes(1);
  await expect(agent.headers("https://other.example")).rejects.toThrow(
    "audience mismatch",
  );
  agent.forget();
  await expect(agent.headers("https://host.example")).rejects.toThrow(
    "new approved agent launch",
  );
});

it("does not use inherited operator or native-session authority", async () => {
  vi.stubEnv("OPENSESAME_AGENT_LAUNCH_HANDLE", "");
  vi.stubEnv("OPENSESAME_OPERATOR_TOKEN", randomBytes(32).toString("hex"));
  vi.stubEnv(
    "OPENSESAME_ACCESS_TOKEN",
    `opaque-session:${randomBytes(32).toString("hex")}`,
  );
  const exchange = vi.fn();
  const agent = new AgentClient(
    "urn:opensesame:agent:mcp-host",
    fetch,
    exchange,
  );
  await expect(agent.headers("http://127.0.0.1:8787")).rejects.toThrow(
    "approved agent launch",
  );
  expect(exchange).not.toHaveBeenCalled();
});

it("rejects a substituted audience and never echoes malformed provider data", async () => {
  const { client } = launch();
  const agent = new AgentClient(
    "urn:opensesame:agent:mcp-client",
    fetch,
    async () =>
      JSON.stringify({
        access_token: `agent-capability:${randomBytes(32).toString("hex")}`,
        token_type: "Bearer",
        expires_in: 300,
        client_id: client,
        audience: "urn:opensesame:agent:mcp-host",
        scope: ["host.tasks.read"],
      }),
  );
  await expect(agent.headers("https://host.example")).rejects.toThrow(
    "binding mismatch",
  );
  launch();
  const invalid = new AgentClient(
    "urn:opensesame:agent:mcp-host",
    fetch,
    async () => "sentinel-secret-invalid-json",
  );
  await expect(invalid.headers("https://host.example")).rejects.toThrow(
    "invalid agent launch response",
  );
});

it("refuses ambiguous or credential-bearing resource endpoints", () => {
  for (const base of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?x=1",
    "https://EXAMPLE.com",
    "http://127.1",
  ])
    expect(() => exactResource(base)).toThrow();
  expect(exactResource("http://[::1]:8787/")).toBe("http://[::1]:8787");
});

it("schema-validates parsed JSON before exposing any authority headers", async () => {
  const { client } = launch();
  const agent = new AgentClient(
    "urn:opensesame:agent:mcp-host",
    fetch,
    async () =>
      JSON.stringify({
        access_token: `agent-capability:${randomBytes(32).toString("hex")}`,
        token_type: "Bearer",
        expires_in: 300,
        client_id: client,
        audience: "urn:opensesame:agent:mcp-host",
        scope: ["host.tasks.read"],
        operator: "sentinel-must-not-enter-headers",
      }),
  );
  await expect(agent.headers("https://host.example")).rejects.toThrow(
    "agent launch binding mismatch",
  );
});

it("cannot restore a forgotten capability from an in-flight exchange", async () => {
  const { client } = launch();
  let finish: (value: string) => void = () => {
    throw new Error("exchange not started");
  };
  const response = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const agent = new AgentClient(
    "urn:opensesame:agent:mcp-host",
    fetch,
    () => response,
  );
  const pending = agent.headers("https://host.example");
  agent.forget();
  finish(
    JSON.stringify({
      access_token: `agent-capability:${randomBytes(32).toString("hex")}`,
      token_type: "Bearer",
      expires_in: 300,
      client_id: client,
      audience: "urn:opensesame:agent:mcp-host",
      scope: ["host.tasks.read"],
    }),
  );
  await expect(pending).rejects.toThrow("cancelled");
  await expect(agent.headers("https://host.example")).rejects.toThrow(
    "new approved agent launch",
  );
});
