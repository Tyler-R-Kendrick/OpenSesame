/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

declareConnectionsTutorial();
installConnectorIntegration();
it("offers Codeberg's actual provider auth without legacy backup controls requiring other credentials", () => {
  connectorIntegration();
  const provider = catalogProvider("codeberg");
  if (!provider) throw new Error("Codeberg catalog row required");
  render(
    <MemoryRouter>
      <ConnectorSettingsPage
        provider={provider}
        providerId="codeberg"
        connection={null}
        connections={[]}
        loading={false}
        online={true}
        canConfigure={true}
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole("region", { name: "Connector" })).toBeTruthy();
  expect(screen.queryByTestId("forge-backup-sync")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Sign in to Codeberg" }),
  ).toBeTruthy();
});
