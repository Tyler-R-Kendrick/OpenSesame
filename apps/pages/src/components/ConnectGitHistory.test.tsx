import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const planes = vi.hoisted(() => ({
  value: { host: "live", identity: "connected" },
}));
const ensureHostSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const loadSettings = vi.hoisted(() => vi.fn());
const saveSettings = vi.hoisted(() => vi.fn());
const listConnections = vi.hoisted(() => vi.fn());
const listProviders = vi.hoisted(() => vi.fn());
const listIntegrations = vi.hoisted(() => vi.fn());
const createConnection = vi.hoisted(() => vi.fn());
const authorizeConnection = vi.hoisted(() => vi.fn());
const awaitConsent = vi.hoisted(() => vi.fn());
const setConnectionCredential = vi.hoisted(() => vi.fn());
const openConsentPopup = vi.hoisted(() => vi.fn(() => null));
const startGithubAppRegistration = vi.hoisted(() => vi.fn());
const submitGithubAppManifest = vi.hoisted(() => vi.fn());

import { planeSeams } from "../lib/planes.js";
const originalPlaneSeams = { ...planeSeams };
Object.assign(planeSeams, { usePlaneStatus: () => planes.value });

import { identitySeams } from "../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, { ensureHostSession });

import { settingsSeams } from "../lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, { loadSettings, saveSettings });

import { connectionSeams } from "../lib/connections.js";
const originalConnectionSeams = { ...connectionSeams };
Object.assign(connectionSeams, {
  listConnections,
  listProviders,
  listIntegrations,
  createConnection,
  authorizeConnection,
  awaitConsent,
  setConnectionCredential,
  openConsentPopup,
  startGithubAppRegistration,
  submitGithubAppManifest,
});

import {
  ConnectGitHistory,
  connectGitHistorySeams,
} from "./ConnectGitHistory.js";
const originalGitHistorySeams = { ...connectGitHistorySeams };
Object.assign(connectGitHistorySeams, {
  GithubHistoryRemotePicker: ({
    onSelectRemote,
  }: {
    onSelectRemote: (remote: string) => void;
  }) => (
    <button
      type="button"
      data-testid="pick-remote"
      onClick={() => onSelectRemote("https://github.com/octo/store.git")}
    >
      pick remote
    </button>
  ),
});

const githubConnection = overlapCast({
  connectionId: "con_gh",
  providerId: "github",
  status: "active",
  statusDetail: null,
  accountLabel: "octocat",
  integrationId: "int_gh",
  displayName: "GitHub sealed-store history",
  logicalName: "github",
});

function defaultSettings() {
  return {
    hostApi: "http://127.0.0.1:18787",
    identityApi: "http://127.0.0.1:18788",
    daemonApi: "http://127.0.0.1:18790",
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  };
}

