/** @vitest-environment jsdom */
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { configureNativeLocalInstance } from "@opensesame/app-core/lib/native-local-instance.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, it } from "vitest";
import { ContextMenuLayer } from "../../components/context-menu/ContextMenuLayer.js";
import { closeContextMenu } from "../../components/context-menu/menu-model.js";
import { ConnectedPanel } from "./ConnectedPanel.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

declareConnectionsTutorial();
installConnectorIntegration();

it("offers the verified built-in instance menu even when its provider is absent from the curated catalog", async () => {
  const fixture = connectorIntegration();
  fixture.replies.push({
    body: {
      data: {
        entity_id: "entity-real",
        display_name: "Browser account",
        policies: ["default"],
        ttl: 3600,
        renewable: false,
      },
    },
  });
  const saved = await configureNativeLocalInstance({
    providerId: "vault",
    displayName: "HashiCorp Vault",
    icon: "",
    endpoint: "https://vault.example.test",
    namespace: "",
    apiKey: "token-real",
  });
  const verified = deviceConnection(saved.connectionId);
  if (!verified) throw new Error("Verified Vault instance required");
  const legacy = {
    ...verified,
    connectionId: "legacy-saved-only",
    displayName: "Saved Vault configuration",
  };
  render(
    <MemoryRouter initialEntries={["/connections"]}>
      <Routes>
        <Route
          path="/connections"
          element={
            <ConnectedPanel
              providers={[]}
              connections={[legacy, verified]}
              loading={false}
              setupRequired={false}
            />
          }
        />
        <Route
          path="/connections/vault/:connectionId"
          element={<h1>Verify or remove this Vault connection</h1>}
        />
      </Routes>
      <ContextMenuLayer />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole("link", {
      name: "Settings for Saved Vault configuration",
    }),
  ).toBeTruthy();
  const actions = screen.getByRole("button", {
    name: "Actions for HashiCorp Vault",
  });
  expect(actions.tabIndex).toBe(0);
  expect(screen.getAllByRole("button", { name: /^Actions for/ })).toHaveLength(
    1,
  );
  await userEvent.click(actions);
  expect(
    screen.getByRole("menuitem", { name: "Configure connection" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("menuitem", { name: "Remove connection…" }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("menuitem", { name: "Check access" }));
  expect(
    await screen.findByRole("heading", {
      name: "Verify or remove this Vault connection",
    }),
  ).toBeTruthy();
  expect(fixture.requests).toHaveLength(1);
  closeContextMenu();
});
