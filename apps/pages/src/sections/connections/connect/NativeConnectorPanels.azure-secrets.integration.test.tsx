/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import {
  azureClosed,
  azureOracle,
  azureToken,
  azureValue,
  azureVault,
} from "@opensesame/app-core/lib/native-azure-secrets.test-support.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
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
const oracles: Awaited<ReturnType<typeof azureOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const oracle of oracles.splice(0).reverse()) await oracle.close();
});
async function oracle() {
  const fixture = connectorIntegration();
  const o = await azureOracle();
  oracles.push(o);
  fixture.route.respond = (request) => o.transport.fetch(request);
  return { ...o, fixture };
}
function mount(providerId = "azure-sm", id?: string) {
  const raw = catalogProvider(providerId);
  if (!raw) throw new Error("Actual Azure catalog provider required");
  const provider = { ...raw, id: providerId };
  const onFlash = vi.fn();
  return {
    ...render(
      <MemoryRouter initialEntries={[`/settings/connections/${providerId}`]}>
        <ConnectorSettingsPage
          provider={provider}
          providerId={providerId}
          connection={id ? deviceConnection(id) : null}
          connections={[]}
          loading={false}
          online
          canConfigure
          configureHint=""
          flash={null}
          rememberOffer={null}
          onFlash={onFlash}
          onRememberOffer={() => {}}
          onChanged={() => {}}
        />
      </MemoryRouter>,
    ),
    onFlash,
  };
}
async function connect(token = azureToken) {
  await userEvent.type(screen.getByLabelText("Vault URL"), azureVault);
  await userEvent.type(screen.getByLabelText("Key Vault access token"), token);
  await userEvent.click(
    screen.getByRole("button", {
      name: "Verify and connect Azure Key Vault Secrets",
    }),
  );
  return screen.findByRole("button", { name: "List secret names" });
}
async function list() {
  await userEvent.click(
    screen.getByText("List secret names", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "List secret names" }),
  );
  const section = await screen.findByRole("region", {
    name: "Showing 1 secret names from first page",
  });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["api-key"]);
  expect(section.textContent).not.toContain("private-metadata");
  expect(section.querySelector("a, img")).toBeNull();
}
it.each(["azure-sm", "azure-key-vault-secrets"])(
  "%s reaches real shared Settings list/get and blank retained-token cold custody",
  async (providerId) => {
    const o = await oracle();
    const ui = mount(providerId);
    expect(screen.getAllByRole("heading", { name: "2 Connect" })).toHaveLength(
      1,
    );
    await connect();
    await list();
    await userEvent.type(
      screen.getByLabelText("Secret name or versioned ID"),
      "api-key",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Read a secret" }),
    );
    const result = await screen.findByRole("region", {
      name: "Secret read once",
    });
    expect(result.textContent).not.toContain(azureValue);
    await userEvent.click(
      within(result).getByRole("button", { name: "Reveal api-key" }),
    );
    expect(result.textContent).toContain(azureValue);
    const row = readDeviceRows()[0];
    if (!row) throw new Error("Missing Azure saved connection");
    expect(readNativeConnector(row.connectionId)?.status).toBe("connected");
    expect(screen.getByLabelText("Key Vault access token")).toHaveProperty(
      "value",
      "",
    );
    expect([...o.fixture.disk.files.values()].join()).not.toContain(azureToken);
    expect([...o.fixture.disk.files.values()].join()).not.toContain(azureValue);
    expect(JSON.stringify(readDeviceRows())).not.toContain(azureToken);
    ui.unmount();
    await o.fixture.reload();
    mount(providerId, row.connectionId);
    expect(screen.getByLabelText("Key Vault access token")).toHaveProperty(
      "value",
      "",
    );
    const before = loadNativeConnectorRecord(row.connectionId)?.revision;
    await userEvent.click(
      screen.getByRole("button", {
        name: "Verify and connect Azure Key Vault Secrets",
      }),
    );
    await waitFor(() =>
      expect(loadNativeConnectorRecord(row.connectionId)?.revision).not.toBe(
        before,
      ),
    );
    await list();
    expect(o.requests).toHaveLength(5);
    expect(o.requests.every((request) => request.authorized)).toBe(true);
    expect(
      o.fixture.requests.every(
        (request) => new URL(request.url).origin === azureVault,
      ),
    ).toBe(true);
  },
);
it("wrong actual authorization cannot save or show a secret action", async () => {
  const o = await oracle();
  const ui = mount();
  await userEvent.type(screen.getByLabelText("Vault URL"), azureVault);
  await userEvent.type(
    screen.getByLabelText("Key Vault access token"),
    "wrong-credential",
  );
  await userEvent.click(
    screen.getByRole("button", {
      name: "Verify and connect Azure Key Vault Secrets",
    }),
  );
  await waitFor(() => expect(ui.onFlash).toHaveBeenCalled());
  expect(readDeviceRows()).toHaveLength(0);
  expect(
    screen.queryByRole("button", { name: "List secret names" }),
  ).toBeNull();
  expect(o.requests[0]?.authorized).toBe(false);
  expect(JSON.stringify(ui.onFlash.mock.calls)).not.toContain(azureToken);
});
it("malformed successful responses cannot display fake inventory", async () => {
  const o = await oracle();
  mount();
  await connect();
  o.reply({ value: [{ id: "https://other.vault.azure.net/secrets/key" }] });
  await userEvent.click(
    screen.getByRole("button", { name: "List secret names" }),
  );
  await screen.findByRole("img", { name: /Azure secret identifier must stay/ });
  expect(
    screen.queryByRole("region", { name: /Showing.*secret names/ }),
  ).toBeNull();
});
it.each(["activation", "vault", "unmount"])(
  "%s withdrawal physically closes a held shared Settings read",
  async (kind) => {
    const o = await oracle();
    const ui = mount();
    await connect();
    const held = o.hold();
    await userEvent.click(
      screen.getByText("List secret names", { selector: "summary" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "List secret names" }),
    );
    await held.arrived.promise;
    if (kind === "activation") o.fixture.activation.dispose();
    if (kind === "vault") vaultStore.lock();
    if (kind === "unmount") ui.unmount();
    await azureClosed(held.closed.promise);
    expect(o.requests).toHaveLength(2);
    expect(
      screen.queryByRole("region", { name: /Showing.*secret names/ }),
    ).toBeNull();
  },
);
it("the original caller can cancel a physical secret stream without borrowing another owner", async () => {
  const o = await oracle();
  mount();
  await connect();
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Missing saved Azure connection");
  const driver = nativeConnectorDriver("api-key", "azure-sm");
  const caller = new AbortController();
  const held = o.hold();
  const pending = driver.invoke(
    row.connectionId,
    "provider.secret.read",
    { name: "api-key" },
    caller.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  await held.arrived.promise;
  caller.abort();
  await rejected;
  await azureClosed(held.closed.promise);
  await expect(
    driver.invoke(row.connectionId, "provider.secrets.read", {}, caller.signal),
  ).rejects.toThrow();
  expect(o.requests).toHaveLength(2);
  await list();
  expect(o.requests).toHaveLength(3);
});

it("refuses pending and subsequent reads after the captured native authority is replaced", async () => {
  const o = await oracle();
  mount();
  await connect();
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Missing saved Azure connection");
  const driver = nativeConnectorDriver("api-key", "azure-sm");
  const held = o.hold();
  const pending = driver.invoke(row.connectionId, "provider.secret.read", {
    name: "api-key",
  });
  const rejected = expect(pending).rejects.toThrow();
  await held.arrived.promise;
  const replacementFetch = vi.fn<typeof fetch>();
  const unbind = bindNativeProviderTransport({
    fetch: replacementFetch,
    assertCurrent: () => {},
  });
  try {
    held.release.resolve();
    await rejected;
    await expect(
      driver.invoke(row.connectionId, "provider.secrets.read", {}),
    ).rejects.toThrow();
    expect(replacementFetch).not.toHaveBeenCalled();
    expect(o.requests).toHaveLength(2);
    expect(
      screen.queryByRole("region", { name: "Secret read once" }),
    ).toBeNull();
    expect([...o.fixture.disk.files.values()].join()).not.toContain(azureValue);
  } finally {
    unbind();
  }
});
