import type { BoundaryValue, JsonValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import { createOnePasswordWorkerEngine } from "./onepassword-sdk.worker.js";
import {
  ONEPASSWORD_HTTP_MAX_BYTES,
  type OnePasswordCommand,
  type OnePasswordFetchMessage,
  type OnePasswordWorkerReply,
  parseOnePasswordResult,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendFetch } from "./types.js";

const origin = "https://app.example";
const initialize = {
  type: "initialize",
  id: 1,
  settings: {
    serviceAccountToken: "private-unit-fixture-not-a-provider-token",
    accountOrigin: "https://account.example",
    vaultId: "chosen-vault",
  },
  assets: {
    origin,
    runtimeUrl: `${origin}/base/${artifacts.assets.runtime}`,
    wasmUrl: `${origin}/base/${artifacts.assets.wasm}`,
  },
} as const;
const token = initialize.settings.serviceAccountToken;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const sdk = {
    init_client: vi.fn(async (_config: string) => "71"),
    invoke: vi.fn(async (_config: string) => "{}"),
    release_client: vi.fn((_client: string) => undefined),
  };
  const replies: Array<OnePasswordWorkerReply | OnePasswordFetchMessage> = [];
  let installed: SecretBackendFetch | undefined;
  const ports = {
    origin,
    boot: vi.fn(async () => sdk),
    installFetch: vi.fn((fetcher: SecretBackendFetch) => {
      installed = fetcher;
    }),
    post: vi.fn((reply: OnePasswordWorkerReply | OnePasswordFetchMessage) => {
      replies.push(reply);
    }),
    stop: vi.fn(),
  };
  const engine = createOnePasswordWorkerEngine(ports);
  return { sdk, ports, engine, replies, installed: () => installed };
}
async function ready(f: ReturnType<typeof fixture>) {
  f.engine.receive(initialize);
  await vi.waitFor(() =>
    expect(f.replies).toContainEqual({ type: "initialized", id: 1 }),
  );
}

