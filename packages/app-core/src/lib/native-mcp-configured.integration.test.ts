import { afterEach, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { kvFlush } from "./kv.js";
import { nativeBrowserMethodPolicy } from "./native-browser-policy.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { configuredMcpClassification } from "./native-mcp-configured-config.js";
import { createConfiguredMcpDriver } from "./native-mcp-configured-driver.js";
import {
  MCP_KEY,
  type McpCredentialMode,
  configuredMcpFixture,
} from "./native-mcp-configured.test-support.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import { itemText } from "./vault/item-departure.js";
import { vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";
const closing: (() => Promise<void> | void)[] = [];
const running: Promise<unknown>[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  await Promise.allSettled(running.splice(0));
});
async function setup(mode: McpCredentialMode = "bearer") {
  const f = await configuredMcpFixture(mode);
  closing.push(f.close);
  return f;
}
function required(id: string) {
  const record = loadNativeConnectorRecord(id);
  if (!record) throw new Error("Missing actual configured MCP record");
  return record;
}
it.each(["bearer", "header", "anonymous"] as const)(
  "proves real %s MCP SDK initialize/list/call with sealed custody and no OAuth grants or endpoints",
  async (mode) => {
    const f = await setup(mode);
    const saved = await f.driver.configure(f.input);
    expect(saved.status).toBe("connected");
    expect(saved.grants).toEqual([]);
    const record = required(saved.connectionId);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.pending).toEqual({});
    expect(record.privateState.recovery).toEqual([]);
    expect(JSON.stringify(readDeviceRows())).not.toContain(MCP_KEY);
    expect(JSON.stringify(record.privateState.credentials)).not.toContain(
      MCP_KEY,
    );
    const items = vaultStore
      .getSnapshot()
      .items.filter(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token === MCP_KEY,
      );
    expect(items).toHaveLength(mode === "anonymous" ? 0 : 1);
    const listed = await f.driver.invoke(
      saved.connectionId,
      "mcp.tools.list",
      {},
    );
    expect(listed.items.map((item) => item.id)).toEqual(["echo"]);
    const result = await f.driver.invoke(saved.connectionId, "mcp.tool:echo", {
      arguments: JSON.stringify({ text: "safe tool request" }),
    });
    expect(result.items[0]?.label).toBe("Credential MCP: safe tool request");
    expect(f.rows.every((row) => row.authorized && row.path === "/mcp")).toBe(
      true,
    );
    expect(f.faults).toEqual([]);
    await vaultStore.flushPendingWrites();
    await vfsFlush();
    await kvFlush();
    expect(JSON.stringify([...f.local.files.values()])).not.toContain(MCP_KEY);
  },
);
it("admits only the actual original MCP resource and never treats resource-only authority as OAuth token authority", async () => {
  const f = await setup();
  expect(nativeBrowserMethodPolicy("adobe", "mcp").available).toBe(false);
  expect(
    nativeBrowserMethodPolicy(
      "adobe",
      "mcp",
      {},
      {
        transport: f.owner.transport,
        resourceEndpoint: f.input.parameters.mcp_url ?? "",
      },
    ).available,
  ).toBe(true);
  expect(
    nativeBrowserMethodPolicy(
      "resend",
      "oauth",
      {},
      {
        transport: f.owner.transport,
        resourceEndpoint: f.input.parameters.mcp_url ?? "",
      },
    ).available,
  ).toBe(false);
  const unavailable = createConfiguredMcpDriver({
    capture: async () => ({
      ...f.owner,
      transport: { ...f.owner.transport, supportsNativeOrigin: () => false },
    }),
  });
  await expect(unavailable.configure(f.input)).rejects.toThrow();
  expect(f.rows).toEqual([]);
  expect(
    vaultStore
      .getSnapshot()
      .items.some(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token === MCP_KEY,
      ),
  ).toBe(false);
});
it.each(["wrong-key", "anonymous-requires-key", "bad-initialize"])(
  "never activates %s as a verified MCP connection",
  async (kind) => {
    const f = await setup(
      kind === "anonymous-requires-key" ? "anonymous" : "bearer",
    );
    if (kind === "wrong-key")
      f.input.credentials.mcp_token = "wrong operator credential";
    if (kind === "anonymous-requires-key") f.state.refuse = true;
    if (kind === "bad-initialize") f.state.badInitialize = true;
    await expect(f.driver.configure(f.input)).rejects.toThrow();
    for (const row of readDeviceRows())
      expect(JSON.stringify(row)).not.toContain(MCP_KEY);
    expect(f.rows.some((row) => row.path !== "/mcp")).toBe(false);
  },
);
it("retains an unchanged configured credential on blank edit, without creating another Token", async () => {
  const f = await setup("header");
  const saved = await f.driver.configure(f.input);
  const old = required(saved.connectionId);
  const itemCount = vaultStore.getSnapshot().items.length;
  const edited = await f.driver.configure({
    ...f.input,
    connectionId: saved.connectionId,
    revision: saved.revision,
    credentials: { mcp_token: "" },
    displayName: "Safe display preference",
  });
  expect(edited.status).toBe("connected");
  expect(edited.configuration.displayName).toBe("Safe display preference");
  expect(required(edited.connectionId).privateState.credentials).toEqual(
    old.privateState.credentials,
  );
  expect(vaultStore.getSnapshot().items).toHaveLength(itemCount);
  await expect(
    f.driver.configure({
      ...f.input,
      connectionId: edited.connectionId,
      revision: edited.revision,
      credentials: {},
      parameters: { ...f.input.parameters, mcp_header: "X-Different-Key" },
    }),
  ).rejects.toThrow();
});
it.each(["caller", "owner", "vault", "credential", "revision"])(
  "physically drains a held real MCP response on original %s withdrawal",
  async (kind) => {
    const f = await setup();
    const saved = await f.driver.configure(f.input);
    f.state.hold = "tools/list";
    const caller = new AbortController();
    const pending = f.driver.invoke(
      saved.connectionId,
      "mcp.tools.list",
      {},
      caller.signal,
    );
    running.push(pending);
    const refused = expect(pending).rejects.toThrow();
    await expect
      .poll(() => f.rows.some((row) => row.rpc === "tools/list" && !row.ended))
      .toBe(true);
    const held = f.rows.find((row) => row.rpc === "tools/list" && !row.ended);
    expect(held).toBeTruthy();
    if (kind === "caller") caller.abort();
    if (kind === "owner") f.abort.abort();
    if (kind === "vault") vaultStore.lock();
    if (kind === "credential") {
      const item = vaultStore
        .getSnapshot()
        .items.find(
          (item) =>
            item.kind === "credential" &&
            item.method.type === "token" &&
            item.method.token === MCP_KEY,
        );
      if (!item) throw new Error("Missing sealed Token");
      await vaultStore.withdrawItems({
        items: { [item.id]: itemText(item) },
        folderIds: [],
      });
    }
    if (kind === "revision") {
      const record = required(saved.connectionId);
      await updateNativeConnector(
        saved.connectionId,
        nativeOAuthGuard(record),
        configuredMcpClassification(),
        (current) => {
          current.configuration.displayName = "Different revision";
          return current;
        },
      );
    }
    await refused;
    await expect.poll(() => held?.closed).toBe(true);
    expect(held?.premature).toBe(true);
    expect(held?.ended).toBe(false);
    if (kind === "caller") {
      f.state.hold = "";
      await expect(
        f.driver.invoke(saved.connectionId, "mcp.tools.list", {}),
      ).resolves.toMatchObject({ label: "Actual credential MCP" });
    }
  },
);
it("refuses metadata retargeting even when an old credential fingerprint is copied", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  const record = required(saved.connectionId);
  await updateNativeConnector(
    saved.connectionId,
    nativeOAuthGuard(record),
    configuredMcpClassification(),
    (current) => {
      current.configuration.parameters.mcp_url = `${f.origin}/foreign`;
      return current;
    },
  );
  const count = f.rows.length;
  await expect(f.driver.verify(saved.connectionId)).rejects.toThrow();
  expect(f.rows).toHaveLength(count);
});
it("does not expose credential echoes and invalidates proof after actual401", async () => {
  const f = await setup();
  const saved = await f.driver.configure(f.input);
  f.state.echo = true;
  await expect(
    f.driver.invoke(saved.connectionId, "mcp.tool:echo", {
      arguments: '{"text":"safe"}',
    }),
  ).rejects.toMatchObject({ code: "response" });
  f.state.echo = false;
  f.state.refuse = true;
  await expect(
    f.driver.invoke(saved.connectionId, "mcp.tools.list", {}),
  ).rejects.toThrow();
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
});
it.each([
  "Cookie",
  "Host",
  "Mcp-Session-Id",
  "Content-Type",
  "Proxy-Authorization",
])(
  "refuses forbidden credential header %s before vault staging or HTTP",
  async (name) => {
    const f = await setup("header");
    f.input.parameters.mcp_header = name;
    await expect(f.driver.configure(f.input)).rejects.toThrow();
    expect(f.rows).toEqual([]);
  },
);
it("refuses credential URL/query injection and credentials on explicit anonymous mode", async () => {
  const f = await setup("anonymous");
  await expect(
    f.driver.configure({ ...f.input, credentials: { mcp_token: MCP_KEY } }),
  ).rejects.toThrow();
  await expect(
    f.driver.configure({
      ...f.input,
      parameters: {
        ...f.input.parameters,
        mcp_url: `${f.origin}/mcp?api_key=hidden`,
      },
    }),
  ).rejects.toThrow();
  expect(f.rows).toEqual([]);
});

