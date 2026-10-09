import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import * as kv from "./kv.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { nativeUploadedIcon } from "./native-icon.test-support.js";
import { completeNativeVaultOidc } from "./native-vault-auth.js";
import { readNativeVaultInstance } from "./native-vault-operations.js";
import {
  authorizeNativeVault,
  configureNativeVault,
} from "./native-vault-session.js";
import {
  backend,
  disposers,
  input,
  provider,
  redirectUri,
  state,
  token,
} from "./native-vault.test-support.js";

beforeEach(kv.kvForgetAll);
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  configureHost(createTestHost());
  forgetAtRestKeyForTest();
});
const icon = nativeUploadedIcon;
async function connected(providerId: "vault" | "openbao" = "vault") {
  const reload = backend();
  const service = provider(providerId);
  const parameters = { ...input, providerId };
  const id = await configureNativeVault(parameters);
  await authorizeNativeVault(id, redirectUri);
  await completeNativeVaultOidc(id, { state, code: "real-provider-code" });
  return { ...service, reload, parameters, id };
}
it.each(["vault", "openbao"] as const)(
  "persists %s name and icon without changing verified authority or asking for new consent",
  async (providerId) => {
    const service = await connected(providerId);
    const before = loadNativeConnectorRecord(service.id);
    if (!before) throw new Error("Missing verified connection");
    const calls = service.fetcher.mock.calls.length;
    await configureNativeVault(
      {
        ...service.parameters,
        connectionId: service.id,
        revision: before.revision,
        displayName: "Engineering secrets",
        icon,
      },
      service.transport,
    );
    service.reload();
    const after = loadNativeConnectorRecord(service.id);
    expect(after?.configuration).toMatchObject({
      displayName: "Engineering secrets",
      icon,
      fingerprint: before.configuration.fingerprint,
    });
    expect(after?.privateState).toEqual(before.privateState);
    expect(after?.runtime).toEqual(before.runtime);
    expect(readNativeConnector(service.id)?.status).toBe("connected");
    expect(service.fetcher).toHaveBeenCalledTimes(calls);
    expect(
      (
        await readNativeVaultInstance(
          service.id,
          { mount: "secret", path: "app/config" },
          service.transport,
        )
      ).metadata.version,
    ).toBe(2);
  },
);
it("rejects invalid icons and credential-reflecting names while preserving the connected record", async () => {
  const service = await connected();
  const view = readNativeConnector(service.id);
  if (!view) throw new Error("Missing verified connection");
  const edit = {
    ...service.parameters,
    connectionId: service.id,
    revision: view.revision,
  };
  await expect(
    configureNativeVault(
      { ...edit, icon: "https://evil.test/icon.png" },
      service.transport,
    ),
  ).rejects.toThrow("PNG or JPEG");
  await expect(
    configureNativeVault({ ...edit, displayName: token }, service.transport),
  ).rejects.toThrow("expected response");
  expect(readNativeConnector(service.id)).toEqual(view);
});
it("rejects a stale appearance edit without overwriting a newer saved name", async () => {
  const service = await connected();
  const view = readNativeConnector(service.id);
  if (!view) throw new Error("Missing verified connection");
  const edit = {
    ...service.parameters,
    connectionId: service.id,
    revision: view.revision,
  };
  await configureNativeVault(
    { ...edit, displayName: "Newer name" },
    service.transport,
  );
  await expect(
    configureNativeVault(
      { ...edit, displayName: "Stale name" },
      service.transport,
    ),
  ).rejects.toThrow("changed");
  expect(readNativeConnector(service.id)?.configuration.displayName).toBe(
    "Newer name",
  );
});
