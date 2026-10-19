import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "../device-connector-records.js";
import { kvForgetAll } from "../kv.js";
import { vaultStore } from "../vault/store.js";
import { secretBackendCredentialTarget } from "./credential-custody.js";
import { saveSecretBackendConnection } from "./runtime.js";
import {
  remoteDraft,
  runtimeFixture,
  runtimePassword,
} from "./runtime.test-support.js";
import { validateSecretBackendDraft } from "./schema.js";
import {
  hydrateSecretBackendConnections,
  readSecretBackendConnection,
  secretBackendRuntimeConfiguration,
} from "./store.js";

const key = Buffer.alloc(32, 29).toString("base64");
const remoteStoreId = "ca576ba4-b6f6-4670-b7c4-d198c9140f5b";
let local: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  local = await runtimeFixture();
});
afterEach(async () => {
  await local.close();
});
function draft() {
  return { ...remoteDraft(), encryptionKey: key, remoteStoreId };
}

it("uses a separate actual vault Token for inventory encryption and cold-reloads it without exposing its value", async () => {
  const saved = await saveSecretBackendConnection(draft());
  const tomb = vaultStore.getSnapshot().tomb;
  expect(
    secretBackendRuntimeConfiguration(saved.connectionId, tomb)?.encryptionKey,
  ).toBe(key);
  expect(readSecretBackendConnection(saved.connectionId)).toMatchObject({
    encryptionKey: "",
    token: "",
    remoteStoreId,
  });
  const credentials = vaultStore
    .getSnapshot()
    .items.filter((item) => item.kind === "credential");
  expect(credentials).toContainEqual(
    expect.objectContaining({
      name: `Encryption key · ${draft().name}`,
      method: expect.objectContaining({ type: "token", token: key }),
    }),
  );
  expect(readDeviceSecrets()[saved.connectionId]).toBeUndefined();
  expect(JSON.stringify(readDeviceRows())).not.toContain(key);
  expect([...local.files.values()].some((bytes) => bytes.includes(key))).toBe(
    false,
  );
  vaultStore.lock();
  kvForgetAll();
  await vaultStore.unlock(runtimePassword);
  await hydrateSecretBackendConnections();
  expect(
    secretBackendRuntimeConfiguration(saved.connectionId, tomb)?.encryptionKey,
  ).toBe(key);
  await saveSecretBackendConnection(
    { ...draft(), name: "Renamed", token: "", encryptionKey: "" },
    saved.connectionId,
  );
  expect(
    secretBackendRuntimeConfiguration(saved.connectionId, tomb)?.encryptionKey,
  ).toBe(key);
});
it("binds the key to its public store identity and refuses silent credential movement", async () => {
  const saved = await saveSecretBackendConnection(draft());
  await expect(
    saveSecretBackendConnection(
      {
        ...draft(),
        remoteStoreId: crypto.randomUUID(),
        token: "",
        encryptionKey: "",
      },
      saved.connectionId,
    ),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(secretBackendCredentialTarget(draft())).not.toBe(
    secretBackendCredentialTarget({
      ...draft(),
      remoteStoreId: crypto.randomUUID(),
    }),
  );
});
it.each(["bad", `${key.slice(0, -1)} `, key.slice(0, -1)])(
  "rejects malformed encryption key %s without contacting a backend",
  async (encryptionKey) => {
    await expect(
      saveSecretBackendConnection({ ...draft(), encryptionKey }),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(local.fetcher).not.toHaveBeenCalled();
  },
);
it("keeps key and bearer separate and retains native Proton and Bitwarden validation", () => {
  expect(() =>
    validateSecretBackendDraft({ ...draft(), token: key }),
  ).toThrow();
  expect(() =>
    validateSecretBackendDraft({
      ...draft(),
      mode: "proton-pass",
      providerId: "proton-pass",
    }),
  ).toThrow();
  expect(() =>
    validateSecretBackendDraft({
      ...draft(),
      mode: "bitwarden-api",
      providerId: "bitwarden",
      clientSecret: "",
    }),
  ).toThrow();
});
it("preserves the exact legacy and application-version credential bindings", () => {
  const old = remoteDraft();
  expect(
    secretBackendCredentialTarget({
      ...old,
      remoteStoreId: "",
      encryptionKey: "",
    }),
  ).toBe(secretBackendCredentialTarget(old));
  expect(
    secretBackendCredentialTarget({ ...old, appVersion: "cli-pass@2.4.2" }),
  ).not.toBe(secretBackendCredentialTarget(old));
});
