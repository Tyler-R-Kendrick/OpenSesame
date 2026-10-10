/** @vitest-environment jsdom */
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import { ContextMenuLayer } from "../../components/context-menu/ContextMenuLayer.js";
import { closeContextMenu } from "../../components/context-menu/menu-model.js";
import { CatalogPanel } from "./CatalogPanel.js";
import { NativeConnectorPanels } from "./connect/NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

declareConnectionsTutorial();
installConnectorIntegration();

function Destination() {
  const location = useLocation();
  return (
    <output aria-label="Current destination">
      {location.pathname}
      {location.hash}
    </output>
  );
}

it("offers a browser Connect action and a static desktop capability without a false setup route", () => {
  connectorIntegration();
  const { container } = render(
    <MemoryRouter>
      <CatalogPanel
        providers={[
          integrationProvider("algolia"),
          integrationProvider("datadog"),
        ]}
      />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole("link", { name: "Connect Algolia" }).getAttribute("href"),
  ).toBe("/connections/algolia");
  const desktop = container.querySelector("#catalog-datadog");
  expect(desktop?.querySelector("a, button")).toBeNull();
  expect(
    screen.getByRole("img", { name: "Desktop app required" }),
  ).toBeTruthy();
});

it("offers installed actions only after actual provider verification and opens the configuration route", async () => {
  const fixture = connectorIntegration();
  fixture.replies.push({ body: { indexes: [{ name: "Products" }] } });
  const saved = await configureNativeApiConnector({
    providerId: "algolia",
    displayName: "Search account",
    parameters: { application_id: "app-real" },
    credentials: { api_key: "key-real" },
  });
  const connection = deviceConnection(saved.connectionId);
  if (!connection) throw new Error("Verified connection was not stored");
  render(
    <MemoryRouter initialEntries={["/connections/add"]}>
      <Routes>
        <Route
          path="/connections/add"
          element={
            <CatalogPanel
              providers={[integrationProvider("algolia")]}
              connections={[connection]}
            />
          }
        />
        <Route
          path="/connections/algolia/:connectionId"
          element={
            <NativeConnectorPanels
              provider={integrationProvider("algolia")}
              connection={connection}
              onFlash={vi.fn()}
              onChanged={vi.fn()}
            />
          }
        />
      </Routes>
      <ContextMenuLayer />
      <Destination />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("link", { name: "Connect Algolia" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Actions for Algolia" }),
  );
  expect(screen.getByRole("menu", { name: "Algolia connection" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Check access" })).toBeTruthy();
  expect(
    screen.getByRole("menuitem", { name: "Remove connection…" }),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Configure connection" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Current destination").textContent).toBe(
      `/connections/algolia/${connection.connectionId}#connector`,
    ),
  );
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Connector" }),
  );
  expect(fixture.requests).toHaveLength(1);
  closeContextMenu();
});
