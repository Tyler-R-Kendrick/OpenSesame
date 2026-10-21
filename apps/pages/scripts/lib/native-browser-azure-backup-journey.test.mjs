/** @vitest-environment node */
import { ensureDeviceIdentityKey } from "@opensesame/app-core/lib/device-identity-key.js";
import { azureSecretsKeyFlows } from "@opensesame/app-core/lib/native-azure-secrets.js";
import {
  backUpVaultToSecretBackend,
  restoreVaultFromSecretBackend,
} from "@opensesame/app-core/lib/secret-backends/backup-transfer.js";
import { openSavedAzureKeyVaultBackend } from "@opensesame/app-core/lib/secret-backends/factory.js";
import { azureCrudOracle } from "@opensesame/app-core/lib/test/native-azure-secrets-backup-fixture.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../../src/sections/connections/connect/native-connector-integration.test-support.js";
import { createAzureBackupAuthority } from "./native-browser-azure-backup-authority.mjs";
import { AZURE_SECRETS_FIXTURE as f } from "./native-browser-azure-secrets.mjs";
import { PIN } from "./pages-journey.mjs";
import { openBrowserBackup } from "./secret-backend-backup-oracle.mjs";

installConnectorIntegration();
const closes = [];
let current;
beforeEach(async () => {
  current = await prepared();
});
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function prepared() {
  const dom = new JSDOM("", { url: "https://selfhost.example/OpenSesame/" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  closes.push(async () => dom.window.close());
  const fixture = connectorIntegration();
  const o = await azureCrudOracle();
  fixture.route.respond = (request) => o.transport.fetch(request);
  const saved = await azureSecretsKeyFlows.configure(o.draft, o.transport);
  closes.push(() => o.close());
  await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb);
  await vaultStore.enrollPin(PIN);
  await vaultStore.removePassword();
  const item = createItem("secret", "Azure browser encrypted source");
  item.value = "controlled-private-backup-canary";
  await vaultStore.saveItem(item);
  const opened = await openSavedAzureKeyVaultBackend(saved.connectionId, {
    transport: o.transport,
    vault: vaultStore,
  });
  closes.push(() => opened.backend.disconnect(opened.session));
  return { ...o, item, opened };
}
async function uploaded(o) {
  const reference = await backUpVaultToSecretBackend(
    o.opened,
    "opensesame-browser-backup-desktop",
    vaultStore,
  );
  const stored = await o.opened.backend.getItem(reference.id, o.opened.session);
  return { reference, stored };
}
async function purge(o) {
  await vaultStore.trashItem(o.item.id);
  await vaultStore.purgeItem(o.item.id);
  expect(
    vaultStore.getSnapshot().items.some((item) => item.id === o.item.id),
  ).toBe(false);
}
it("independently opens actual PIN-encrypted TLS PUT bytes and preserves them in documented browser authority", async () => {
  const o = current;
  const { stored } = await uploaded(o);
  const source = await openBrowserBackup(stored.secret, PIN);
  expect(source.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: o.item.id, value: o.item.value }),
    ]),
  );
  expect(o.service.requests.some((request) => request.method === "PUT")).toBe(
    true,
  );
  expect(stored.secret).not.toContain(o.item.value);
  expect(stored.secret).not.toContain(o.draft.credentials.token);
  const authority = {
    state: { calls: [], reject: new Set(), expectedResponses: new WeakMap() },
  };
  const model = createAzureBackupAuthority(f, authority, {
    check: (ok) => expect(ok).toBe(true),
  });
  const url = `${f.vaultURL}/secrets/opensesame-browser-backup-desktop?api-version=${f.apiVersion}`;
  const reply = model.dispatch(
    {
      url: () => url,
      method: () => "PUT",
      postData: () => JSON.stringify({ value: stored.secret }),
    },
    {
      authorization: `Bearer ${f.token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
  );
  expect(reply.status).toBe(200);
  expect(JSON.parse(reply.body).value).toBe(stored.secret);
});
it("refuses a wrong PIN without restoring and then imports the actually purged item with the enrolled PIN", async () => {
  const o = current;
  const { reference } = await uploaded(o);
  await purge(o);
  expect(
    vaultStore.getSnapshot().items.some((item) => item.id === o.item.id),
  ).toBe(false);
  await expect(
    restoreVaultFromSecretBackend(
      o.opened,
      reference.id,
      "13579246",
      vaultStore,
    ),
  ).rejects.toThrow();
  expect(
    vaultStore.getSnapshot().items.some((item) => item.id === o.item.id),
  ).toBe(false);
  expect(
    await restoreVaultFromSecretBackend(
      o.opened,
      reference.id,
      PIN,
      vaultStore,
    ),
  ).toBe(1);
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: o.item.id, value: o.item.value }),
    ]),
  );
});
it("restores actual purged content and preserves it through cold enrolled PIN unlock", async () => {
  const o = current;
  const { reference } = await uploaded(o);
  await purge(o);
  expect(
    await restoreVaultFromSecretBackend(
      o.opened,
      reference.id,
      PIN,
      vaultStore,
    ),
  ).toBe(1);
  await vaultStore.flushPendingWrites();
  vaultStore.lock();
  await vaultStore.unlockWithPin(PIN);
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: o.item.id, value: o.item.value }),
    ]),
  );
});
it("keeps the real25KiB destination bound before any authenticated PUT", async () => {
  const o = current;
  o.item.value = "x".repeat(30000);
  await vaultStore.saveItem(o.item);
  await expect(
    backUpVaultToSecretBackend(
      o.opened,
      "opensesame-browser-backup-phone",
      vaultStore,
    ),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(o.service.requests.some((request) => request.method === "PUT")).toBe(
    false,
  );
});
