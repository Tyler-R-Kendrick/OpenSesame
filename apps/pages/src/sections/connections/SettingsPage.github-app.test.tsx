import {
  type Connection,
  connectionSeams,
} from "@opensesame/app-core/lib/connections.js";
/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { rememberLocalGithubApp } from "@opensesame/app-core/lib/github-app-local.js";
import {
  forgetLocalGithubApp,
  readLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import { stashPendingGithubAppSecret } from "@opensesame/app-core/lib/github-app-secret.js";
import { configureNativeGithubPersonal } from "@opensesame/app-core/lib/native-github-personal.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "./SettingsPage.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";
import { githubAppReturnSeams } from "./useGithubAppReturn.js";

declareConnectionsTutorial();
installConnectorIntegration();
const app = {
  id: "42",
  key: "github-oauth",
  displayName: "Browser app",
  htmlUrl: "https://github.com/apps/browser-app?unexpected=value#fragment",
  ownerLogin: "operator",
  ownerType: "User",
  installedByLogin: null,
  installations: [],
};
beforeEach(() => {
  forgetLocalGithubApp();
  window.history.replaceState(
    {},
    "",
    "/OpenSesame/settings/integrations/github",
  );
});
afterEach(() => {
  cleanup();
  forgetLocalGithubApp();
  window.history.replaceState({}, "", "/");
});

type DrawOptions = { online?: boolean; connection?: Connection | null };
function draw(options: DrawOptions = {}) {
  const provider = catalogProvider("github");
  if (!provider) throw new Error("GitHub catalog row required");
  const flash = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={[window.location.pathname]}>
      <ConnectorSettingsPage
        provider={{ ...provider, configured: true }}
        providerId="github"
        connection={options.connection ?? null}
        connections={options.connection ? [options.connection] : []}
        loading={false}
        online={options.online ?? true}
        canConfigure={true}
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={flash}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  return { ...view, flash };
}

it("offers App first in the actual native settings page and preserves the token draft", async () => {
  const fixture = connectorIntegration();
  draw();
  expect(screen.getAllByRole("heading", { name: /Connect$/u })).toHaveLength(1);
  expect(screen.getByText("App or token · Backup/recovery")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe(
    "https://docs.github.com/en/apps",
  );
  expect(screen.getByRole("radio", { name: "GitHub App" })).toHaveProperty(
    "checked",
    true,
  );
  expect(
    screen.getByRole("radio", { name: "Personal access token" }),
  ).toHaveProperty("checked", false);
  expect(
    screen.getByRole("button", { name: "Create GitHub App" }),
  ).toBeTruthy();
  expect(
    screen
      .getByLabelText("GitHub personal access token", {
        selector: 'input[type="password"]',
      })
      .closest("[hidden]"),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("radio", { name: "Personal access token" }),
  );
  const token = screen.getByLabelText("GitHub personal access token", {
    selector: 'input[type="password"]',
  });
  await userEvent.type(token, "draft-token");
  await userEvent.click(screen.getByRole("radio", { name: "GitHub App" }));
  await userEvent.click(
    screen.getByRole("radio", { name: "Personal access token" }),
  );
  expect(token).toHaveProperty("value", "draft-token");
  expect(fixture.requests).toHaveLength(0);
  expect(screen.queryByTestId("github-app-presence")).toBeNull();
});

it("starts the real manifest registration with this static deployment callback", async () => {
  connectorIntegration();
  const start = vi.spyOn(connectionSeams, "startGithubAppRegistration");
  const submit = vi
    .spyOn(connectionSeams, "submitGithubAppManifest")
    .mockImplementation(() => undefined);
  const { unmount } = draw();
  await userEvent.click(
    screen.getByRole("button", { name: "Create GitHub App" }),
  );
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(start).toHaveBeenCalledWith({
    returnTo: `${window.location.origin}/OpenSesame/settings/integrations/github`,
    displayName: "OpenSesame GitHub",
  });
  const registration = submit.mock.calls[0]?.[0];
  expect(registration?.action).toBe("https://github.com/settings/apps/new");
  expect(registration?.redirectUrl).toBe(
    `${window.location.origin}/OpenSesame/settings/integrations/github?github_app=claim`,
  );
  expect(registration?.manifest.redirect_url).toBe(registration?.redirectUrl);
  expect(registration?.manifest.callback_urls).toEqual([
    registration?.redirectUrl,
  ]);
  expect(registration?.state).toMatch(/^[a-f\d]{32}$/u);
  unmount();
});

it("disables registration when offline", () => {
  connectorIntegration();
  draw({ online: false });
  expect(
    screen.getByRole("button", { name: "Create GitHub App" }),
  ).toHaveProperty("disabled", true);
});

it.each(["registered", "installed"])(
  "never accepts a forged %s marker as connected App access",
  async (marker) => {
    const fixture = connectorIntegration();
    rememberLocalGithubApp(app);
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}?github_app=${marker}`,
    );
    const { flash, container } = draw();
    await waitFor(() =>
      expect(flash).toHaveBeenCalledWith({
        tone: "err",
        text: expect.stringContaining("could not be verified"),
      }),
    );
    expect(flash).not.toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok" }),
    );
    expect(
      container.querySelector(".conn-settings__head [aria-label='Connected']"),
    ).toBeNull();
    expect(fixture.requests).toHaveLength(0);
  },
);

it("keeps the verified callback mounted when saved App hides create and the token body is selected", async () => {
  connectorIntegration();
  vi.spyOn(githubAppReturnSeams, "captureGithubAuthority").mockImplementation(
    () => {
      const controller = new AbortController();
      return {
        tomb: null,
        transport: {
          signal: controller.signal,
          assertCurrent: () => controller.signal.throwIfAborted(),
          fetch: globalThis.fetch,
        },
        close: () => controller.abort(),
      };
    },
  );
  rememberLocalGithubApp(app);
  let finish: (result: "registered") => void = () => {};
  const pending = new Promise<"registered">((resolve) => {
    finish = resolve;
  });
  const claim = vi
    .spyOn(githubAppReturnSeams, "claimGithubAppCode")
    .mockReturnValue(pending);
  vi.spyOn(
    githubAppReturnSeams,
    "refreshGithubAppInstallations",
  ).mockResolvedValue(app);
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}?github_app=claim&code=one-use&state=bound-state`,
  );
  const { flash } = draw();
  await waitFor(() =>
    expect(claim).toHaveBeenCalledWith("one-use", "bound-state"),
  );
  await userEvent.click(
    screen.getByRole("radio", { name: "Personal access token" }),
  );
  finish("registered");
  await waitFor(() =>
    expect(flash).toHaveBeenCalledWith({
      tone: "ok",
      text: "GitHub App registered.",
    }),
  );
  expect(window.location.search).toBe("");
});

