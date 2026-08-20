import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = vi.hoisted(() => ({ value: true }));
const planes = vi.hoisted(() => ({
  value: { host: "live", identity: "connected" },
}));
const session = vi.hoisted(() => ({ principalId: "prn_op" }));
const ensureHostSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

import { useOnlineSeams } from "../../lib/use-online.js";
const originalUseOnlineSeams = { ...useOnlineSeams };
Object.assign(useOnlineSeams, {useOnline: () => online.value});
import { planeSeams } from "../../lib/planes.js";
const originalPlaneSeams = { ...planeSeams };
Object.assign(planeSeams, {usePlaneStatus: () => planes.value});
import { identitySeams } from "../../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {useIdentitySession: () => session,
  ensureHostSession,
  hostLocalSessionEligible: () => true});
const loadSettings = vi.hoisted(() =>
  vi.fn(() => ({ capabilityConnectors: {} })),
);
const saveSettings = vi.hoisted(() => vi.fn());

import { settingsSeams } from "../../lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, {loadSettings, saveSettings});
const getBackupStatus = vi.hoisted(() => vi.fn());
const putBackupTarget = vi.hoisted(() => vi.fn());
const deleteBackupTarget = vi.hoisted(() => vi.fn());
const resyncBackup = vi.hoisted(() => vi.fn());
const listGithubInstallations = vi.hoisted(() => vi.fn());

import { backupSeams } from "../../lib/backup.js";
const originalBackupSeams = { ...backupSeams };
Object.assign(backupSeams, {
  getBackupStatus,
  putBackupTarget,
  deleteBackupTarget,
  resyncBackup,
  listGithubInstallations,
});

const listConnections = vi.hoisted(() => vi.fn());
const listIntegrations = vi.hoisted(() => vi.fn());
const createConnection = vi.hoisted(() => vi.fn());
const authorizeConnection = vi.hoisted(() => vi.fn());
const awaitConsent = vi.hoisted(() => vi.fn());
const openConsentPopup = vi.hoisted(() => vi.fn(() => null));
const startGithubAppRegistration = vi.hoisted(() => vi.fn());
const submitGithubAppManifest = vi.hoisted(() => vi.fn());

import { connectionSeams } from "../../lib/connections.js";
const originalConnectionSeams = { ...connectionSeams };
Object.assign(connectionSeams, {
  listConnections,
  listIntegrations,
  createConnection,
  authorizeConnection,
  awaitConsent,
  openConsentPopup,
  startGithubAppRegistration,
  submitGithubAppManifest,
});

const listGithubRepos = vi.hoisted(() => vi.fn());
const createGithubPasswordRepo = vi.hoisted(() => vi.fn());

import { githubHistorySeams } from "../../lib/github-history.js";
const originalGithubHistorySeams = { ...githubHistorySeams };
Object.assign(githubHistorySeams, { listGithubRepos, createGithubPasswordRepo });

import type { Connection } from "../../lib/connections.js";
import { GithubBackupPanel } from "./GithubBackupPanel.js";

const githubConnection = overlapCast({
  connectionId: "con_gh",
  connectionRef: "connref_gh",
  logicalName: "github",
  displayName: "GitHub sealed-store recoverability",
  providerId: "github",
  integrationId: "int_gh",
  status: "active",
  statusDetail: null,
  organizationId: "org_1",
  projectId: null,
  ownerKind: "user",
  shareability: "private",
  requestedScopes: [],
  grantedScopes: [],
  accountLabel: "octocat",
  expiresAt: null,
  refreshable: false,
});

const orgIntegration = {
  id: "int_gh",
  key: "github-app",
  providerId: "github",
  displayName: "OpenSesame Recoverability",
  source: "organization",
  enabled: true,
  configured: true,
  scopes: [],
  githubAppHtmlUrl: "https://github.com/apps/opensesame-recoverability",
};

const privateRepo = {
  fullName: "octocat/opensesame-passwords",
  name: "opensesame-passwords",
  private: true,
  cloneUrl: "https://github.com/octocat/opensesame-passwords.git",
  htmlUrl: "https://github.com/octocat/opensesame-passwords",
  defaultBranch: "main",
};

function mockBaseline() {
  getBackupStatus.mockResolvedValue({ target: null, pendingEvents: 0 });
  listConnections.mockResolvedValue([githubConnection]);
  listIntegrations.mockResolvedValue([orgIntegration]);
  listGithubInstallations.mockResolvedValue([
    {
      id: "4242",
      accountLogin: "octocat",
      accountType: "User",
      targetType: "User",
    },
  ]);
  listGithubRepos.mockResolvedValue([privateRepo]);
}

