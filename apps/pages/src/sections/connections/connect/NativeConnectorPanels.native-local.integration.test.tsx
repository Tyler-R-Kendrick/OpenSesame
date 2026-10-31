import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
/** @vitest-environment jsdom */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnectorView } from "@opensesame/app-core/lib/device-connector-view.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { bindNativeCatalogConfigurationRuntime } from "../../../modules/connectors.external/native-catalog-configuration-runtime.js";
import { nativeConnectorHeaderStatus } from "../SettingsPageNativeStatus.js";
import {
  NativeConnectorPanels,
  nativeSettingsDescriptor,
} from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";

installConnectorIntegration();

it("saves E2B configuration locally without claiming a provider access check", async () => {
  const fixture = connectorIntegration();
  bindNativeCatalogConfigurationRuntime(fixture.activation);
  const onFlash = vi.fn();
  const provider = catalogProvider("e2b");
  if (!provider) throw new Error("Missing E2B catalog row");
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={provider}
        connection={null}
        onFlash={onFlash}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect E2B" }),
  );
  await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith({
      tone: "ok",
      text: "E2B configuration validated locally and saved on this device. Provider access was not checked.",
    }),
  );
  expect(screen.queryByText("Verified access")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Verify E2B configuration" }),
  ).toBeTruthy();
  expect(fixture.requests).toHaveLength(0);

  const row = readDeviceRows()[0];
  if (!row) throw new Error("Missing saved E2B configuration");
  const saved = readNativeConnector(row.connectionId);
  if (!saved) throw new Error("Missing native E2B record");
  await updateNativeConnector(
    row.connectionId,
    saved,
    { publicParameters: [], privateCredentials: [] },
    (record) => {
      record.privateState.verification = null;
      return record;
    },
  );
  const pending = readDeviceRows()[0];
  if (!pending) throw new Error("Missing pending E2B configuration");
  expect(
    nativeConnectorHeaderStatus(deviceConnectorView(pending), provider),
  ).toEqual({
    tone: "warn",
    label: "Configuration validation pending",
    sentence:
      "Validate this configuration locally; provider access is not checked.",
  });
});

it("requires an unlocked genuine vault for local catalog configuration", async () => {
  const fixture = connectorIntegration();
  bindNativeCatalogConfigurationRuntime(fixture.activation);
  const provider = catalogProvider("e2b");
  if (!provider) throw new Error("Missing E2B catalog row");
  const method = () =>
    nativeSettingsDescriptor(provider)?.methods.find(
      (entry) => entry.id === "native-local",
    );
  expect(method()?.available).toBe(true);
  vaultStore.lock();
  expect(method()?.available).toBe(false);
  expect(method()?.fields).toEqual([]);
  await vaultStore.createGuest();
  expect(vaultStore.isGenuineSession()).toBe(false);
  expect(method()?.available).toBe(false);
  expect(method()?.fields).toEqual([]);
});
