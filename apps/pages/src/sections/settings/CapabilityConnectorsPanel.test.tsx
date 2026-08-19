import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = vi.hoisted(() => ({ value: true }));
const planes = vi.hoisted(() => ({
  value: { host: "live", identity: "connected" },
}));
const session = vi.hoisted(() => ({
  current: { principalId: "prn_op" } as { principalId: string } | null,
}));
const connect = vi.hoisted(() => vi.fn());
const connectState = vi.hoisted(() => ({
  connecting: false,
  error: null as string | null,
}));
const hostLocalSessionEligible = vi.hoisted(() => vi.fn(() => true));
const ensureHostSession = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("../../lib/use-online.js", () => ({ useOnline: () => online.value }));
vi.mock("../../lib/planes.js", () => ({ usePlaneStatus: () => planes.value }));
vi.mock("../../lib/identity.js", () => ({
  useIdentitySession: () => session.current,
  useConnect: () => ({
    connect,
    connecting: connectState.connecting,
    error: connectState.error,
  }),
  ensureHostSession,
  hostLocalSessionEligible,
}));

const loadSettings = vi.hoisted(() => vi.fn());
const saveSettings = vi.hoisted(() => vi.fn());
const shouldAutoConnect = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../lib/settings.js", () => ({
  loadSettings,
  saveSettings,
  shouldAutoConnect,
}));

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

vi.mock("../../lib/connections.js", () => ({
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
}));

// The remote picker has its own test file; stub it with a hook to select a remote.
vi.mock("./GithubHistoryRemotePicker.js", () => ({
  GithubHistoryRemotePicker: ({
    onSelectRemote,
  }: { onSelectRemote: (remote: string) => void }) => (
    <button
      type="button"
      data-testid="pick-remote"
      onClick={() => onSelectRemote("https://github.com/octo/store.git")}
    >
      pick remote
    </button>
  ),
}));

vi.mock("react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: { to: string; children: unknown; className?: string }) => (
    <a href={to} className={className}>
      {children as never}
    </a>
  ),
}));

import type { Connection } from "../../lib/connections.js";
import { CapabilityConnectorsPanel } from "./CapabilityConnectorsPanel.js";

const githubConnection = {
  connectionId: "con_gh",
  providerId: "github",
  status: "active",
  statusDetail: null,
  accountLabel: "octocat",
  integrationId: "int_gh",
  displayName: "GitHub sealed-store history",
  logicalName: "github",
} as unknown as Connection;

function defaultBindings() {
  return {
    encryption: { providerId: "webcrypto" },
    history: { providerId: "github" },
  };
}

