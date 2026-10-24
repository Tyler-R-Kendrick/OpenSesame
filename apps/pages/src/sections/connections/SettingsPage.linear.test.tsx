/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { listDeviceConnections } from "@opensesame/app-core/lib/device-connectors.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { linearApiSeams } from "@opensesame/app-core/lib/linear-http.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import { installConnectorIntegration } from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

declareConnectionsTutorial();
installConnectorIntegration();

const originalFetch = linearApiSeams.fetch;
const account = {
  data: {
    viewer: {
      id: "person-1",
      name: "Verified person",
      email: "p@example.test",
    },
    organization: {
      id: "workspace-1",
      name: "Verified workspace",
      urlKey: "w",
    },
    teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }] },
  },
};

beforeEach(() => kvForgetAll());
afterEach(() => {
  cleanup();
  linearApiSeams.fetch = originalFetch;
  kvForgetAll();
});

function linear(): Provider {
  const found = getBundledProviders().find((row) => row.id === "linear");
  if (!found) throw new Error("Linear is not bundled");
  return found;
}

it("adds Linear from Settings through the advanced API-key road", async () => {
  linearApiSeams.fetch = vi.fn(
    async () => new Response(JSON.stringify(account), { status: 200 }),
  );
  const onChanged = vi.fn();
  render(
    <MemoryRouter initialEntries={["/settings/connections/linear"]}>
      <ConnectorSettingsPage
        provider={linear()}
        providerId="linear"
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
        onChanged={onChanged}
      />
    </MemoryRouter>,
  );
  // connect-presets.json gives Linear's MCP road no configurable
  // authentication: the page draws the sign-in, not a choice of bearer,
  // header or anonymous access.
  expect(screen.queryByLabelText("MCP authentication")).toBeNull();
  await userEvent.click(
    screen.getByText("Advanced: existing OAuth app or API key"),
  );
  await userEvent.click(screen.getByRole("radio", { name: "Bring Your Own" }));
  await userEvent.click(screen.getByRole("radio", { name: "API key" }));
  await userEvent.type(
    screen.getByLabelText("Linear API key"),
    "lin_api_test-only",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Linear" }),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(listDeviceConnections()).toEqual([
    expect.objectContaining({ providerId: "linear", status: "active" }),
  ]);
});
