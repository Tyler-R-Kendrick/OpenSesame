import type { JsonObject, JsonValue } from "@opensesame/os-domain";
import { vi } from "vitest";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import type { OnePasswordSdkClient } from "./onepassword-sdk-loader.js";
import { createOnePasswordSdkBackend } from "./onepassword-sdk.js";
import { secretBackendDraft } from "./presets.js";
import type { SecretBackendTransport } from "./transport.js";

export function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const vaultId = "native-fixture-vault";
export const itemId = "native-fixture-item";
const date = "2026-10-15T04:05:06.123456789Z";
export function nativeVault(id = vaultId): JsonObject {
  return {
    id,
    title: "Native fixture vault",
    description: "Read-only composition fixture",
    vaultType: "userCreated",
    activeItemCount: 1,
    contentVersion: 4,
    attributeVersion: 2,
    createdAt: date,
    updatedAt: date,
  };
}
export function nativeOverview(changes: JsonObject = {}): JsonObject {
  return {
    id: itemId,
    vaultId,
    title: "Native login",
    category: "Login",
    tags: [],
    websites: [],
    createdAt: date,
    updatedAt: date,
    state: "active",
    ...changes,
  };
}
export function nativeItem(changes: JsonObject = {}): JsonObject {
  const { state: _state, ...overview } = nativeOverview();
  return {
    ...overview,
    notes: "native fixture notes",
    version: 17,
    sections: [],
    files: [],
    fields: [
      {
        id: "username",
        title: "User",
        fieldType: "Text",
        value: "native-user",
      },
      {
        id: "password",
        title: "Password",
        fieldType: "Concealed",
        value: "private-native-marker",
      },
    ],
    future: { retain: true },
    ...changes,
  };
}
export function sdkFixture() {
  const owner = new AbortController();
  const native = new AbortController();
  const assets = {
    origin: "https://app.invalid",
    runtimeUrl: `https://app.invalid/native/${artifacts.assets.runtime}`,
    wasmUrl: `https://app.invalid/native/${artifacts.assets.wasm}`,
  };
  const config = {
    ...secretBackendDraft("1password"),
    token: "synthetic-native-token-marker",
    baseUrl: "https://account.1password.invalid/",
    vaultId,
  };
  const transport: SecretBackendTransport = {
    signal: owner.signal,
    assertCurrent: vi.fn(),
    fetch: vi.fn(),
  };
  const invoke = vi.fn<OnePasswordSdkClient["invoke"]>(
    async (command): Promise<JsonValue> => {
      if (command.name === "VaultsList")
        return [nativeVault("other"), nativeVault()];
      if (command.name === "ItemsList") return [nativeOverview()];
      if (command.name === "ItemsGet")
        return nativeItem({ id: command.itemId });
      throw new Error("Unexpected write in read-only fixture");
    },
  );
  const dispose = vi.fn<OnePasswordSdkClient["dispose"]>(async () => {
    native.abort();
  });
  const client: OnePasswordSdkClient = {
    invoke,
    dispose,
    closed: native.signal,
  };
  const factory = vi.fn<
    typeof import("./onepassword-sdk-loader.js").createBrowserOnePasswordClient
  >(async () => client);
  const backend = createOnePasswordSdkBackend(assets, transport, factory);
  return {
    owner,
    native,
    assets,
    config,
    transport,
    invoke,
    dispose,
    client,
    factory,
    backend,
  };
}
