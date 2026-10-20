/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import {
  kvFileName,
  kvFlush,
  kvForgetFiles,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import { loadNativeConnectorRecord } from "@opensesame/app-core/lib/native-connector-store.js";
import { AZURE_FIXTURE_TOKEN } from "@opensesame/app-core/lib/secret-backends/azure-key-vault-http.test-support.js";
import { deferred } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  azureCrudOracle,
  azureSocketClosed,
} from "@opensesame/app-core/lib/test/native-azure-secrets-backup-fixture.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import { createItem } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";

declareConnectionsTutorial();
installConnectorIntegration();
const oracles: Awaited<ReturnType<typeof azureCrudOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const o of oracles.splice(0)) await o.close();
});
async function prepare() {
  const fixture = connectorIntegration();
  const oracle = await azureCrudOracle();
  oracles.push(oracle);
  fixture.route.respond = (request) => oracle.transport.fetch(request);
  return { fixture, ...oracle };
}
function mount(id?: string) {
  const provider = catalogProvider("azure-sm");
  if (!provider) throw new Error("Missing Azure catalog row");
  return render(
    <MemoryRouter initialEntries={["/settings/connections/azure-sm"]}>
      <ConnectorSettingsPage
        provider={provider}
        providerId="azure-sm"
        connection={id ? deviceConnection(id) : null}
        connections={[]}
        loading={false}
        online
        canConfigure
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={() => {}}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
}
async function configure(origin: string) {
  await userEvent.type(screen.getByLabelText("Vault URL"), origin);
  await userEvent.type(
    screen.getByLabelText("Key Vault access token"),
    AZURE_FIXTURE_TOKEN,
  );
  await userEvent.click(
    screen.getByRole("button", {
      name: "Verify and connect Azure Key Vault Secrets",
    }),
  );
  await screen.findByRole("form", { name: "Back up vault" });
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Missing saved native Azure connection");
  return row;
}
it("saves one native credential, cold reloads and uses unchanged shared backup/restore forms with real ciphertext", async (context) => {
  const o = await prepare();
  await vaultStore.enrollPin("83619472");
  await vaultStore.removePassword();
  const source = createItem("secret", "Mounted Azure source");
  source.value = "azure-mounted-plaintext-canary";
  await vaultStore.saveItem(source);
  const ui = mount();
  const row = await configure(o.service.origin);
  expect(screen.getAllByRole("heading", { name: "2 Configure" })).toHaveLength(
    1,
  );
  ui.unmount();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  kvForgetFiles(new Set(DEVICE_CONNECTOR_KEYS.map(kvFileName)));
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlockWithPin("83619472");
  mount(row.connectionId);
  expect(screen.getByLabelText("Key Vault access token")).toHaveProperty(
    "value",
    "",
  );
  fireEvent.submit(await screen.findByRole("form", { name: "Back up vault" }));
  await waitFor(() =>
    expect(
      screen.queryByLabelText("Saved backup ID") ??
        document.querySelector(".status-mark--err"),
    ).toBeTruthy(),
  );
  await context.annotate(
    JSON.stringify({
      status: [...document.querySelectorAll(".status-mark--err")].map((node) =>
        node.getAttribute("aria-label"),
      ),
      requests: o.service.requests.map((request) => ({
        method: request.method,
        path: request.path,
      })),
    }),
    "diagnostic",
  );
  const reference = await screen.findByLabelText("Saved backup ID");
  const id = reference.getAttribute("value") ?? "";
  expect(id).toBe(`${o.service.origin}/secrets/opensesame-vault-backup`);
  const stored = o.service.versions.get("opensesame-vault-backup")?.at(-1);
  expect(stored).toBeDefined();
  expect(stored?.value).not.toContain(source.value);
  expect(stored?.value).not.toContain(AZURE_FIXTURE_TOKEN);
  expect(new TextEncoder().encode(stored?.value).length).toBeLessThanOrEqual(
    25 * 1024,
  );
  await context.annotate(
    JSON.stringify({
      ciphertextBytes: new TextEncoder().encode(stored?.value).length,
      maxBytes: 25600,
      fixture: "actual-PIN-vault+saved-native-credential+one-secret",
    }),
    "measurement",
  );
  await vaultStore.trashItem(source.id);
  await vaultStore.purgeItem(source.id);
  fireEvent.change(screen.getByLabelText("Backup name or ID"), {
    target: { value: id },
  });
  fireEvent.change(screen.getByLabelText("Backup password or PIN"), {
    target: { value: "83619472" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Restore vault backup" }));
  expect(screen.getByLabelText("Backup password or PIN")).toHaveProperty(
    "value",
    "",
  );
  await screen.findByRole("img", {
    name: "1 items restored from encrypted backup",
  });
  expect(vaultStore.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: source.id, value: source.value }),
    ]),
  );
  expect(readDeviceRows()).toHaveLength(1);
  expect([...o.fixture.disk.files.values()].join()).not.toContain(
    AZURE_FIXTURE_TOKEN,
  );
  expect(
    loadNativeConnectorRecord(row.connectionId)?.privateState.credentials.token,
  ).toBe(AZURE_FIXTURE_TOKEN);
  expect(o.service.requests.some((request) => request.method === "PUT")).toBe(
    true,
  );
});
it.each(["unmount", "vault", "activation"])(
  "%s physically withdraws a pending shared backup write",
  async (kind) => {
    const o = await prepare();
    const ui = mount();
    await configure(o.service.origin);
    const source = createItem("note", "Pending Azure source");
    await vaultStore.saveItem(source);
    const submitted = deferred<ReturnType<typeof o.service.holdNext>>();
    o.fixture.route.respond = (request) => {
      if (request.method === "PUT") submitted.resolve(o.service.holdNext(200));
      return o.transport.fetch(request);
    };
    fireEvent.submit(screen.getByRole("form", { name: "Back up vault" }));
    const held = await submitted.promise;
    await held.arrived;
    if (kind === "unmount") ui.unmount();
    if (kind === "vault") vaultStore.lock();
    if (kind === "activation") o.fixture.activation.dispose();
    await azureSocketClosed(held.closed);
    expect(o.service.requests.some((request) => request.method === "PUT")).toBe(
      true,
    );
    expect(screen.queryByLabelText("Saved backup ID")).toBeNull();
    held.release();
  },
);
