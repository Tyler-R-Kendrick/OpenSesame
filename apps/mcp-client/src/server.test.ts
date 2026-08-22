import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClientSeams } from "./api-client.js";
import {
  buildServer,
  modelError,
  modelText,
  requireAccessToken,
  requireBase,
  requireIdentityToken,
} from "./server.js";
import { toolsManifest } from "./tools.js";

const createApiClientMock = vi.fn();

type FakeClient = {
  health: ReturnType<typeof vi.fn>;
  probeDaemon: ReturnType<typeof vi.fn>;
  whoami: ReturnType<typeof vi.fn>;
  listConnections: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
};

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    health: vi.fn().mockResolvedValue({ status: "ok" }),
    probeDaemon: vi.fn().mockResolvedValue({ reachable: false }),
    whoami: vi.fn().mockResolvedValue({ principal: "user_123" }),
    listConnections: vi
      .fn()
      .mockResolvedValue({ connections: [{ ref: "cr_1" }] }),
    invoke: vi.fn().mockResolvedValue({ receipt: "rcpt_1" }),
    ...overrides,
  };
}

function mockApiClient(client: FakeClient): void {
  createApiClientMock.mockReturnValue(overlapCast(client));
}

async function makeSession(identityUrl = "http://127.0.0.1:8788") {
  const server = buildServer({
    hostUrl: "http://127.0.0.1:8787",
    identityUrl,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: () => Promise.all([client.close(), server.close()]),
  };
}

type ClientToolResult = Awaited<ReturnType<Client["callTool"]>>;

function toolResult(value: ClientToolResult): CallToolResult {
  return CallToolResultSchema.parse(value);
}

function payload(result: CallToolResult): JsonObject {
  const first = result.content[0];
  if (!first) throw new Error("tool returned no content");
  if (first.type !== "text") throw new Error("tool returned non-text content");
  return JSON.parse(first.text);
}

beforeEach(() => {
  createApiClientMock.mockReset();
  apiClientSeams.createApiClient = overlapCast(createApiClientMock);
  vi.stubEnv("OPENSESAME_ACCESS_TOKEN", undefined);
  vi.stubEnv("OPENSESAME_IDENTITY_TOKEN", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("requireBase", () => {
  it("accepts https URLs and loopback http", () => {
    expect(requireBase("https://host.example.com", "X")).toBe(
      "https://host.example.com",
    );
    expect(requireBase("http://127.0.0.1:8787", "X")).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("refuses non-loopback http and unparseable URLs", () => {
    expect(() => requireBase("http://example.com", "X")).toThrow(
      /X must be an https URL, or http on loopback/,
    );
    expect(() => requireBase("not a url", "X")).toThrow(/must be an https/);
  });
});

describe("token guards", () => {
  it("requireAccessToken rejects missing and blank tokens", () => {
    expect(() => requireAccessToken()).toThrow(/OPENSESAME_ACCESS_TOKEN/);
    process.env.OPENSESAME_ACCESS_TOKEN = "   ";
    expect(() => requireAccessToken()).toThrow(/OPENSESAME_ACCESS_TOKEN/);
  });

  it("requireAccessToken trims surrounding whitespace", () => {
    process.env.OPENSESAME_ACCESS_TOKEN = "  opaque-session:abc  ";
    expect(requireAccessToken()).toBe("opaque-session:abc");
  });

  it("requireIdentityToken rejects missing tokens and trims", () => {
    expect(() => requireIdentityToken()).toThrow(/OPENSESAME_IDENTITY_TOKEN/);
    process.env.OPENSESAME_IDENTITY_TOKEN = " id_tok_1 ";
    expect(requireIdentityToken()).toBe("id_tok_1");
  });
});

describe("model payload helpers", () => {
  it("modelText wraps JSON in a single text content block", () => {
    const content = modelText({ a: 1 });
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]?.text ?? "")).toEqual({ a: 1 });
  });

  it("modelError extracts Error messages and stringifies non-Errors", () => {
    const fromError = modelError("op_failed", new Error("boom"));
    expect(fromError.isError).toBe(true);
    expect(payload(toolResult(fromError))).toEqual({
      error: "op_failed",
      message: "boom",
    });

    const fromString = modelError("op_failed", "nope");
    expect(payload(toolResult(fromString))).toEqual({
      error: "op_failed",
      message: "nope",
    });
  });

  it("modelError drops credential-looking messages from model output", () => {
    const result = modelError(
      "op_failed",
      new Error("leaked access_token value"),
    );
    expect(result.isError).toBe(true);
    expect(payload(toolResult(result))).toEqual({ error: "op_failed" });
  });
});

describe("mcp-client server tools", () => {
  it("advertises exactly the declared manifest", async () => {
    const { client, close } = await makeSession();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [...toolsManifest].sort(),
      );
    } finally {
      await close();
    }
  });

  it("host_health reports health, daemon probe, and the tool manifest", async () => {
    const clientFake = fakeClient();
    mockApiClient(clientFake);
    const { client, close } = await makeSession();
    try {
      const result = toolResult(
        await client.callTool({
          name: "host_health",
          arguments: {},
        }),
      );
      expect(result.isError).toBeFalsy();
      expect(createApiClientMock).toHaveBeenCalledWith({
        baseUrl: "http://127.0.0.1:8787",
      });
      expect(payload(result)).toEqual({
        health: { status: "ok" },
        daemon: { reachable: false },
        tools: toolsManifest,
      });
    } finally {
      await close();
    }
  });

  it("whoami fails closed without an access token", async () => {
    const { client, close } = await makeSession();
    try {
      const result = toolResult(
        await client.callTool({
          name: "whoami",
          arguments: {},
        }),
      );
      expect(result.isError).toBe(true);
      // The guard's own message mentions "access_token", so forAgent refuses
      // it and modelError falls back to the bare label (no message key).
      expect(payload(result)).toEqual({ error: "whoami_failed" });
      expect(createApiClientMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("whoami passes the session token to the Host API client", async () => {
    process.env.OPENSESAME_ACCESS_TOKEN = "opaque-session:whoami";
    const clientFake = fakeClient();
    mockApiClient(clientFake);
    const { client, close } = await makeSession();
    try {
      const result = toolResult(
        await client.callTool({
          name: "whoami",
          arguments: {},
        }),
      );
      expect(result.isError).toBeFalsy();
      expect(createApiClientMock).toHaveBeenCalledWith({
        baseUrl: "http://127.0.0.1:8787",
        accessToken: "opaque-session:whoami",
      });
      expect(payload(result)).toEqual({ principal: "user_123" });
    } finally {
      await close();
    }
  });

  it("whoami surfaces Host API failures as tool errors", async () => {
    process.env.OPENSESAME_ACCESS_TOKEN = "opaque-session:whoami";
    mockApiClient(
      fakeClient({
        whoami: vi.fn().mockRejectedValue(new Error("host unreachable")),
      }),
    );
    const { client, close } = await makeSession();
    try {
      const result = toolResult(
        await client.callTool({
          name: "whoami",
          arguments: {},
        }),
      );
      expect(result.isError).toBe(true);
      expect(payload(result)).toEqual({
        error: "whoami_failed",
        message: "host unreachable",
      });
    } finally {
      await close();
    }
  });

  it("list_connections returns ConnectionRefs and reports failures", async () => {
    process.env.OPENSESAME_ACCESS_TOKEN = "opaque-session:list";
    const clientFake = fakeClient();
    mockApiClient(clientFake);
    const { client, close } = await makeSession();
    try {
      const ok = toolResult(
        await client.callTool({
          name: "list_connections",
          arguments: {},
        }),
      );
      expect(ok.isError).toBeFalsy();
      expect(payload(ok)).toEqual({ connections: [{ ref: "cr_1" }] });

      clientFake.listConnections.mockRejectedValueOnce(new Error("denied"));
      const denied = toolResult(
        await client.callTool({
          name: "list_connections",
          arguments: {},
        }),
      );
      expect(denied.isError).toBe(true);
      expect(payload(denied)).toEqual({
        error: "list_connections_failed",
        message: "denied",
      });
    } finally {
      await close();
    }
  });

  it("invoke_l1 forwards a level-1 invoke and reports failures", async () => {
    process.env.OPENSESAME_ACCESS_TOKEN = "opaque-session:invoke";
    const clientFake = fakeClient();
    mockApiClient(clientFake);
    const { client, close } = await makeSession();
    try {
      const args = {
        connectionRef: "cr_1",
        operation: "repo.read",
        resource: "opensesame",
      };
      const ok = toolResult(
        await client.callTool({
          name: "invoke_l1",
          arguments: args,
        }),
      );
      expect(ok.isError).toBeFalsy();
      expect(clientFake.invoke).toHaveBeenCalledWith({
        ...args,
        invokeLevel: 1,
      });
      expect(payload(ok)).toEqual({ receipt: "rcpt_1" });

      clientFake.invoke.mockRejectedValueOnce(new Error("policy denied"));
      const denied = toolResult(
        await client.callTool({
          name: "invoke_l1",
          arguments: args,
        }),
      );
      expect(denied.isError).toBe(true);
      expect(payload(denied)).toEqual({
        error: "invoke_failed",
        message: "policy denied",
      });
    } finally {
      await close();
    }
  });

  it("present_claim sends bearer and claim token to the Identity API", async () => {
    process.env.OPENSESAME_IDENTITY_TOKEN = "id_tok_1";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"state":"denied"}', { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const { client, close } = await makeSession("http://127.0.0.1:8788/");
    try {
      const result = toolResult(
        await client.callTool({
          name: "present_claim",
          arguments: { claimId: "clm/abc", claimToken: "osc_clm_1" },
        }),
      );
      expect(result.isError).toBe(true); // non-2xx surfaces as tool error
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8788/v1/claims/clm%2Fabc",
        {
          headers: {
            accept: "application/json",
            "x-claim-token": "osc_clm_1",
            authorization: "Bearer id_tok_1",
          },
        },
      );
      expect(payload(result)).toEqual({
        status: 403,
        body: '{"state":"denied"}',
      });
    } finally {
      await close();
    }
  });

  it("present_claim returns ok responses without an error flag", async () => {
    process.env.OPENSESAME_IDENTITY_TOKEN = "id_tok_1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"state":"approved"}')),
    );
    const { client, close } = await makeSession();
    try {
      const result = toolResult(
        await client.callTool({
          name: "present_claim",
          arguments: { claimId: "clm1", claimToken: "osc_clm_1" },
        }),
      );
      expect(result.isError).toBe(false);
      expect(payload(result)).toEqual({
        status: 200,
        body: '{"state":"approved"}',
      });
    } finally {
      await close();
    }
  });

  it("present_claim fails closed without an identity token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { client, close } = await makeSession();
    try {
      const result = toolResult(
        await client.callTool({
          name: "present_claim",
          arguments: { claimId: "clm1", claimToken: "osc_clm_1" },
        }),
      );
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({
        error: "present_claim_failed",
        message: expect.stringContaining("OPENSESAME_IDENTITY_TOKEN"),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("present_claim wraps network failures as tool errors", async () => {
    process.env.OPENSESAME_IDENTITY_TOKEN = "id_tok_1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("socket hangup")),
    );
    const { client, close } = await makeSession();
    try {
      const result = toolResult(
        await client.callTool({
          name: "present_claim",
          arguments: { claimId: "clm1", claimToken: "osc_clm_1" },
        }),
      );
      expect(result.isError).toBe(true);
      expect(payload(result)).toEqual({
        error: "present_claim_failed",
        message: "socket hangup",
      });
    } finally {
      await close();
    }
  });
});