it("shows saved metadata without inventing access and recovers creation through the shared remove control", async () => {
  connectorIntegration();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  rememberLocalGithubApp(app);
  stashPendingGithubAppSecret(app, "memory-only-pem", null);
  const { container } = draw();
  expect(screen.getAllByTestId("github-app-name")).toHaveLength(1);
  expect(screen.getByTestId("github-app-name").textContent).toContain(
    "Browser app",
  );
  expect(screen.getAllByTestId("github-app-owner")).toHaveLength(1);
  expect(screen.getByTestId("github-app-owner").textContent).toContain(
    "operator",
  );
  expect(
    screen.getAllByRole("button", {
      name: "Remove GitHub App from this device",
    }),
  ).toHaveLength(1);
  expect(
    screen.getByLabelText("GitHub App key pending vault storage."),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Install GitHub App" })
      .getAttribute("href"),
  ).toBe("https://github.com/apps/browser-app/installations/new");
  expect(
    container.querySelector(
      ".conn-settings__head [aria-label='Not connected']",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Create GitHub App" }),
  ).toBeNull();
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  await userEvent.click(
    screen.getByRole("button", { name: "Remove GitHub App from this device" }),
  );
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(readLocalGithubApp()).toBeNull();
  expect(
    screen.getByRole("button", { name: "Create GitHub App" }),
  ).toBeTruthy();
});

it.each([
  "https://github.com.evil.test/apps/unsafe",
  "https://operator:secret@github.com/apps/unsafe",
  "https://github.com/apps/safe/extra",
  "https://github.com/apps/%2e%2e",
])("does not offer an unsafe installation destination from %s", (htmlUrl) => {
  connectorIntegration();
  rememberLocalGithubApp({ ...app, htmlUrl });
  draw();
  expect(screen.queryByRole("link", { name: "Install GitHub App" })).toBeNull();
});

it("starts with the existing active native personal token rather than App registration", async () => {
  const fixture = connectorIntegration();
  fixture.replies.push({ body: { id: 123, login: "operator", type: "User" } });
  const saved = await configureNativeGithubPersonal({
    providerId: "github",
    displayName: "GitHub",
    parameters: {},
    credentials: { api_key: "private-test-token" },
  });
  draw({ connection: deviceConnection(saved.connectionId) });
  expect(
    screen.getByRole("radio", { name: "Personal access token" }),
  ).toHaveProperty("checked", true);
  expect(
    screen.queryByRole("button", { name: "Create GitHub App" }),
  ).toBeNull();
  expect(
    screen.getByLabelText("GitHub personal access token", {
      selector: 'input[type="password"]',
    }),
  ).toBeTruthy();
});

it("selects a saved native personal token when the connection arrives after loading", async () => {
  const fixture = connectorIntegration();
  fixture.replies.push({ body: { id: 123, login: "operator", type: "User" } });
  const saved = await configureNativeGithubPersonal({
    providerId: "github",
    displayName: "GitHub",
    parameters: {},
    credentials: { api_key: "private-test-token" },
  });
  const connection = deviceConnection(saved.connectionId);
  if (!connection) throw new Error("Saved GitHub connection required");
  const provider = catalogProvider("github");
  if (!provider) throw new Error("GitHub catalog row required");
  const view = draw();
  expect(screen.getByRole("radio", { name: "GitHub App" })).toHaveProperty(
    "checked",
    true,
  );
  view.rerender(
    <MemoryRouter initialEntries={[window.location.pathname]}>
      <ConnectorSettingsPage
        provider={{ ...provider, configured: true }}
        providerId="github"
        connection={connection}
        connections={[connection]}
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
  await waitFor(() =>
    expect(
      screen.getByRole("radio", { name: "Personal access token" }),
    ).toHaveProperty("checked", true),
  );
  expect(screen.getByRole("radio", { name: "GitHub App" })).toHaveProperty(
    "checked",
    false,
  );
});

it("shows the App return alongside an existing active token without trusting a forged marker", async () => {
  const fixture = connectorIntegration();
  fixture.replies.push({ body: { id: 123, login: "operator", type: "User" } });
  const saved = await configureNativeGithubPersonal({
    providerId: "github",
    displayName: "GitHub",
    parameters: {},
    credentials: { api_key: "private-test-token" },
  });
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}?github_app=installed`,
  );
  const { flash } = draw({ connection: deviceConnection(saved.connectionId) });
  expect(screen.getByRole("radio", { name: "GitHub App" })).toHaveProperty(
    "checked",
    true,
  );
  expect(
    screen.getByRole("button", { name: "Create GitHub App" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(flash).toHaveBeenCalledWith({
      tone: "err",
      text: expect.stringContaining("could not be verified"),
    }),
  );
  expect(flash).not.toHaveBeenCalledWith(
    expect.objectContaining({ tone: "ok" }),
  );
  expect(fixture.requests).toHaveLength(1);
});
