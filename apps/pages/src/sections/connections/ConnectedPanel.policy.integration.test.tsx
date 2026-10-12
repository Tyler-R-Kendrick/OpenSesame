/** @vitest-environment jsdom */
import {
  deviceConnection,
  listDeviceConnections,
} from "@opensesame/app-core/lib/device-connectors.js";
import { nativeApiTarget } from "@opensesame/app-core/lib/native-api-target.js";
import { nativeBrowserApiPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import {
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { ConnectedPanel } from "./ConnectedPanel.js";
import { NeedsAttention } from "./NeedsAttention.js";
import { nativeConnectorHeaderStatus } from "./SettingsPageNativeStatus.js";
import { NativeConnectorPanels } from "./connect/NativeConnectorPanels.js";
import { savePriorApiProof } from "./connect/native-browser-policy.test-support.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./connect/native-connector-integration.test-support.js";
import { connectedPageItems } from "./page-tree.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";
installConnectorIntegration();
declareConnectionsTutorial();

it.each(["datadog", "railway"])(
  "projects a previously verified %s record as unavailable without altering its sealed authority",
  async (providerId) => {
    const fixture = connectorIntegration();
    const saved = await savePriorApiProof(providerId);
    const before = loadNativeConnectorRecord(saved.connectionId);
    const reason = nativeBrowserApiPolicy(
      providerId,
      saved.configuration.parameters,
    ).reason;
    if (!reason) throw new Error("Expected audited browser refusal");
    const connection = deviceConnection(saved.connectionId);
    expect(connection?.status).toBe("pending");
    expect(connection?.statusDetail).toBe(reason);
    expect(connection?.refreshable).toBe(false);
    const provider = integrationProvider(providerId);
    expect(nativeConnectorHeaderStatus(connection, provider)).toEqual({
      tone: "warn",
      label: "Browser route unavailable",
      sentence: reason,
    });
    const connections = listDeviceConnections();
    render(
      <MemoryRouter>
        <NeedsAttention
          connections={connections}
          providers={[]}
          onFlash={() => {}}
          onChanged={() => {}}
        />
        <ConnectedPanel
          connections={connections}
          providers={[]}
          loading={false}
          setupRequired={false}
        />
        <NativeConnectorPanels
          provider={provider}
          connection={connection}
          onFlash={() => {}}
          onChanged={() => {}}
        />
      </MemoryRouter>,
    );
    const connected = screen
      .getByRole("heading", { name: "Connected" })
      .closest("section");
    if (!connected) throw new Error("Missing Connected section");
    expect(
      within(connected).queryByText(saved.configuration.displayName),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Needs attention" }).textContent,
    ).toContain(reason);
    expect(connectedPageItems([], connections)).toEqual([]);
    expect(screen.getByRole("img", { name: reason })).toBeTruthy();
    expect(screen.getByText("Verification pending")).toBeTruthy();
    expect(screen.queryByText("Verified")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Remove connector",
      }),
    ).toHaveProperty("disabled", false);
    expect(fixture.requests).toHaveLength(0);
    expect(loadNativeConnectorRecord(saved.connectionId)).toEqual(before);
    await fixture.reload();
    expect(deviceConnection(saved.connectionId)?.statusDetail).toBe(reason);
    expect(loadNativeConnectorRecord(saved.connectionId)?.privateState).toEqual(
      before?.privateState,
    );
    expect([...fixture.disk.files.values()].join()).not.toContain(
      "private-prior-api_key",
    );
  },
);

it("keeps provider cleanup and reported expiry visible after the browser route becomes blocked", async () => {
  connectorIntegration();
  const saved = await savePriorApiProof("railway");
  const expiredAt = Date.now() - 1000;
  const target = nativeApiTarget("railway", saved.configuration.parameters);
  await updateNativeConnector(
    saved.connectionId,
    { revision: saved.revision, fingerprint: saved.fingerprint },
    target.classification,
    (record) => {
      const grant = record.privateState.grants.app;
      const metadata = record.runtime.grants[0];
      if (!grant || !metadata) throw new Error("Missing prior grant");
      grant.expiresAt = expiredAt;
      metadata.expiresAt = expiredAt;
      record.privateState.recovery.push({
        id: "prior-registration",
        providerId: "railway",
        actor: "app",
        fingerprint: saved.fingerprint,
        kind: "registration",
        targetId: "prior-target",
      });
      return record;
    },
  );
  const connection = deviceConnection(saved.connectionId);
  expect(connection?.status).toBe("pending");
  expect(connection?.statusDetail).toBe(
    "Provider cleanup required before this connection can be used",
  );
  expect(connection?.expiresAt).toBe(new Date(expiredAt).toISOString());
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.grants.app
      ?.expiresAt,
  ).toBe(expiredAt);
  expect(
    nativeConnectorHeaderStatus(connection, integrationProvider("railway"))
      ?.sentence,
  ).toBe(connection?.statusDetail);
});
