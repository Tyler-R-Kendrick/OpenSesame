import { afterEach, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { kvFlush } from "./kv.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
  nativeOAuthClientClassification,
  readNativeOAuthClientSecret,
} from "./native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "./native-oauth-client-exchange.js";
import {
  invokeNativeOAuthMcpTool,
  listNativeOAuthMcpTools,
  verifyNativeOAuthMcpResource,
} from "./native-oauth-mcp-operations.js";
import {
  MCP_REFRESH,
  MCP_SECRET,
  MCP_TOKEN,
  type McpClientMethod,
  oauthMcpFixture,
} from "./native-oauth-mcp.test-support.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import { vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";
const closing: (() => Promise<void>)[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  await Promise.allSettled(pending.splice(0));
});
async function setup(
  method: McpClientMethod = "none",
  format: "json" | "sse" = "json",
) {
  const fixture = await oauthMcpFixture(method, format);
  closing.push(fixture.close);
  const saved = await configureNativeOAuthClient(fixture.input, fixture.owner);
  const authorization = new URL(
    await beginNativeOAuthClient(saved.connectionId, fixture.owner),
  );
  fixture.state.challenge =
    authorization.searchParams.get("code_challenge") ?? "";
  const search = new URLSearchParams({
    native_state: authorization.searchParams.get("state") ?? "",
    native_code: "one-use-code",
  }).toString();
  const receipt = await exchangeNativeOAuthClient(search, fixture.owner);
  return { ...fixture, id: saved.connectionId, authorization, receipt };
}
it.each(["none", "client_secret_basic", "client_secret_post"] as const)(
  "authenticates %s with real PKCE/custody then consumes a genuine MCP tool result",
  async (method) => {
    const f = await setup(method);
    expect(f.authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(f.authorization.href).not.toContain(encodeURIComponent(MCP_SECRET));
    expect(f.state.issued).toBe(1);
    const before = requireNativeOAuthRecord(f.id);
    expect(before.privateState.grants).toEqual({});
    expect(before.privateState.recovery[0]?.grant).toMatchObject({
      accessToken: MCP_TOKEN,
      refreshToken: MCP_REFRESH,
    });
    expect(JSON.stringify(readDeviceRows())).not.toContain(MCP_SECRET);
    expect(JSON.stringify(before.privateState.credentials)).not.toContain(
      MCP_SECRET,
    );
    expect(readNativeOAuthClientSecret(f.id, f.owner)).toBe(
      method === "none" ? undefined : MCP_SECRET,
    );
    const verified = await verifyNativeOAuthMcpResource(f.id, f.owner);
    expect(verified.discovery.tools.map((tool) => tool.name)).toEqual(["echo"]);
    const record = requireNativeOAuthRecord(f.id);
    expect(record.configuration.method).toBe("oauth");
    expect(record.runtime.identity?.kind).toBe("mcp-resource");
    expect(record.privateState.recovery).toEqual([]);
    expect(record.privateState.grants.user?.accessToken).toBe(MCP_TOKEN);
    expect(readNativeConnector(f.id)?.status).toBe("connected");
    const list = await listNativeOAuthMcpTools(f.id, f.owner);
    expect(list.server.name).toBe("Owned configured MCP");
    await expect(
      invokeNativeOAuthMcpTool(
        f.id,
        "echo",
        { text: "explicit safe question" },
        f.owner,
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Actual MCP: explicit safe question" }],
      structuredContent: { echo: "Actual MCP: explicit safe question" },
    });
    expect(f.rows.filter((row) => row.rpc === "tools/call")).toHaveLength(1);
    expect(f.rows.every((row) => row.authenticated)).toBe(true);
    expect(f.faults).toEqual([]);
    await vaultStore.flushPendingWrites();
    await vfsFlush();
    await kvFlush();
    const ciphertext = JSON.stringify([...f.local.files.values()]);
    for (const secret of [MCP_SECRET, MCP_TOKEN, MCP_REFRESH])
      expect(ciphertext).not.toContain(secret);
  },
);
it("handles real SSE Streamable HTTP replies with exact session/protocol headers and advertised schema", async () => {
  const f = await setup("client_secret_basic", "sse");
  await verifyNativeOAuthMcpResource(f.id, f.owner);
  await expect(
    invokeNativeOAuthMcpTool(f.id, "echo", { text: "SSE tool value" }, f.owner),
  ).resolves.toMatchObject({
    structuredContent: { echo: "Actual MCP: SSE tool value" },
  });
  const count = f.rows.length;
  await expect(
    invokeNativeOAuthMcpTool(
      f.id,
      "echo",
      { unknown: "not advertised" },
      f.owner,
    ),
  ).rejects.toMatchObject({ code: "arguments" });
  expect(f.rows.slice(count).some((row) => row.rpc === "tools/call")).toBe(
    false,
  );
  expect(f.faults).toEqual([]);
});
it("retains the issued credential obligation when actual MCP initialization fails", async () => {
  const f = await setup();
  f.state.badInitialize = true;
  await expect(verifyNativeOAuthMcpResource(f.id, f.owner)).rejects.toThrow();
  const record = requireNativeOAuthRecord(f.id);
  expect(record.privateState.grants).toEqual({});
  expect(record.runtime.verifiedAt).toBeNull();
  expect(record.privateState.recovery[0]?.grant?.accessToken).toBe(MCP_TOKEN);
});
it("refuses a changed saved endpoint before any MCP egress", async () => {
  const f = await setup();
  const record = requireNativeOAuthRecord(f.id);
  await updateNativeConnector(
    f.id,
    nativeOAuthGuard(record),
    nativeOAuthClientClassification(),
    (current) => {
      current.configuration.parameters.resource += "/other";
      return current;
    },
  );
  const count = f.rows.length;
  await expect(verifyNativeOAuthMcpResource(f.id, f.owner)).rejects.toThrow();
  expect(f.rows).toHaveLength(count);
  expect(requireNativeOAuthRecord(f.id).privateState.grants).toEqual({});
});
it.each(["owner", "caller", "revision", "vault"] as const)(
  "physically closes held actual verification on original %s withdrawal with no activated grant",
  async (kind) => {
    const f = await setup();
    f.state.hold = "tools/list";
    const caller = new AbortController();
    const running = verifyNativeOAuthMcpResource(f.id, f.owner, caller.signal);
    pending.push(running);
    const refused = expect(running).rejects.toThrow();
    await expect
      .poll(() => f.rows.some((row) => row.rpc === "tools/list"))
      .toBe(true);
    const held = f.rows.find((row) => row.rpc === "tools/list");
    expect(held?.ended).toBe(false);
    if (kind === "owner") f.abort.abort();
    else if (kind === "caller") caller.abort();
    else if (kind === "vault") vaultStore.lock();
    else {
      const record = requireNativeOAuthRecord(f.id);
      await updateNativeConnector(
        f.id,
        nativeOAuthGuard(record),
        nativeOAuthClientClassification(),
        (current) => {
          current.configuration.displayName = "New semantic page";
          return current;
        },
      );
    }
    await refused;
    await expect.poll(() => held?.closed).toBe(true);
    expect(held?.premature).toBe(true);
    expect(held?.ended).toBe(false);
    if (kind !== "vault") {
      const record = requireNativeOAuthRecord(f.id);
      expect(record.privateState.grants).toEqual({});
      expect(record.privateState.recovery[0]?.grant?.accessToken).toBe(
        MCP_TOKEN,
      );
    }
    if (kind === "caller") {
      f.state.hold = "";
      await verifyNativeOAuthMcpResource(f.id, f.owner);
      await expect(
        invokeNativeOAuthMcpTool(
          f.id,
          "echo",
          { text: "fresh operation" },
          f.owner,
        ),
      ).resolves.toMatchObject({
        structuredContent: { echo: "Actual MCP: fresh operation" },
      });
    }
  },
);
it("marks an actually refused saved grant for reauthorization and never returns credential echo", async () => {
  const f = await setup("client_secret_post");
  await verifyNativeOAuthMcpResource(f.id, f.owner);
  f.state.echo = true;
  await expect(
    invokeNativeOAuthMcpTool(f.id, "echo", { text: "safe" }, f.owner),
  ).rejects.toMatchObject({ code: "response" });
  f.state.echo = false;
  f.state.refuse = true;
  await expect(listNativeOAuthMcpTools(f.id, f.owner)).rejects.toThrow();
  const record = requireNativeOAuthRecord(f.id);
  expect(record.privateState.verification).toBeNull();
  expect(record.runtime.grants[0]?.needsReauth).toBe(true);
  const count = f.rows.length;
  await expect(
    invokeNativeOAuthMcpTool(f.id, "echo", { text: "stale" }, f.owner),
  ).rejects.toThrow();
  expect(f.rows).toHaveLength(count);
});

it("does not claim a physically cancellable operation without the captured original lifetime", async () => {
  const f = await setup();
  const owner = {
    ...f.owner,
    transport: {
      fetch: f.owner.transport.fetch,
      assertCurrent: f.owner.transport.assertCurrent,
    },
  };
  const count = f.rows.length;
  await expect(verifyNativeOAuthMcpResource(f.id, owner)).rejects.toThrow();
  expect(f.rows).toHaveLength(count);
  expect(requireNativeOAuthRecord(f.id).privateState.grants).toEqual({});
});

it("keeps the original captured transport through actual initialize and subsequent requests", async () => {
  const f = await setup();
  const original = f.owner.transport;
  const next = new AbortController();
  let replacementCalls = 0;
  const replacement = {
    ...original,
    signal: next.signal,
    assertCurrent: () => next.signal.throwIfAborted(),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      replacementCalls++;
      return original.fetch(input, init);
    },
  };
  let switched = false;
  f.owner.transport = {
    ...original,
    fetch: async (input, init) => {
      const response = await original.fetch(input, init);
      if (!switched) {
        switched = true;
        f.owner.transport = replacement;
      }
      return response;
    },
  };
  await verifyNativeOAuthMcpResource(f.id, f.owner);
  expect(switched).toBe(true);
  expect(replacementCalls).toBe(0);
  expect(
    f.rows.some((row) => row.rpc === "tools/list" && row.authenticated),
  ).toBe(true);
  await expect(
    invokeNativeOAuthMcpTool(
      f.id,
      "echo",
      { text: "explicit fresh owner" },
      f.owner,
    ),
  ).resolves.toMatchObject({
    structuredContent: { echo: "Actual MCP: explicit fresh owner" },
  });
  expect(replacementCalls).toBeGreaterThan(0);
});