describe("1Password worker engine IPC/lifetime (fake SDK, no positive authentication)", () => {
  it("boots owned assets then installs broker before native init with accurate metadata", async () => {
    const f = fixture();
    f.sdk.init_client.mockImplementation(async (config) => {
      expect(f.ports.boot).toHaveBeenCalledOnce();
      expect(f.ports.installFetch).toHaveBeenCalledOnce();
      const fetcher = f.installed();
      if (!fetcher) throw new Error("Missing installed broker");
      const pending = fetcher(
        `${initialize.settings.accountOrigin}/api/v3/auth/start`,
      );
      await vi.waitFor(() =>
        expect(f.replies).toContainEqual(
          expect.objectContaining({ type: "fetch", id: 1 }),
        ),
      );
      f.engine.receive({
        type: "fetch-result",
        id: 1,
        ok: true,
        status: 401,
        statusText: "Unauthorized",
        url: `${initialize.settings.accountOrigin}/api/v3/auth/start`,
        headers: [],
        body: new Uint8Array([123, 125]),
      });
      expect((await pending).status).toBe(401);
      expect(JSON.parse(config)).toEqual({
        serviceAccountToken: initialize.settings.serviceAccountToken,
        programmingLanguage: "JS",
        sdkVersion: "0050002",
        integrationName: "OpenSesame",
        integrationVersion: "0.1.0",
        requestLibraryName: "Fetch API",
        requestLibraryVersion: "Fetch API",
        os: "browser",
        osVersion: "0.0.0",
        architecture: "wasm32",
      });
      return "71";
    });
    await ready(f);
    expect(f.replies.at(-1)).toEqual({ type: "initialized", id: 1 });
    f.engine.close();
  });

  it.each([
    { name: "VaultsList" },
    { name: "ItemsList" },
    { name: "ItemsGet", itemId: "native:item" },
    {
      name: "ItemsCreate",
      params: {
        vaultId: "chosen-vault",
        title: "native title",
        extra: { preserved: true },
      },
    },
    {
      name: "ItemsPut",
      item: {
        vaultId: "chosen-vault",
        id: "native:item",
        version: 4,
        fields: [],
      },
    },
    { name: "ItemsDelete", itemId: "native:item" },
  ] satisfies OnePasswordCommand[])(
    "constructs scoped native $name with private numeric ID",
    async (command) => {
      const f = fixture();
      await ready(f);
      f.engine.receive({ type: "invoke", id: 2, command });
      await vi.waitFor(() =>
        expect(f.replies).toContainEqual(
          expect.objectContaining({ type: "result", id: 2 }),
        ),
      );
      const expected = {
        VaultsList: {},
        ItemsList: { vault_id: "chosen-vault", filters: [] },
        ItemsGet: { vault_id: "chosen-vault", item_id: "native:item" },
        ItemsCreate: { params: "params" in command ? command.params : null },
        ItemsPut: { item: "item" in command ? command.item : null },
        ItemsDelete: { vault_id: "chosen-vault", item_id: "native:item" },
      };
      expect(JSON.parse(f.sdk.invoke.mock.calls[0]?.[0] ?? "null")).toEqual({
        invocation: {
          clientId: 71,
          parameters: {
            name: command.name,
            parameters: expected[command.name],
          },
        },
      });
      expect(JSON.stringify(f.replies)).not.toContain(token);
      expect(JSON.stringify(f.replies)).not.toContain("71");
      f.engine.close();
    },
  );

  it("accepts the official void delete response without parsing it as JSON", async () => {
    const f = fixture();
    f.sdk.invoke.mockResolvedValue("");
    await ready(f);
    f.engine.receive({
      type: "invoke",
      id: 2,
      command: { name: "ItemsDelete", itemId: "item" },
    });
    await vi.waitFor(() =>
      expect(f.replies.at(-1)).toEqual({ type: "result", id: 2, result: null }),
    );
    f.engine.close();
  });

  it.each(["origin", "runtime", "wasm", "extra"] as const)(
    "refuses %s assets before SDK bootstrap",
    async (kind) => {
      const f = fixture();
      const assets = {
        origin: {
          ...initialize.assets,
          origin: "https://elsewhere.example",
        },
        runtime: {
          ...initialize.assets,
          runtimeUrl: `${origin}/untrusted.mjs`,
        },
        wasm: {
          ...initialize.assets,
          wasmUrl: `${origin}/other/${artifacts.assets.wasm}`,
        },
        extra: { ...initialize.assets, eval: "forbidden" },
      };
      f.engine.receive({ ...initialize, assets: assets[kind] });
      expect(f.ports.boot).not.toHaveBeenCalled();
      expect(f.sdk.init_client).not.toHaveBeenCalled();
      expect(f.ports.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(["-1", "NaN", "01", "9007199254740992", '{"clientId":1}'])(
    "rejects malformed native client ID %s without leaking it",
    async (id) => {
      const f = fixture();
      f.sdk.init_client.mockResolvedValue(id);
      f.engine.receive(initialize);
      await vi.waitFor(() => expect(f.ports.stop).toHaveBeenCalledOnce());
      expect(f.replies).toEqual([{ type: "closed", code: "operation" }]);
    },
  );

  it.each(["during-boot", "during-init"])(
    "drops initialization completion %s after close",
    async (phase) => {
      const f = fixture();
      const heldBoot = deferred<typeof f.sdk>();
      const heldInit = deferred<string>();
      if (phase === "during-boot")
        f.ports.boot.mockReturnValue(heldBoot.promise);
      else f.sdk.init_client.mockReturnValue(heldInit.promise);
      f.engine.receive(initialize);
      await vi.waitFor(() => expect(f.ports.boot).toHaveBeenCalledOnce());
      if (phase === "during-init")
        await vi.waitFor(() =>
          expect(f.sdk.init_client).toHaveBeenCalledOnce(),
        );
      f.engine.close();
      heldBoot.resolve(f.sdk);
      heldInit.resolve("71");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(f.replies).toEqual([{ type: "closed", code: "session" }]);
      expect(f.ports.stop).toHaveBeenCalledOnce();
      if (phase === "during-boot")
        expect(f.sdk.init_client).not.toHaveBeenCalled();
    },
  );

  it("serializes commands and dispose bypasses an unresolved invoke", async () => {
    const f = fixture();
    const held = deferred<string>();
    f.sdk.invoke.mockReturnValueOnce(held.promise);
    await ready(f);
    f.engine.receive({ type: "invoke", id: 2, command: { name: "ItemsList" } });
    f.engine.receive({
      type: "invoke",
      id: 3,
      command: { name: "VaultsList" },
    });
    await vi.waitFor(() => expect(f.sdk.invoke).toHaveBeenCalledOnce());
    f.engine.receive({ type: "dispose", id: 4 });
    expect(f.sdk.release_client).toHaveBeenCalledExactlyOnceWith("71");
    expect(f.replies.at(-1)).toEqual({ type: "disposed", id: 4 });
    held.resolve("{}");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(f.sdk.invoke).toHaveBeenCalledOnce();
    expect(f.ports.stop).toHaveBeenCalledOnce();
  });

  it("bounds queued operations and denies caller client IDs, replay and wrong vaults", async () => {
    const invalid: BoundaryValue[] = [
      { type: "invoke", id: 2, clientId: 999, command: { name: "ItemsList" } },
      { type: "invoke", id: 1, command: { name: "ItemsList" } },
      {
        type: "invoke",
        id: 2,
        command: { name: "ItemsCreate", params: { vaultId: "wrong" } },
      },
      {
        type: "invoke",
        id: 2,
        command: { name: "ItemsPut", item: { vaultId: "wrong", id: "item" } },
      },
      { type: "invoke", id: 2, command: { name: "invoke_sync" } },
    ];
    for (const message of invalid) {
      const f = fixture();
      await ready(f);
      f.engine.receive(message);
      await vi.waitFor(() => expect(f.ports.stop).toHaveBeenCalledOnce());
      expect(f.sdk.invoke).not.toHaveBeenCalled();
    }
    const f = fixture();
    await ready(f);
    for (let id = 2; id <= 34; id++)
      f.engine.receive({ type: "invoke", id, command: { name: "ItemsList" } });
    expect(f.ports.stop).toHaveBeenCalledOnce();
  });

  it("rejects malformed, huge, deep and excessive-node JSON results", async () => {
    let deep: JsonValue = null;
    for (let i = 0; i < 22; i++) deep = { nested: deep };
    const results = [
      "not JSON: private token",
      " ".repeat(ONEPASSWORD_HTTP_MAX_BYTES + 1),
      JSON.stringify(deep),
      JSON.stringify(Array.from({ length: 20_001 }, () => null)),
    ];
    for (const result of results) {
      const f = fixture();
      f.sdk.invoke.mockResolvedValue(result);
      await ready(f);
      f.engine.receive({
        type: "invoke",
        id: 2,
        command: { name: "ItemsList" },
      });
      await vi.waitFor(() => expect(f.ports.stop).toHaveBeenCalledOnce());
      expect(f.replies.at(-1)).toEqual({ type: "closed", code: "operation" });
    }
    expect(() => parseOnePasswordResult('{"value":null}')).not.toThrow();
  });

  it.each(["normal-reply", "closed-reply"])(
    "throwing %s post closes exactly once without recursion",
    async (kind) => {
      const f = fixture();
      f.ports.post.mockImplementation(() => {
        throw new Error("raw post detail");
      });
      f.engine.receive(
        kind === "normal-reply" ? initialize : { invalid: true },
      );
      await vi.waitFor(() => expect(f.ports.stop).toHaveBeenCalledOnce());
      f.engine.close();
      expect(f.ports.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(["AuthExpired", "RateLimitExceeded"])(
    "handles exact native %s safely",
    async (name) => {
      const f = fixture();
      await ready(f);
      f.sdk.invoke.mockRejectedValue(
        JSON.stringify({ name, message: "private provider detail" }),
      );
      f.engine.receive({
        type: "invoke",
        id: 2,
        command: { name: "ItemsList" },
      });
      const expected =
        name === "AuthExpired"
          ? { type: "closed", code: "session" }
          : { type: "failed", id: 2, code: "operation" };
      await vi.waitFor(() => expect(f.replies.at(-1)).toEqual(expected));
      expect(f.ports.stop).toHaveBeenCalledTimes(
        name === "AuthExpired" ? 1 : 0,
      );
      f.engine.close();
    },
  );

  it.each(["boot", "invoke", "release"])(
    "sanitizes %s failure while retaining safe lifecycle behavior",
    async (kind) => {
      const f = fixture();
      if (kind === "boot")
        f.ports.boot.mockRejectedValue(new Error("private token in bootstrap"));
      else if (kind === "invoke")
        f.sdk.invoke.mockRejectedValue(new Error("private token in SDK"));
      else
        f.sdk.release_client.mockImplementation(() => {
          throw new Error("private native client ID");
        });
      if (kind === "boot") {
        f.engine.receive(initialize);
        await vi.waitFor(() => expect(f.ports.stop).toHaveBeenCalledOnce());
        expect(f.sdk.init_client).not.toHaveBeenCalled();
      } else {
        await ready(f);
        if (kind === "invoke") {
          f.engine.receive({
            type: "invoke",
            id: 2,
            command: { name: "ItemsList" },
          });
          await vi.waitFor(() =>
            expect(f.replies.at(-1)).toEqual({
              type: "failed",
              id: 2,
              code: "operation",
            }),
          );
        }
        f.engine.receive({ type: "dispose", id: 3 });
        expect(f.ports.stop).toHaveBeenCalledOnce();
      }
      expect(JSON.stringify(f.replies)).not.toContain("private");
    },
  );
});