it("refuses missing original cancellation authority and pre-aborted callers before custody or HTTP", async () => {
  const f = await setup();
  const { signal, ...transport } = f.owner.transport;
  expect(signal).toBe(f.abort.signal);
  let captures = 0;
  const missing = createConfiguredMcpDriver({
    capture: async () => {
      captures++;
      return { ...f.owner, transport };
    },
  });
  await expect(missing.configure(f.input)).rejects.toThrow();
  expect(f.rows).toEqual([]);
  expect(captures).toBe(1);
  const caller = new AbortController();
  caller.abort();
  await expect(
    missing.invoke("never-loaded", "mcp.tools.list", {}, caller.signal),
  ).rejects.toThrow();
  expect(captures).toBe(1);
  expect(f.rows).toEqual([]);
});

it("uses the same canonical origin-only endpoint over actual TLS while retaining the raw saved binding and all path restrictions", async () => {
  const f = await configuredMcpFixture("bearer", "/");
  closing.push(f.close);
  expect(f.input.parameters.mcp_url).toBe(f.origin);
  const saved = await f.driver.configure(f.input);
  expect(saved.status).toBe("connected");
  expect(saved.configuration.parameters.mcp_url).toBe(f.origin);
  const result = await f.driver.invoke(saved.connectionId, "mcp.tool:echo", {
    arguments: '{"text":"canonical origin endpoint"}',
  });
  expect(result.items[0]?.label).toBe(
    "Credential MCP: canonical origin endpoint",
  );
  expect(f.rows.every((row) => row.path === "/" && row.authorized)).toBe(true);
  expect(f.faults).toEqual([]);
});
