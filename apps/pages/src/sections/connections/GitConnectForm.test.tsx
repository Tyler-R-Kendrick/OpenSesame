/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupSeams } from "../../lib/backup.js";
import { ConnectionsError, connectionSeams } from "../../lib/connections.js";
import type { Provider } from "../../lib/connections.js";
import {
  forgetAllLocalGitRemotes,
  listLocalGitRemotes,
} from "../../lib/git-remote-local.js";
import { vaultStore } from "../../lib/vault/store.js";
import { GitConnectForm } from "./GitConnectForm.js";

const original = { ...connectionSeams };
const originalBackup = { ...backupSeams };

afterEach(async () => {
  cleanup();
  Object.assign(connectionSeams, original);
  Object.assign(backupSeams, originalBackup);
  vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(true);
  vi.spyOn(vaultStore, "trashItem").mockResolvedValue(undefined);
  await forgetAllLocalGitRemotes();
  vi.restoreAllMocks();
});

function gitProvider(id = "git"): Provider {
  return {
    id,
    displayName: id === "git" ? "Git" : id,
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
  it("seals an HTTPS token remote locally and binds backup", async () => {
    vi.spyOn(vaultStore, "isUnlocked").mockReturnValue(true);
    vi.spyOn(vaultStore, "addItems").mockResolvedValue(undefined);
    const putBackupTarget = vi.fn(async (input) => ({
      kind: "git_remote",
      providerId: input.providerId ?? "git",
      connectionId: input.connectionId ?? null,
      integrationId: "",
      installationId: "",
      owner: input.owner ?? "",
      repo: input.repo ?? "",
      branch: "main",
      enabled: true,
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: input.config ?? null,
    }));
    Object.assign(backupSeams, { putBackupTarget });
    Object.assign(connectionSeams, {
      createConnection: vi.fn(async () => {
        throw new ConnectionsError(0, "unreachable", "offline");
      }),
      setConnectionConfiguration: vi.fn(async () => undefined),
    });

    const onConnected = vi.fn();
    render(
      <GitConnectForm
        provider={gitProvider("gitlab")}
        online
        onFlash={vi.fn()}
        onConnected={onConnected}
      />,
    );

    expect(screen.getByText(/HTTPS token/i)).toBeTruthy();

    await userEvent.type(
      screen.getByLabelText(/Remote URL/i),
      "https://gitlab.com/org/store.git",
    );
    await userEvent.type(screen.getByLabelText(/^Token$/i), "glpat-secret");
    await userEvent.click(
      screen.getByRole("button", { name: /Save Git remote/i }),
    );

    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(listLocalGitRemotes()).toHaveLength(1);
    expect(putBackupTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "git_remote",
        providerId: "gitlab",
        owner: "org",
        repo: "store",
        enabled: true,
      }),
    );
  });

  it("saves locally when the optional gateway mirror is unreachable", async () => {
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