describe("CapabilityConnectorsPanel", () => {
  beforeEach(() => {
    online.value = true;
    planes.value = { host: "live", identity: "connected" };
    session.current = { principalId: "prn_op" };
    connectState.connecting = false;
    connectState.error = null;
    hostLocalSessionEligible.mockReturnValue(true);
    shouldAutoConnect.mockReturnValue(true);
    loadSettings.mockReturnValue({ capabilityConnectors: defaultBindings() });
    listConnections.mockResolvedValue([]);
    listProviders.mockResolvedValue([]);
    listIntegrations.mockResolvedValue([]);
    window.history.replaceState({}, "", "/settings");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists both capabilities with their default connectors", async () => {
    render(<CapabilityConnectorsPanel />);
    expect(screen.getByText("Encryption key vault")).toBeTruthy();
    expect(screen.getByText("History & persistence")).toBeTruthy();
    // WebCrypto needs no Host auth.
    expect(screen.getByText("Active on this device")).toBeTruthy();
    // GitHub needs authorization before history can sync.
    expect(screen.getByText("Authorize this connector to sync")).toBeTruthy();
  });

  it("shows the connected account when GitHub is authorized", async () => {
    listConnections.mockResolvedValue([githubConnection]);
    render(<CapabilityConnectorsPanel />);
    expect(await screen.findByText("Connected as octocat")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Re-authorize with OAuth/i }),
    ).toBeTruthy();
  });

  it("auto-connects identity when the local Host is not authoritative", async () => {
    hostLocalSessionEligible.mockReturnValue(false);
    session.current = null;
    connect.mockResolvedValue(undefined);
    render(<CapabilityConnectorsPanel />);
    await waitFor(() => expect(connect).toHaveBeenCalled());
  });

  it("does not auto-connect when auto-connect is disabled", () => {
    hostLocalSessionEligible.mockReturnValue(false);
    session.current = null;
    shouldAutoConnect.mockReturnValue(false);
    render(<CapabilityConnectorsPanel />);
    expect(connect).not.toHaveBeenCalled();
  });

  it("surfaces identity connect errors", () => {
    hostLocalSessionEligible.mockReturnValue(false);
    connectState.error = "identity plane down";
    render(<CapabilityConnectorsPanel />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/identity plane down/);
  });

  it("shows a connecting note while the session starts", () => {
    hostLocalSessionEligible.mockReturnValue(false);
    session.current = null;
    connectState.connecting = true;
    render(<CapabilityConnectorsPanel />);
    expect(screen.getByText(/Starting your OpenSesame session/)).toBeTruthy();
  });

  it("warns that OAuth needs the GitHub App when none is configured", async () => {
    render(<CapabilityConnectorsPanel />);
    await screen.findByText("Authorize this connector to sync");
    await userEvent.click(
      screen.getByRole("button", { name: /Authorize GitHub \(OAuth\)/i }),
    );
    expect(
      await screen.findByText(/Create the GitHub App above first/),
    ).toBeTruthy();
    expect(authorizeConnection).not.toHaveBeenCalled();
  });

  it("offers GitHub App deployment while OAuth is not ready", async () => {
    startGithubAppRegistration.mockResolvedValue({
      action: "https://github.com/settings/apps/new",
      state: "st_1",
      manifest: {},
      redirectUrl: "https://host.example/cb",
    });
    render(<CapabilityConnectorsPanel />);
    const deploy = await screen.findByRole("button", {
      name: /Create GitHub App for this organization/i,
    });
    await userEvent.click(deploy);
    await waitFor(() =>
      expect(startGithubAppRegistration).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "OpenSesame History" }),
      ),
    );
    expect(submitGithubAppManifest).toHaveBeenCalled();
    expect(await screen.findByText(/Sending you to GitHub/)).toBeTruthy();
  });

  it("reports GitHub App deployment failures", async () => {
    startGithubAppRegistration.mockRejectedValue(new Error("host offline"));
    render(<CapabilityConnectorsPanel />);
    const deploy = await screen.findByRole("button", {
      name: /Create GitHub App for this organization/i,
    });
    await userEvent.click(deploy);
    expect(await screen.findByText(/host offline/)).toBeTruthy();
  });

  it("completes OAuth authorization and persists the binding", async () => {
    listProviders.mockResolvedValue([
      { id: "github", configured: true, missingConfig: [] },
    ]);
    listIntegrations.mockResolvedValue([
      {
        id: "int_gh",
        providerId: "github",
        enabled: true,
        configured: true,
        source: "organization",
      },
    ]);
    createConnection.mockResolvedValue(githubConnection);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize?x=1",
    });
    awaitConsent.mockResolvedValue({
      result: "active",
      connection: githubConnection,
    });
    render(<CapabilityConnectorsPanel />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Authorize GitHub \(OAuth\)/i,
      }),
    );
    expect(
      await screen.findByText(/GitHub authorized\. Pick a repo/),
    ).toBeTruthy();
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "github",
        integrationId: "int_gh",
      }),
    );
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityConnectors: expect.objectContaining({
          history: expect.objectContaining({ connectionId: "con_gh" }),
        }),
      }),
    );
  });

  it("surfaces failed OAuth outcomes from the provider", async () => {
    listProviders.mockResolvedValue([
      { id: "github", configured: true, missingConfig: [] },
    ]);
    createConnection.mockResolvedValue(githubConnection);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize?x=1",
    });
    awaitConsent.mockResolvedValue({
      result: "failed",
      connection: { ...githubConnection, statusDetail: "access denied" },
    });
    render(<CapabilityConnectorsPanel />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Authorize GitHub \(OAuth\)/i,
      }),
    );
    expect(await screen.findByText(/access denied/)).toBeTruthy();
  });

  it("warns when consent is abandoned mid-flow", async () => {
    listProviders.mockResolvedValue([
      { id: "github", configured: true, missingConfig: [] },
    ]);
    createConnection.mockResolvedValue(githubConnection);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://github.com/login/oauth/authorize?x=1",
    });
    awaitConsent.mockResolvedValue({
      result: "cancelled",
      connection: githubConnection,
    });
    render(<CapabilityConnectorsPanel />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Authorize GitHub \(OAuth\)/i,
      }),
    );
    expect(await screen.findByText(/Consent was not finished/)).toBeTruthy();
  });

  it("requires a token before connecting with a PAT", async () => {
    render(<CapabilityConnectorsPanel />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Connect GitHub with token/i,
      }),
    );
    // The button is disabled until a token is typed.
    expect(setConnectionCredential).not.toHaveBeenCalled();
    const input = screen.getByLabelText(
      /connect with a personal access token/i,
    );
    await userEvent.type(input, "   ");
    expect(
      (
        screen.getByRole("button", {
          name: /Connect GitHub with token/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("connects GitHub with a personal access token", async () => {
    createConnection.mockResolvedValue(githubConnection);
    setConnectionCredential.mockResolvedValue(githubConnection);
    render(<CapabilityConnectorsPanel />);
    const input = await screen.findByLabelText(
      /connect with a personal access token/i,
    );
    await userEvent.type(input, "ghp_secret_token");
    await userEvent.click(
      screen.getByRole("button", { name: /Connect GitHub with token/i }),
    );
    await waitFor(() =>
      expect(setConnectionCredential).toHaveBeenCalledWith(
        "con_gh",
        "ghp_secret_token",
      ),
    );
    expect(await screen.findByText(/GitHub connected as octocat/)).toBeTruthy();
    // The token field is cleared once sealed on the Host.
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("reports a stored token that never became active", async () => {
    createConnection.mockResolvedValue(githubConnection);
    setConnectionCredential.mockResolvedValue({
      ...githubConnection,
      status: "pending",
      statusDetail: "bad credentials",
    });
    render(<CapabilityConnectorsPanel />);
    const input = await screen.findByLabelText(
      /connect with a personal access token/i,
    );
    await userEvent.type(input, "ghp_bad");
    await userEvent.click(
      screen.getByRole("button", { name: /Connect GitHub with token/i }),
    );
    expect(await screen.findByText(/bad credentials/)).toBeTruthy();
  });

  it("persists the remote chosen through the history picker", async () => {
    listConnections.mockResolvedValue([githubConnection]);
    render(<CapabilityConnectorsPanel />);
    await screen.findByText("Connected as octocat");
    await userEvent.click(screen.getByTestId("pick-remote"));
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityConnectors: expect.objectContaining({
          history: expect.objectContaining({
            remote: "https://github.com/octo/store.git",
          }),
        }),
      }),
    );
  });

  it("switches the encryption connector and offers OAuth for it", async () => {
    listProviders.mockResolvedValue([
      {
        id: "aws-kms",
        configured: false,
        missingConfig: ["AWS_KMS_KEY_ID"],
        callbackUrl: "https://host.example/cb/aws",
      },
    ]);
    render(<CapabilityConnectorsPanel />);
    await userEvent.selectOptions(
      screen.getByLabelText(/^Connector$/i, {
        selector: "#cap-connector-encryption",
      }),
      "aws-kms",
    );
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityConnectors: expect.objectContaining({
          encryption: expect.objectContaining({ providerId: "aws-kms" }),
        }),
      }),
    );
    // KMS needs auth; with no OAuth app configured the missing-config hint shows.
    expect(
      await screen.findByText(/OAuth App not configured on this Host/),
    ).toBeTruthy();
    expect(screen.getByText(/AWS_KMS_KEY_ID/)).toBeTruthy();
  });

  it("shows a GitLab remote field when history binds to GitLab", async () => {
    loadSettings.mockReturnValue({
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "gitlab", remote: "" },
      },
    });
    render(<CapabilityConnectorsPanel />);
    const input = await screen.findByLabelText(
      /Git remote for encrypted store/i,
    );
    await userEvent.type(input, "https://gitlab.com/org/store.git");
    expect(saveSettings).toHaveBeenCalled();
  });

  it("explains GitHub App registration failures from the redirect", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings?github_app=error&reason=expired_state",
    );
    render(<CapabilityConnectorsPanel />);
    expect(
      await screen.findByText(/registration session expired/i),
    ).toBeTruthy();
    expect(window.location.search).not.toMatch(/github_app/);
  });

  it("confirms GitHub App registration from the redirect", async () => {
    window.history.replaceState({}, "", "/settings?github_app=registered");
    render(<CapabilityConnectorsPanel />);
    expect(
      await screen.findByText(/GitHub App registered\. Authorize History/),
    ).toBeTruthy();
  });

  it("disables authorize while the Host plane is down", async () => {
    planes.value = { host: "degraded", identity: "connected" };
    render(<CapabilityConnectorsPanel />);
    const button = (await screen.findByRole("button", {
      name: /Authorize GitHub \(OAuth\)/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getAllByText(/Host API is not reachable from this tab yet/).length,
    ).toBeGreaterThan(0);
  });
});