describe("GithubBackupPanel", () => {
  beforeEach(() => {
    online.value = true;
    planes.value = { host: "live", identity: "connected" };
    window.history.replaceState({}, "", "/settings");
    mockBaseline();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("asks for a network connection while offline", () => {
    online.value = false;
    render(<GithubBackupPanel />);
    expect(
      screen.getByText(/Connect to the network to configure backup/i),
    ).toBeTruthy();
    expect(getBackupStatus).not.toHaveBeenCalled();
  });

  it("warns when no backup target is configured", async () => {
    render(<GithubBackupPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/No GitHub backup target/);
  });

  it("shows the healthy target summary with commit and environment branch", async () => {
    getBackupStatus.mockResolvedValue({
      target: {
        integrationId: "int_gh",
        installationId: "4242",
        owner: "octocat",
        repo: "opensesame-passwords",
        branch: "env/staging",
        enabled: true,
        status: "ok",
        lastCommitSha: "0123456789abcdef",
        lastSyncedAt: null,
        lastError: null,
      },
      pendingEvents: 0,
    });
    render(<GithubBackupPanel />);
    expect(
      await screen.findByText(/octocat\/opensesame-passwords@env\/staging/),
    ).toBeTruthy();
    expect(screen.getByText(/last commit 0123456/)).toBeTruthy();
    // The environment select adopts the target's branch.
    await waitFor(() =>
      expect(
        (overlapCast(screen.getByRole("combobox", { name: "" }))).value,
      ).toBe("staging"),
    );
  });

  it("warns on an unhealthy target with pending events", async () => {
    getBackupStatus.mockResolvedValue({
      target: {
        integrationId: "int_gh",
        installationId: "4242",
        owner: "octocat",
        repo: "opensesame-passwords",
        branch: "env/production",
        enabled: true,
        status: "error",
        lastCommitSha: null,
        lastSyncedAt: null,
        lastError: "push rejected",
      },
      pendingEvents: 3,
    });
    render(<GithubBackupPanel />);
    expect(await screen.findByText(/3 pending/)).toBeTruthy();
    expect(screen.getByText(/push rejected/)).toBeTruthy();
  });

  it("confirms app registration from the redirect query and cleans the URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings?github_app=registered&integration=int_gh",
    );
    render(<GithubBackupPanel />);
    expect(
      await screen.findByText(/GitHub App registered\. Authorize below/),
    ).toBeTruthy();
    expect(window.location.search).not.toMatch(/github_app/);
    expect(window.location.hash).toBe("#github-backup");
  });

  it("explains registration failures from the redirect query", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings?github_app=error&reason=missing_state",
    );
    render(<GithubBackupPanel />);
    expect(await screen.findByText(/incomplete redirect/)).toBeTruthy();
  });

  it("confirms installation from the redirect query", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings?github_app=installed&installation_id=4242",
    );
    render(<GithubBackupPanel />);
    expect(
      await screen.findByText(/GitHub App installed\. Pick a private repo/),
    ).toBeTruthy();
  });

  it("requires a repository before saving", async () => {
    render(<GithubBackupPanel />);
    await screen.findByText(/octocat \(User\) · id 4242/);
    await userEvent.click(
      screen.getByRole("button", { name: /Save backup target/i }),
    );
    expect(
      await screen.findByText(/Pick or create a private GitHub repo/),
    ).toBeTruthy();
    expect(putBackupTarget).not.toHaveBeenCalled();
  });

  it("saves the backup target for the selected private repo", async () => {
    putBackupTarget.mockResolvedValue({});
    render(<GithubBackupPanel />);
    const repoSelect = await screen.findByLabelText(/^Repository$/i);
    await waitFor(() =>
      expect(screen.getByText(/octocat\/opensesame-passwords/)).toBeTruthy(),
    );
    await userEvent.selectOptions(
      repoSelect,
      "https://github.com/octocat/opensesame-passwords.git",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save backup target/i }),
    );
    await waitFor(() =>
      expect(putBackupTarget).toHaveBeenCalledWith({
        connectionId: "con_gh",
        installationId: "4242",
        owner: "octocat",
        repo: "opensesame-passwords",
        branch: "env/production",
        enabled: true,
      }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Backup target saved/);
    // Binds the history capability to the same connection.
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityConnectors: expect.objectContaining({
          history: expect.objectContaining({ connectionId: "con_gh" }),
        }),
      }),
    );
  });

  it("maps the chosen environment to its backup branch", async () => {
    putBackupTarget.mockResolvedValue({});
    render(<GithubBackupPanel />);
    const repoSelect = await screen.findByLabelText(/^Repository$/i);
    await screen.findByText(/octocat\/opensesame-passwords/);
    await userEvent.selectOptions(
      repoSelect,
      "https://github.com/octocat/opensesame-passwords.git",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "" }),
      "development",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save backup target/i }),
    );
    await waitFor(() =>
      expect(putBackupTarget).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "env/development" }),
      ),
    );
  });

  it("reports save failures from the host", async () => {
    putBackupTarget.mockRejectedValue(new Error("host refused"));
    render(<GithubBackupPanel />);
    const repoSelect = await screen.findByLabelText(/^Repository$/i);
    await screen.findByText(/octocat\/opensesame-passwords/);
    await userEvent.selectOptions(
      repoSelect,
      "https://github.com/octocat/opensesame-passwords.git",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save backup target/i }),
    );
    expect(await screen.findByText(/host refused/)).toBeTruthy();
  });

  it("creates a private repo and binds it as the remote", async () => {
    createGithubPasswordRepo.mockResolvedValue(privateRepo);
    render(<GithubBackupPanel />);
    await screen.findByLabelText(/^Repository$/i);
    await userEvent.click(
      screen.getByRole("button", { name: /Create private repo/i }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(
      /Created private octocat\/opensesame-passwords/,
    );
    expect(createGithubPasswordRepo).toHaveBeenCalledWith("con_gh", {
      name: "opensesame-passwords",
      private: true,
    });
    // Remote select now points at the new repo.
    await waitFor(() =>
      expect(
        (overlapCast(screen.getByLabelText(/^Repository$/i))).value,
      ).toBe("https://github.com/octocat/opensesame-passwords.git"),
    );
  });

  it("reports repo creation failures", async () => {
    createGithubPasswordRepo.mockRejectedValue(new Error("name taken"));
    render(<GithubBackupPanel />);
    await screen.findByLabelText(/^Repository$/i);
    await userEvent.click(
      screen.getByRole("button", { name: /Create private repo/i }),
    );
    expect(await screen.findByText(/name taken/)).toBeTruthy();
  });

  it("queues a full resync", async () => {
    getBackupStatus.mockResolvedValue({
      target: {
        integrationId: "int_gh",
        installationId: "4242",
        owner: "octocat",
        repo: "opensesame-passwords",
        branch: "env/production",
        enabled: true,
        status: "ok",
        lastCommitSha: null,
        lastSyncedAt: null,
        lastError: null,
      },
      pendingEvents: 0,
    });
    resyncBackup.mockResolvedValue({});
    render(<GithubBackupPanel />);
    await screen.findByText(/octocat\/opensesame-passwords@env\/production/);
    await userEvent.click(screen.getByRole("button", { name: /Resync now/i }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Full resync queued/);
  });

  it("clears the backup target", async () => {
    getBackupStatus.mockResolvedValue({
      target: {
        integrationId: "int_gh",
        installationId: "4242",
        owner: "octocat",
        repo: "opensesame-passwords",
        branch: "env/production",
        enabled: true,
        status: "ok",
        lastCommitSha: null,
        lastSyncedAt: null,
        lastError: null,
      },
      pendingEvents: 0,
    });
    deleteBackupTarget.mockResolvedValue({});
    render(<GithubBackupPanel />);
    await screen.findByText(/octocat\/opensesame-passwords@env\/production/);
    await userEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
    expect(await screen.findByText(/Backup target removed/)).toBeTruthy();
  });

  it("starts GitHub App registration from the create button", async () => {
    startGithubAppRegistration.mockResolvedValue({
      action: "https://github.com/settings/apps/new",
      state: "st_1",
      manifest: {},
      redirectUrl: "https://host.example/callback",
    });
    render(<GithubBackupPanel />);
    await screen.findByRole("button", { name: /Recreate GitHub App/i });
    await userEvent.click(
      screen.getByRole("button", { name: /Recreate GitHub App/i }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Sending you to GitHub/);
    expect(submitGithubAppManifest).toHaveBeenCalled();
  });

  it("surfaces registration start failures", async () => {
    startGithubAppRegistration.mockRejectedValue(new Error("host busy"));
    render(<GithubBackupPanel />);
    await screen.findByRole("button", { name: /Recreate GitHub App/i });
    await userEvent.click(
      screen.getByRole("button", { name: /Recreate GitHub App/i }),
    );
    expect(await screen.findByText(/host busy/)).toBeTruthy();
  });

  it("completes OAuth authorization and binds the connection", async () => {
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize?x=1",
    });
    awaitConsent.mockResolvedValue({
      result: "active",
      connection: githubConnection,
    });
    render(<GithubBackupPanel />);
    await screen.findByRole("button", { name: /Re-authorize/i });
    await userEvent.click(
      screen.getByRole("button", { name: /Re-authorize/i }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/GitHub authorized/);
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityConnectors: expect.objectContaining({
          history: expect.objectContaining({ connectionId: "con_gh" }),
        }),
      }),
    );
  });

  it("warns when consent is abandoned", async () => {
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize?x=1",
    });
    awaitConsent.mockResolvedValue({
      result: "cancelled",
      connection: githubConnection,
    });
    render(<GithubBackupPanel />);
    await screen.findByRole("button", { name: /Re-authorize/i });
    await userEvent.click(
      screen.getByRole("button", { name: /Re-authorize/i }),
    );
    expect(await screen.findByText(/Consent was not finished/)).toBeTruthy();
  });

  it("surfaces failed OAuth outcomes", async () => {
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize?x=1",
    });
    awaitConsent.mockResolvedValue({
      result: "failed",
      connection: { ...githubConnection, statusDetail: "user declined" },
    });
    render(<GithubBackupPanel />);
    await screen.findByRole("button", { name: /Re-authorize/i });
    await userEvent.click(
      screen.getByRole("button", { name: /Re-authorize/i }),
    );
    expect(await screen.findByText(/user declined/)).toBeTruthy();
  });

  it("creates a connection first when none is usable", async () => {
    listConnections.mockResolvedValue([]);
    createConnection.mockResolvedValue(githubConnection);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize?x=1",
    });
    awaitConsent.mockResolvedValue({
      result: "active",
      connection: githubConnection,
    });
    render(<GithubBackupPanel />);
    await screen.findByRole("button", { name: /Authorize GitHub/i });
    await userEvent.click(
      screen.getByRole("button", { name: /Authorize GitHub/i }),
    );
    await waitFor(() =>
      expect(createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "github",
          integrationId: "int_gh",
        }),
      ),
    );
    expect(await screen.findByText(/GitHub authorized/)).toBeTruthy();
  });

  it("disables setup steps while the Host is unreachable", async () => {
    planes.value = { host: "degraded", identity: "connected" };
    render(<GithubBackupPanel />);
    expect(
      await screen.findByText(/Host API is not reachable from this tab/),
    ).toBeTruthy();
    expect(
      (
        overlapCast(screen.getByRole("button", {
          name: /Save backup target/i,
        }))
      ).disabled,
    ).toBe(true);
  });
});

