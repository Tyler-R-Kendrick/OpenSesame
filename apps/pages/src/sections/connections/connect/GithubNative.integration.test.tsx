/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { catalogConnectorAction } from "../catalog-connector-action.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import { nativeSettingsDescriptor } from "./NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";
import { nativeGithubDescriptor } from "./native-github-descriptor.js";

declareConnectionsTutorial();
installConnectorIntegration();
function githubProvider() {
  const provider = catalogProvider("github");
  if (!provider) throw new Error("GitHub catalog row required");
  return provider;
}
const account = { id: 123, login: "real-account", type: "User" };

it("admits Github's actual browser token driver without offering confidential App provisioning", () => {
  connectorIntegration();
  const provider = githubProvider();
  expect(nativeGithubDescriptor(provider, false)).toBeNull();
  const descriptor = nativeSettingsDescriptor(provider);
  expect(descriptor?.methods.map((method) => method.id)).toEqual(["api-key"]);
  expect(descriptor?.methods[0]?.fields.map((field) => field.id)).toEqual([
    "api_key",
  ]);
  expect(catalogConnectorAction(provider, null)).toMatchObject({
    kind: "connect",
    glyph: "plus",
    method: "api-key",
  });
});

it("opens Github's specific browser form, rejects a bad token, then verifies and reads permitted repositories", async () => {
  const fixture = connectorIntegration();
  const onFlash = vi.fn();
  render(
    <MemoryRouter>
      <ConnectorSettingsPage
        provider={githubProvider()}
        providerId="github"
        connection={null}
        connections={[]}
        loading={false}
        online={true}
        canConfigure={true}
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={onFlash}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByTestId("github-app-presence")).toBeNull();
  expect(screen.queryByLabelText("Connector name")).toBeNull();
  expect(screen.queryByLabelText("Icon")).toBeNull();
  const token = screen.getByLabelText("GitHub personal access token");
  await userEvent.type(token, "private-browser-token");
  fixture.replies.push({ status: 401, body: { message: "Bad credentials" } });
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect GitHub" }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "err" }),
    ),
  );
  expect(readDeviceRows()).toEqual([]);
  expect(token).toHaveProperty("value", "private-browser-token");
  fixture.replies.push({ body: account });
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect GitHub" }),
  );
  await waitFor(() => expect(readDeviceRows()).toHaveLength(1));
  const saved = readDeviceRows()[0];
  if (!saved) throw new Error("Verified GitHub row required");
  expect(readNativeConnector(saved.connectionId)).toMatchObject({
    status: "connected",
    identity: { id: "123", label: "real-account" },
  });
  expect(fixture.requests.map((request) => request.url)).toEqual([
    "https://api.github.com/user",
    "https://api.github.com/user",
  ]);
  expect(fixture.requests[1]?.headers.get("Authorization")).toBe(
    "Bearer private-browser-token",
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("GitHub personal access token"),
    ).toHaveProperty("value", ""),
  );
  fixture.replies.push(
    { body: account },
    {
      body: [
        {
          id: 234,
          full_name: "real-account/repository",
          html_url: "https://github.com/real-account/repository",
        },
      ],
    },
  );
  await userEvent.click(
    screen.getByText("Read repositories", { selector: "summary" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Read repositories" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("link", { name: /real-account\/repository/ })
        .getAttribute("href"),
    ).toBe("https://github.com/real-account/repository"),
  );
  expect(fixture.requests[3]?.url).toBe(
    "https://api.github.com/user/repos?per_page=100&sort=updated",
  );
  expect([...fixture.disk.files.values()].join()).not.toContain(
    "private-browser-token",
  );
  await fixture.reload();
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
});