describe("CapabilityConnectorsPanel edge branches", () => {
  beforeEach(() => {
    online.value = true;
    planes.value = { host: "live", identity: "connected" };
    session.current = { principalId: "prn_op" };
    connectState.connecting = false;
    connectState.error = null;
    hostLocalSessionEligible.mockReturnValue(true);
    shouldAutoConnect.mockReturnValue(true);
    loadSettings.mockReturnValue({ capabilityConnectors: defaultBindings() });
    listConnections.mockResolvedValue([]);
    listProviders.mockResolvedValue([]);
    listIntegrations.mockResolvedValue([]);
    window.history.replaceState({}, "", "/settings");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("labels a pending connection as incomplete and a broken one with detail", async () => {
    listConnections.mockResolvedValue([
      { ...githubConnection, status: "pending", accountLabel: null },
    ]);
    const { unmount } = render(<CapabilityConnectorsPanel />);
    expect(await screen.findByText("Authorization incomplete")).toBeTruthy();
    unmount();

    // A broken connection only surfaces when the binding points at it.
    loadSettings.mockReturnValue({
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github", connectionId: "con_gh" },
      },
    });
    listConnections.mockResolvedValue([
      {
        ...githubConnection,
        status: "error",
        statusDetail: "token exchange blew up",
      },
    ]);
    render(<CapabilityConnectorsPanel />);
    expect(await screen.findByText("token exchange blew up")).toBeTruthy();
  });

  it("survives Host list failures by showing empty catalogs", async () => {
    listConnections.mockRejectedValue(new Error("down"));
    listProviders.mockRejectedValue(new Error("down"));
    listIntegrations.mockRejectedValue(new Error("down"));
    render(<CapabilityConnectorsPanel />);
    expect(
      await screen.findByText("Authorize this connector to sync"),
    ).toBeTruthy();
  });

  it("explains redirect error reasons", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings?github_app=error&reason=missing_code",
    );
    const { unmount } = render(<CapabilityConnectorsPanel />);
    expect(await screen.findByText(/incomplete redirect/)).toBeTruthy();
    unmount();

    window.history.replaceState(
      {},
      "",
      "/settings?github_app=error&reason=something_custom",
    );
    render(<CapabilityConnectorsPanel />);
    expect(await screen.findByText(/something_custom/)).toBeTruthy();
  });

  it("confirms installation from the redirect", async () => {
    window.history.replaceState({}, "", "/settings?github_app=installed");
    render(<CapabilityConnectorsPanel />);
    expect(
      await screen.findByText(/GitHub App installed\. Authorize/),
    ).toBeTruthy();
  });

  it("appends the PAT hint to GitHub OAuth failures", async () => {
    listProviders.mockResolvedValue([
      { id: "github", configured: true, missingConfig: [] },
    ]);
    createConnection.mockResolvedValue(githubConnection);
    authorizeConnection.mockRejectedValue(new Error("popup blocked"));
    render(<CapabilityConnectorsPanel />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Authorize GitHub \(OAuth\)/i,
      }),
    );
    expect(
      await screen.findByText(/paste a GitHub personal access token below/),
    ).toBeTruthy();
  });

  it("connects GitLab with a token and uses the generic message", async () => {
    loadSettings.mockReturnValue({
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "gitlab" },
      },
    });
    const gitlabConnection = {
      ...githubConnection,
      connectionId: "con_gl",
      providerId: "gitlab",
      accountLabel: null,
    } as unknown as Connection;
    createConnection.mockResolvedValue(gitlabConnection);
    setConnectionCredential.mockResolvedValue(gitlabConnection);
    render(<CapabilityConnectorsPanel />);
    const input = await screen.findByLabelText(
      /connect with a personal access token/i,
    );
    await userEvent.type(input, "glpat-123");
    await userEvent.click(
      screen.getByRole("button", { name: /Connect GitLab with token/i }),
    );
    expect(
      await screen.findByText(/GitLab connected with a personal access token/),
    ).toBeTruthy();
  });

  it("authorizes a non-GitHub connector with the generic success text", async () => {
    // Switch history to GitLab and give it a working OAuth setup.
    loadSettings.mockReturnValue({
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "gitlab" },
      },
    });
    listProviders.mockResolvedValue([
      { id: "gitlab", configured: true, missingConfig: [] },
    ]);
    const gitlabConnection = {
      ...githubConnection,
      connectionId: "con_gl",
      providerId: "gitlab",
    } as unknown as Connection;
    createConnection.mockResolvedValue(gitlabConnection);
    authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://gitlab.com/oauth/authorize",
    });
    awaitConsent.mockResolvedValue({
      result: "active",
      connection: gitlabConnection,
    });
    render(<CapabilityConnectorsPanel />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Authorize GitLab \(OAuth\)/i,
      }),
    );
    expect(
      await screen.findByText(/GitLab authorized for history & persistence/),
    ).toBeTruthy();
  });
});
