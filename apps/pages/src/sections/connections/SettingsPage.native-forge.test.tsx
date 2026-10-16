/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
it("keeps Cancel sign-in when the saved view re-renders during pending authorization", async () => {
  const fixture = connectorIntegration();
  fixture.route.respond = () => new Promise<Response>(() => {});
  const cancelAuthorization = vi.fn();
  const releasePort = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: () => undefined,
    scrubCallback: () => undefined,
    prepareAuthorization: () => () => undefined,
    authorize: () => new Promise<string>(() => {}),
    cancelAuthorization,
  });
  const provider = catalogProvider("codeberg");
  if (!provider) throw new Error("Codeberg catalog row required");
  const page = (
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
    </MemoryRouter>
  );
  try {
    const view = render(page);
    await userEvent.type(
      screen.getByLabelText("Codeberg public client ID"),
      "codeberg-public-client",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in to Codeberg" }),
    );
    await screen.findByRole("button", { name: "Cancel sign-in" });
    view.rerender(page);
    const cancel = screen.getByRole("button", { name: "Cancel sign-in" });
    await userEvent.click(cancel);
    expect(cancelAuthorization).toHaveBeenCalledOnce();
  } finally {
    releasePort();
  }
});
