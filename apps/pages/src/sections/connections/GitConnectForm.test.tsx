/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsError, connectionSeams } from "../../lib/connections.js";
import type { Provider } from "../../lib/connections.js";
import {
  forgetAllLocalGitRemotes,
  listLocalGitRemotes,
} from "../../lib/git-remote-local.js";
import { GitConnectForm } from "./GitConnectForm.js";

const original = { ...connectionSeams };

afterEach(async () => {
  cleanup();
  Object.assign(connectionSeams, original);
  await forgetAllLocalGitRemotes();
});

function gitProvider(): Provider {
  return {
    id: "git",
    displayName: "Git",
    category: "backup_recovery",
    docsUrl: "https://git-scm.com/docs/gitcredentials",
    authKind: "configuration",
    supportsRefresh: false,
    configured: false,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: ["git.fetch", "git.push"],
    configurationFields: [],
  };
}

describe("GitConnectForm", () => {
  it("offers forge-agnostic auth modes and seals an HTTPS token remote on Host", async () => {
    const createConnection = vi.fn(async () => ({
      connectionId: "con_git",
      connectionRef: "conn/git/1",
      logicalName: "git",
      displayName: "Git",
      providerId: "git",
      integrationId: null,
      status: "active" as const,
      statusDetail: null,
      organizationId: "org",
      projectId: null,
      ownerKind: "user",
      shareability: "private" as const,
      requestedScopes: [],
      grantedScopes: [],
      accountLabel: null,
      expiresAt: null,
      refreshable: false,
      lastRefreshedAt: null,
      maxInvokeLevel: 0,
      egress: { scheme: "https", authorities: [], pathPrefixes: [] },
      bindings: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }));
    const setConnectionConfiguration = vi.fn(async () => undefined);
    Object.assign(connectionSeams, {
      createConnection,
      setConnectionConfiguration,
    });

    const onConnected = vi.fn();
    render(
      <GitConnectForm
        provider={gitProvider()}
        online
        onFlash={vi.fn()}
        onConnected={onConnected}
      />,
    );

    expect(screen.getByText(/HTTPS token/i)).toBeTruthy();
    expect(screen.getByText(/HTTPS username \+ password/i)).toBeTruthy();
    expect(screen.getByText(/SSH private key/i)).toBeTruthy();
    expect(screen.getByText(/^SSH agent$/i)).toBeTruthy();

    await userEvent.type(
      screen.getByLabelText(/Remote URL/i),
      "https://git.example.com/org/store.git",
    );
    await userEvent.type(screen.getByLabelText(/^Token$/i), "glpat-secret");
    await userEvent.click(
      screen.getByRole("button", { name: /Save Git remote/i }),
    );

    await waitFor(() => expect(createConnection).toHaveBeenCalled());
    expect(setConnectionConfiguration).toHaveBeenCalledWith("con_git", {
      remote_url: "https://git.example.com/org/store.git",
      auth_mode: "https_token",
      token: "glpat-secret",
    });
    expect(onConnected).toHaveBeenCalled();
  });

  it("saves locally when Host is unreachable", async () => {
    Object.assign(connectionSeams, {
      createConnection: vi.fn(async () => {
        throw new ConnectionsError(
          0,
          "unreachable",
          "Couldn't reach the connected service.",
        );
      }),
    });

    const onFlash = vi.fn();
    const onConnected = vi.fn();
    render(
      <GitConnectForm
        provider={gitProvider()}
        online={false}
        onFlash={onFlash}
        onConnected={onConnected}
      />,
    );

    await userEvent.click(screen.getByText(/^SSH agent$/i));
    await userEvent.type(
      screen.getByLabelText(/Remote URL/i),
      "git@forge.example:team/store.git",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Save Git remote/i }),
    );

    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(listLocalGitRemotes()).toHaveLength(1);
    expect(listLocalGitRemotes()[0]?.authMode).toBe("ssh_agent");
    expect(onFlash).toHaveBeenCalledWith({
      tone: "ok",
      text: "Git remote saved.",
    });
  });

  it("accepts an SSH remote URL in the remote field", async () => {
    render(
      <GitConnectForm
        provider={gitProvider()}
        online
        onFlash={vi.fn()}
        onConnected={vi.fn()}
      />,
    );
    const remote = screen.getByLabelText(/Remote URL/i);
    expect(remote.getAttribute("type")).toBe("text");
    await userEvent.type(remote, "git@host:org/repo.git");
    expect((remote as HTMLInputElement).value).toBe("git@host:org/repo.git");
  });
});