describe("ConnectGitHistory", () => {
  beforeEach(() => {
    Object.assign(planeSeams, { usePlaneStatus: () => planes.value });
    Object.assign(identitySeams, { ensureHostSession });
    Object.assign(settingsSeams, { loadSettings, saveSettings });
    Object.assign(connectionSeams, {
      listConnections,
      listProviders,
      listIntegrations,
      createConnection,
      authorizeConnection,
      awaitConsent,
      setConnectionCredential,
      openConsentPopup,
      startGithubAppRegistration,
      submitGithubAppManifest,
    });
    Object.assign(connectGitHistorySeams, {
      GithubHistoryRemotePicker: ({
        onSelectRemote,
      }: {
        onSelectRemote: (remote: string) => void;
      }) => (
        <button
          type="button"
          data-testid="pick-remote"
          onClick={() => onSelectRemote("https://github.com/octo/store.git")}
        >
          pick remote
        </button>
      ),
    });
    planes.value = { host: "live", identity: "connected" };
    loadSettings.mockReset();
    saveSettings.mockReset();
    loadSettings.mockImplementation(defaultSettings);
    saveSettings.mockImplementation((next) => {
      loadSettings.mockImplementation(() => next);
    });
    listConnections.mockReset();
    listProviders.mockReset();
    listIntegrations.mockReset();
    createConnection.mockReset();
    authorizeConnection.mockReset();
    awaitConsent.mockReset();
    setConnectionCredential.mockReset();
    openConsentPopup.mockReset();
    openConsentPopup.mockReturnValue(null);
    startGithubAppRegistration.mockReset();
    submitGithubAppManifest.mockReset();
    ensureHostSession.mockReset();
    ensureHostSession.mockResolvedValue(undefined);
    listConnections.mockResolvedValue([]);
    listProviders.mockResolvedValue([
      overlapCast({
        id: "github",
        configured: true,
        missingConfig: [],
      }),
    ]);
    listIntegrations.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    Object.assign(planeSeams, originalPlaneSeams);
    Object.assign(identitySeams, originalIdentitySeams);
    Object.assign(settingsSeams, originalSettingsSeams);
    Object.assign(connectionSeams, originalConnectionSeams);
    Object.assign(connectGitHistorySeams, originalGitHistorySeams);
  });

  it("explains in-browser recoverability and does not error for missing git", async () => {
    render(<ConnectGitHistory />);
    expect(
      await screen.findByText(/The vault already lives on this device/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("persists the remote when a repo is picked", async () => {
    listConnections.mockResolvedValue([githubConnection]);
    loadSettings.mockImplementation(() => ({
      ...defaultSettings(),
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github", connectionId: "con_gh" },
      },
    }));
    render(<ConnectGitHistory />);
    await userEvent.click(await screen.findByTestId("pick-remote"));
    expect(saveSettings).toHaveBeenCalled();
    const saved = saveSettings.mock.calls[0][0];
    expect(saved.capabilityConnectors.history.remote).toBe(
      "https://github.com/octo/store.git",
    );
  });

  it("authorizes GitHub through Host and then binds the connection", async () => {
    openConsentPopup.mockReturnValue(
      overlapCast({ location: { href: "" }, close: vi.fn() }),
    );
    createConnection.mockResolvedValue(githubConnection);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize",
    });
    awaitConsent.mockResolvedValue({
      result: "active",
      connection: githubConnection,
    });
    render(<ConnectGitHistory />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub" }),
    );
    await waitFor(() => expect(createConnection).toHaveBeenCalled());
    expect(authorizeConnection).toHaveBeenCalledWith("con_gh", [
      "read:user",
      "repo",
      "workflow",
    ]);
    expect(saveSettings).toHaveBeenCalled();
    expect(await screen.findByText(/GitHub authorized/)).toBeTruthy();
  });

  it("connects with a personal access token when OAuth is skipped", async () => {
    createConnection.mockResolvedValue(githubConnection);
    setConnectionCredential.mockResolvedValue(githubConnection);
    render(<ConnectGitHistory />);
    // The PAT path is an alternative row now — it expands in the sheet
    // rather than sitting open beside the OAuth primary.
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Connect with a personal access token/,
      }),
    );
    const input = await screen.findByLabelText(/personal access token/i);
    await userEvent.type(input, "ghp_testtoken");
    await userEvent.click(
      screen.getByRole("button", { name: "Connect with token" }),
    );
    await waitFor(() =>
      expect(setConnectionCredential).toHaveBeenCalledWith(
        "con_gh",
        "ghp_testtoken",
      ),
    );
    expect(saveSettings).toHaveBeenCalled();
  });

  it("lets a connection error be dismissed", async () => {
    ensureHostSession.mockRejectedValue(new Error("Host unreachable"));
    render(<ConnectGitHistory />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Host unreachable/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Host unreachable/)).toBeNull();
  });

  it("clears the binding when git is disconnected", async () => {
    loadSettings.mockImplementation(() => ({
      ...defaultSettings(),
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: {
          providerId: "github",
          connectionId: "con_gh",
          remote: "https://github.com/octo/store.git",
        },
      },
    }));
    listConnections.mockResolvedValue([githubConnection]);
    render(<ConnectGitHistory />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Disconnect git" }),
    );
    expect(saveSettings).toHaveBeenCalled();
    const saved = saveSettings.mock.calls[0][0];
    expect(saved.capabilityConnectors.history.connectionId).toBeUndefined();
    expect(saved.capabilityConnectors.history.remote).toBeUndefined();
  });
});