describe("GithubBackupPanel edge branches", () => {
  beforeEach(() => {
    online.value = true;
    planes.value = { host: "live", identity: "connected" };
    window.history.replaceState({}, "", "/settings");
    mockBaseline();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the install page for the tenant app", async () => {
    render(<GithubBackupPanel />);
    await screen.findByText(/octocat \(User\) · id 4242/);
    await userEvent.click(
      screen.getByRole("button", { name: /Open Install page again/i }),
    );
    expect(
      await screen.findByText(/Opening GitHub to install the App/),
    ).toBeTruthy();
  });

  it("falls back to manual install guidance without an app URL", async () => {
    listIntegrations.mockResolvedValue([
      { ...orgIntegration, githubAppHtmlUrl: null, displayName: "" },
    ]);
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<GithubBackupPanel />);
    await screen.findByText(/octocat \(User\) · id 4242/);
    await userEvent.click(
      screen.getByRole("button", { name: /Open Install page again/i }),
    );
    expect(
      await screen.findByText(
        /Settings → Applications → Installed GitHub Apps/,
      ),
    ).toBeTruthy();
    expect(open).toHaveBeenCalledWith(
      "https://github.com/settings/installations",
      "_blank",
      "noopener",
    );
    vi.unstubAllGlobals();
  });

  it("reports repo list failures", async () => {
    listGithubInstallations.mockRejectedValue(new Error("installations down"));
    listGithubRepos.mockRejectedValue(new Error("repos down"));
    render(<GithubBackupPanel />);
    // Both rejection paths settle; the panel stays usable.
    await waitFor(() => expect(listGithubInstallations).toHaveBeenCalled());
    expect(
      screen.getByRole("heading", { name: /GitHub recoverability/ }),
    ).toBeTruthy();
  });

  it("reports resync failures", async () => {
    getBackupStatus.mockResolvedValue({
      target: {
        integrationId: "int_gh",
        installationId: "4242",
        owner: "octocat",
        repo: "opensesame-passwords",
        branch: "env/production",
        enabled: true,
        status: "ok",
        lastCommitSha: null,
        lastSyncedAt: null,
        lastError: null,
      },
      pendingEvents: 0,
    });
    resyncBackup.mockRejectedValue(new Error("queue full"));
    render(<GithubBackupPanel />);
    await screen.findByText(/octocat\/opensesame-passwords@env\/production/);
    await userEvent.click(screen.getByRole("button", { name: /Resync now/i }));
    expect(await screen.findByText(/queue full/)).toBeTruthy();
  });

  it("reports clear-target failures", async () => {
    getBackupStatus.mockResolvedValue({
      target: {
        integrationId: "int_gh",
        installationId: "4242",
        owner: "octocat",
        repo: "opensesame-passwords",
        branch: "env/production",
        enabled: true,
        status: "ok",
        lastCommitSha: null,
        lastSyncedAt: null,
        lastError: null,
      },
      pendingEvents: 0,
    });
    deleteBackupTarget.mockRejectedValue(new Error("not found"));
    render(<GithubBackupPanel />);
    await screen.findByText(/octocat\/opensesame-passwords@env\/production/);
    await userEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
    expect(await screen.findByText(/not found/)).toBeTruthy();
  });

  it("requires an installation before saving", async () => {
    listGithubInstallations.mockResolvedValue([]);
    render(<GithubBackupPanel />);
    const repoSelect = await screen.findByLabelText(/^Repository$/i);
    await screen.findByText(/octocat\/opensesame-passwords/);
    await userEvent.selectOptions(
      repoSelect,
      "https://github.com/octocat/opensesame-passwords.git",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save backup target/i }),
    );
    expect(await screen.findByText(/Install the App on GitHub/)).toBeTruthy();
    expect(putBackupTarget).not.toHaveBeenCalled();
  });

  it("adopts the target connection and environment from the status", async () => {
    getBackupStatus.mockResolvedValue({
      target: {
        integrationId: "int_gh",
        installationId: "4242",
        owner: "octocat",
        repo: "opensesame-passwords",
        branch: "main",
        enabled: false,
        status: "pending",
        lastCommitSha: null,
        lastSyncedAt: null,
        lastError: null,
      },
      pendingEvents: 1,
    });
    render(<GithubBackupPanel />);
    expect(
      await screen.findByText(/octocat\/opensesame-passwords@main/),
    ).toBeTruthy();
    expect(screen.getByText(/1 pending/)).toBeTruthy();
  });
});

