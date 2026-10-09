import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import type { JsonObject } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { NativeMcpTransportPorts } from "./native-mcp-fetch.js";
import { NativeMcpSession } from "./native-mcp-protocol.js";
import type { NativeMcpBinding } from "./native-mcp-target.js";

const binding: NativeMcpBinding = {
  providerId: "notion",
  fingerprint: "sealed-configuration-1",
  endpoint: "https://mcp.notion.com/mcp",
  resource: "https://mcp.notion.com/mcp",
  issuer: "https://mcp.notion.com",
  transport: "streamable-http",
};
const RpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
const tool = {
  name: "search",
  description: "Search this workspace",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};
const sessions: NativeMcpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

type FixtureOptions = {
  unauthorized?: boolean;
  repeatedCursor?: boolean;
  noTools?: boolean;
  structured?: boolean;
  invalidStructured?: boolean;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
};
function advertisedTool(options: FixtureOptions): JsonObject {
  const advertised: JsonObject = { ...tool };
  if (options.structured)
    advertised.outputSchema = {
      type: "object",
      properties: { matches: { type: "integer" } },
      required: ["matches"],
      additionalProperties: false,
    };
  if (options.inputSchema) advertised.inputSchema = options.inputSchema;
  if (options.outputSchema) advertised.outputSchema = options.outputSchema;
  return advertised;
}
function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(binding.endpoint);
    expect(request.headers.get("authorization")).toBe(
      "Bearer sealed-private-token",
    );
    if (request.method === "GET") return new Response(null, { status: 405 });
    const rpc = RpcSchema.parse(JSON.parse(await request.text()));
    calls.push(rpc.method);
    if (
      rpc.method === "notifications/initialized" ||
      rpc.method === "notifications/cancelled"
    )
      return new Response(null, { status: 202 });
    if (options.unauthorized && rpc.method === "tools/call")
      return new Response("Not authorized", { status: 401 });
    let result: JsonObject;
    if (rpc.method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        capabilities: options.noTools ? {} : { tools: {} },
        serverInfo: { name: "Notion MCP", version: "2.0" },
      };
    } else if (rpc.method === "tools/list") {
      result = rpc.params?.cursor
        ? { tools: [] }
        : { tools: [advertisedTool(options)], nextCursor: "page-2" };
      if (options.repeatedCursor) result.nextCursor = "page-2";
    } else {
      result = {
        content: [{ type: "text", text: "Found a real server result" }],
      };
      if (options.structured)
        result.structuredContent = {
          matches: options.invalidStructured ? "invalid" : 1,
        };
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
      {
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "server-session",
        },
      },
    );
  });
  const ports: NativeMcpTransportPorts = {
    fetch: fetcher,
    accessGrant: async () => ({ ...binding, token: "sealed-private-token" }),
    assertCurrent: () => undefined,
    authorizationRequired: vi.fn(async () => undefined),
  };
  const session = new NativeMcpSession(binding, ports);
  sessions.push(session);
  return { session, ports, calls, fetcher };
}

describe("native MCP protocol over HTTP", () => {
  it.each(["inputSchema", "outputSchema"] as const)(
    "refuses an unsafe advertised %s before invocation or SDK validation",
    async (position) => {
      const schema: JsonObject = {
        type: "object",
        properties: { query: { type: "string", pattern: "^(a+)+$" } },
      };
      const { session, calls } = fixture({ [position]: schema });
      await expect(session.connect()).rejects.toMatchObject({
        code: "schema-limits",
      });
      await expect(
        session.callTool("search", { query: `${"a".repeat(32)}!` }),
      ).rejects.toMatchObject({ code: "disposed" });
      expect(calls).not.toContain("tools/call");
    },
  );
  it("validates advertised input and SDK output schemas with the CSP-safe adapter", async () => {
    const { session, calls } = fixture({ structured: true });
    await session.connect();
    await expect(
      session.callTool("search", { query: 42 }),
    ).rejects.toMatchObject({ code: "arguments" });
    expect(calls).not.toContain("tools/call");
    const result = await session.callTool("search", {
      query: "CSP-safe schemas",
    });
    expect(result.structuredContent).toEqual({ matches: 1 });
    const invalid = fixture({ structured: true, invalidStructured: true });
    await invalid.session.connect();
    await expect(
      invalid.session.callTool("search", { query: "bad output" }),
    ).rejects.toMatchObject({ code: "response" });
  });
  it("the production validator interprets schemas when dynamic code is forbidden", () => {
    const dynamicCode = vi
      .spyOn(globalThis, "Function")
      .mockImplementation(() => {
        throw new EvalError("Production CSP refuses dynamic code");
      });
    try {
      const validate = new CfWorkerJsonSchemaValidator().getValidator(
        tool.inputSchema,
      );
      expect(validate({ query: "valid" }).valid).toBe(true);
      expect(validate({ query: 42 }).valid).toBe(false);
      expect(dynamicCode).not.toHaveBeenCalled();
    } finally {
      dynamicCode.mockRestore();
    }
  });

  it("initializes, follows server pagination and invokes the advertised schema", async () => {
    const { session, calls } = fixture();
    const result = await session.connect();
    expect(result.server).toEqual({ name: "Notion MCP", version: "2.0" });
    expect(result.tools).toEqual([tool]);
    expect(calls).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
    ]);
    expect(
      await session.callTool("search", { query: "release notes" }),
    ).toEqual({
      content: [{ type: "text", text: "Found a real server result" }],
    });
    expect(calls.at(-1)).toBe("tools/call");
  });

  it("joins concurrent handshakes without duplicate initialization", async () => {
    const { session, calls } = fixture();
    const [first, second] = await Promise.all([
      session.connect(),
      session.connect(),
    ]);
    expect(first).toBe(second);
    expect(calls.filter((call) => call === "initialize")).toHaveLength(1);
  });

  it("rejects invented tools and invalid arguments before network execution", async () => {
    const { session, calls } = fixture();
    await session.connect();
    await expect(
      session.callTool("create-invented-object", {}),
    ).rejects.toMatchObject({ code: "tool" });
    await expect(
      session.callTool("search", { query: 123 }),
    ).rejects.toMatchObject({ code: "arguments" });
    await expect(session.callTool("search", {})).rejects.toMatchObject({
      code: "arguments",
      message:
        "Enter arguments that match this tool’s advertised input schema.",
    });
    expect(calls).not.toContain("tools/call");
  });

  it("does not activate when the server lacks tools or repeats pagination", async () => {
    await expect(
      fixture({ noTools: true }).session.connect(),
    ).rejects.toMatchObject({ code: "response" });
    await expect(
      fixture({ repeatedCursor: true }).session.connect(),
    ).rejects.toMatchObject({ code: "response" });
  });

  it("marks a rejected grant for reauthorization without replaying the operation", async () => {
    const { session, ports, calls } = fixture({ unauthorized: true });
    await session.connect();
    await expect(
      session.callTool("search", { query: "one request" }),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(ports.authorizationRequired).toHaveBeenCalledOnce();
    expect(calls.filter((call) => call === "tools/call")).toHaveLength(1);
    await expect(
      session.callTool("search", { query: "retained reference" }),
    ).rejects.toMatchObject({ code: "disposed" });
  });

  it("cannot use retained references after disconnect", async () => {
    const { session, fetcher } = fixture();
    await session.connect();
    await session.dispose();
    const count = fetcher.mock.calls.length;
    await expect(session.connect()).rejects.toMatchObject({ code: "disposed" });
    await expect(
      session.callTool("search", { query: "after lock" }),
    ).rejects.toMatchObject({ code: "disposed" });
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
});
