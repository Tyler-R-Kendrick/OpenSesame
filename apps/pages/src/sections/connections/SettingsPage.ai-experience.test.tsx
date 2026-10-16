/** @vitest-environment jsdom */
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { installConnectorIntegration } from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

installConnectorIntegration();
declareConnectionsTutorial();
afterEach(cleanup);

it.each([true, false])(
  "offers only the common BYO AI form when generic configuration permission is %s",
  (canConfigure) => {
    const provider = getBundledProviders().find((row) => row.id === "byo-ai");
    if (!provider) throw new Error("Missing BYO AI provider");
    const { container } = render(
      <MemoryRouter initialEntries={["/settings/connections/byo-ai"]}>
        <ConnectorSettingsPage
          provider={provider}
          providerId={provider.id}
          connection={null}
          connections={[]}
          loading={false}
          online
          canConfigure={canConfigure}
          configureHint="Generic configuration is unavailable"
          flash={null}
          rememberOffer={null}
          onFlash={vi.fn()}
          onRememberOffer={vi.fn()}
          onChanged={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("form")).toHaveLength(1);
    expect(
      screen.getByRole("form", { name: "AI connection configuration" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("API family")).toBeTruthy();
    expect(screen.getByLabelText("API base URL")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save AI connection" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save configuration" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Connect" })).toBeNull();
    expect(screen.queryByText("Not configured.")).toBeNull();
    expect(container.querySelector("#authorization")).toBeNull();
  },
);
