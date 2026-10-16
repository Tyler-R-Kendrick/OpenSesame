import { connectRoadSeams } from "@opensesame/app-core/lib/connect-roads.js";
/** @vitest-environment jsdom */
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderTiles } from "../settings/ProviderTiles.js";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { useAiSheet } from "./ai/use-ai-sheet.js";
import { installConnectorIntegration } from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

installConnectorIntegration();
declareConnectionsTutorial();
afterEach(cleanup);
const providers = getBundledProviders();
function RoutedSettings() {
  const { providerId, connectionId } = useParams();
  const { pathname } = useLocation();
  const model = useAiSheet({
    providerId,
    connectionId,
    pathname,
    providers,
    connections: [],
    reload: async () => {},
    onFlash: vi.fn(),
  });
  return (
    <ConnectorSettingsPage
      provider={model.provider}
      providerId={providerId ?? ""}
      connection={null}
      connections={[]}
      loading={false}
      online
      canConfigure
      configureHint=""
      flash={null}
      rememberOffer={null}
      onFlash={vi.fn()}
      onRememberOffer={vi.fn()}
      onChanged={vi.fn()}
    />
  );
}

it.each(["bitwarden-sm", "bitwarden-secrets-manager"])(
  "opens real shared backend settings at /settings/connections/%s",
  async (id) => {
    expect(
      providers.filter((provider) =>
        ["bitwarden-sm", "bitwarden-secrets-manager"].includes(provider.id),
      ),
    ).toHaveLength(1);
    render(
      <MemoryRouter initialEntries={[`/settings/connections/${id}`]}>
        <Routes>
          <Route
            path="/settings/connections/:providerId"
            element={<RoutedSettings />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Bitwarden Secrets Manager" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Connector not found" }),
    ).toBeNull();
    expect(screen.getByLabelText("Connection method")).toHaveProperty(
      "value",
      "bitwarden-secrets",
    );
    expect(screen.getByLabelText("Access token")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save secret backend" }),
    ).toBeTruthy();
  },
);

it("opens the bundled alias from the real catalog link", async () => {
  const user = userEvent.setup();
  const alias = providers.find(
    (provider) => provider.id === "bitwarden-secrets-manager",
  );
  if (!alias) throw new Error("Bundled BWS alias is missing");
  vi.spyOn(connectRoadSeams, "pagesOpen").mockReturnValue(true);
  render(
    <MemoryRouter initialEntries={["/settings/integrations"]}>
      <Routes>
        <Route
          path="/settings/integrations"
          element={
            <ProviderTiles
              category="cloud_secret_storage"
              label="Cloud secret storage"
            />
          }
        />
        <Route
          path="/settings/connections/:providerId"
          element={<RoutedSettings />}
        />
      </Routes>
    </MemoryRouter>,
  );
  const link = screen.getByRole("link", {
    name: "Bitwarden Secrets Manager",
  });
  expect(link.getAttribute("href")).toBe(
    "/settings/connections/bitwarden-secrets-manager",
  );
  await user.click(link);
  expect(await screen.findByLabelText("Access token")).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Bitwarden Secrets Manager" }),
  ).toBeTruthy();
});