describe("GithubBackupPanel selectors", () => {
  beforeEach(() => {
    online.value = true;
    planes.value = { host: "live", identity: "connected" };
    window.history.replaceState({}, "", "/settings");
    mockBaseline();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("switches between multiple GitHub connections", async () => {
    listConnections.mockResolvedValue([
      githubConnection,
      overlapCast({
        ...githubConnection,
        connectionId: "con_gh2",
        displayName: "GitHub org account",
        accountLabel: "octo-org",
        status: "needs_reauth",
      }),
    ]);
    render(<GithubBackupPanel />);
    const select = await screen.findByLabelText(/GitHub connection/i);
    await userEvent.selectOptions(select, "con_gh2");
    // The selected connection loses its active state.
    expect(
      await screen.findByRole("button", { name: /Authorize GitHub/i }),
    ).toBeTruthy();
  });

  it("selects among multiple installations", async () => {
    listGithubInstallations.mockResolvedValue([
      {
        id: "4242",
        accountLogin: "octocat",
        accountType: "User",
        targetType: "User",
      },
      {
        id: "5555",
        accountLogin: "octo-org",
        accountType: "Organization",
        targetType: "Organization",
      },
    ]);
    render(<GithubBackupPanel />);
    const select = await screen.findByLabelText(/^Installation$/i);
    await screen.findByText(/octo-org \(Organization\) · id 5555/);
    await userEvent.selectOptions(select, "5555");
    expect((overlapCast(select)).value).toBe("5555");
  });

  it("edits the new-repo name before creating", async () => {
    createGithubPasswordRepo.mockResolvedValue({
      ...privateRepo,
      fullName: "octocat/custom-store",
      cloneUrl: "https://github.com/octocat/custom-store.git",
    });
    render(<GithubBackupPanel />);
    await screen.findByLabelText(/^Repository$/i);
    const input = screen.getByLabelText(/Or create private password repo/i);
    await userEvent.clear(input);
    await userEvent.type(input, "custom-store");
    await userEvent.click(
      screen.getByRole("button", { name: /Create private repo/i }),
    );
    expect(
      await screen.findByText(/Created private octocat\/custom-store/),
    ).toBeTruthy();
    expect(createGithubPasswordRepo).toHaveBeenCalledWith("con_gh", {
      name: "custom-store",
      private: true,
    });
  });
});
