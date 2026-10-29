/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { listDeviceConnections } from "@opensesame/app-core/lib/device-connectors.js";
import { saveModelFixture } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { catalogTileNote } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { ConnectedPanel } from "./ConnectedPanel.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

installConnectorIntegration();
declareConnectionsTutorial();

it("labels a verified Google Wallet key as connected, not unchecked local configuration", async () => {
  const fixture = connectorIntegration();
  const id = await saveModelFixture("google-wallet");
  const connection = listDeviceConnections().find(
    (candidate) => candidate.connectionId === id,
  );
  if (!connection) throw new Error("Missing Google Wallet connection");
  expect(connection.status).toBe("active");
  const provider = catalogProvider("google-wallet");
  if (!provider) throw new Error("Missing Google Wallet provider");
  expect(catalogTileNote(provider, connection)).toEqual({
    label: "Connected",
    tone: "chip--ok",
  });
  render(
    <MemoryRouter>
      <ConnectedPanel
        connections={[connection]}
        providers={[provider]}
        loading={false}
        setupRequired={false}
      />
    </MemoryRouter>,
  );
  const section = screen
    .getByRole("heading", { name: "Connected" })
    .closest("section");
  if (!section) throw new Error("Missing Connected section");
  const panel = within(section);
  expect(panel.getByRole("img", { name: "Connected" })).toBeTruthy();
  expect(panel.getByText("Connection verified on this device.")).toBeTruthy();
  expect(panel.queryByRole("img", { name: "Configured" })).toBeNull();
  expect(panel.queryByText(/provider access was not checked/)).toBeNull();
  expect(fixture.requests).toHaveLength(0);
});
