import { afterEach, expect, it } from "vitest";
import { azureSecretsKeyFlows as flows } from "./native-azure-secrets.js";
import {
  azureBundle,
  azureClosed,
  azureDraft,
  azureList,
  azureOracle,
  azureToken,
  azureValue,
  azureVault,
} from "./native-azure-secrets.test-support.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { nativeKeyDriverFor } from "./native-key-drivers.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function saved(providerId = "azure-sm") {
  const storage = await runtimeFixture();
  closes.push(() => storage.close());
  const oracle = await azureOracle();
  closes.push(() => oracle.close());
  const view = await flows.configure(azureDraft(providerId), oracle.transport);
  return {
    storage,
    oracle,
    view,
    invoke: (operation = "provider.secrets.read", input = {}) =>
      flows.invoke(view.connectionId, operation, input, oracle.transport),
  };
}
it.each(["azure-sm", "azure-key-vault-secrets"])(
  "%s proves actual list access, seals the issued token and consumes list/get",
  async (id) => {
    const s = await saved(id);
    expect(nativeKeyDriverFor(id)).toBe(flows);
    expect(s.view.status).toBe("connected");
    expect(await s.invoke()).toEqual({
      label: "Showing 1 secret names from first page",
      items: [{ id: `${azureVault}/secrets/api-key`, label: "api-key" }],
    });
    expect(await s.invoke("provider.secret.read", { name: "api-key" })).toEqual(
      {
        label: "Secret read once",
        items: [
          {
            id: `${azureVault}/secrets/api-key`,
            label: "api-key",
            secretValue: azureValue,
          },
        ],
      },
    );
    expect(s.oracle.requests.every((request) => request.authorized)).toBe(true);
    expect([...s.storage.files.values()].join()).not.toContain(azureToken);
    expect([...s.storage.files.values()].join()).not.toContain(azureValue);
    expect(
      loadNativeConnectorRecord(s.view.connectionId)?.privateState.credentials
        .token,
    ).toBe(azureToken);
    expect(s.storage.fetcher).not.toHaveBeenCalled();
  },
);
it("retains a blank token only for the original vault and re-proves before saving", async () => {
  const s = await saved();
  const old = loadNativeConnectorRecord(s.view.connectionId);
  if (!old) throw new Error("Missing saved connection");
  await flows.configure(
    {
      ...azureDraft(),
      connectionId: s.view.connectionId,
      revision: old.revision,
      credentials: { token: "" },
    },
    s.oracle.transport,
  );
  expect(s.oracle.requests).toHaveLength(2);
  await expect(
    flows.configure(
      {
        ...azureDraft(),
        connectionId: s.view.connectionId,
        revision: old.revision + 1,
        parameters: { vault_url: "https://other.vault.azure.net" },
        credentials: { token: "" },
      },
      s.oracle.transport,
    ),
  ).rejects.toThrow();
  expect(s.oracle.requests).toHaveLength(2);
});
it.each([401, 403])(
  "HTTP%s ends the saved key proof without reflecting upstream material",
  async (status) => {
    const s = await saved();
    s.oracle.reply({ error: azureToken }, status);
    await expect(s.invoke()).rejects.toMatchObject({ status });
    expect(readNativeConnector(s.view.connectionId)?.status).toBe(
      "configuration",
    );
    expect(
      loadNativeConnectorRecord(s.view.connectionId)?.privateState.verification,
    ).toBeNull();
    const count = s.oracle.requests.length;
    await expect(s.invoke()).rejects.toThrow(
      "Verify Azure Key Vault Secrets access",
    );
    expect(s.oracle.requests).toHaveLength(count);
  },
);
it.each([
  { value: [{ id: "https://other.vault.azure.net/secrets/api-key" }] },
  { value: [...azureList.value, ...azureList.value] },
  { value: [{ id: `${azureVault}/secrets/a%2Fb` }] },
  {
    value: [],
    nextLink:
      "https://other.vault.azure.net/secrets?api-version=2025-07-01&$skiptoken=x",
  },
  {
    value: Array.from({ length: 26 }, (_, i) => ({
      id: `${azureVault}/secrets/key-${i}`,
    })),
  },
])(
  "refuses malformed, cross-vault or excessive list replies %#",
  async (body) => {
    const s = await saved();
    s.oracle.reply(body);
    await expect(s.invoke()).rejects.toThrow();
    expect(s.oracle.requests).toHaveLength(2);
  },
);
it.each([
  {
    ...azureBundle,
    id: "https://other.vault.azure.net/secrets/api-key/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  {
    ...azureBundle,
    id: `${azureVault}/secrets/other/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
  },
  { ...azureBundle, value: azureToken },
  { ...azureBundle, value: encodeURIComponent(azureToken) },
  { ...azureBundle, value: "x".repeat(25601) },
])(
  "refuses wrong secret binding, oversized values and credential reflections %#",
  async (body) => {
    const s = await saved();
    s.oracle.reply(body);
    await expect(
      s.invoke("provider.secret.read", { name: "api-key" }),
    ).rejects.toThrow();
  },
);
it("refuses caller target/body overrides and cross-vault identifiers before authenticated I/O", async () => {
  const s = await saved();
  for (const input of [
    { url: "https://other.test" },
    { token: "replacement" },
    { name: "api-key" },
  ])
    await expect(s.invoke("provider.secrets.read", input)).rejects.toThrow();
  for (const name of [
    "../key",
    "https://other.vault.azure.net/secrets/api-key",
  ])
    await expect(s.invoke("provider.secret.read", { name })).rejects.toThrow();
  expect(s.oracle.requests).toHaveLength(1);
});
it("original transport withdrawal physically drains a held secret stream and forbids later requests", async () => {
  const s = await saved();
  const held = s.oracle.hold();
  const pending = s.invoke("provider.secret.read", { name: "api-key" });
  const rejected = expect(pending).rejects.toThrow();
  await held.arrived.promise;
  s.oracle.owner.abort();
  await rejected;
  await azureClosed(held.closed.promise);
  await expect(s.invoke()).rejects.toThrow();
  expect(s.oracle.requests).toHaveLength(2);
});
