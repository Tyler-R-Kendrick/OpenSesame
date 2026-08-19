import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listGithubRepos = vi.hoisted(() => vi.fn());
const createGithubPasswordRepo = vi.hoisted(() => vi.fn());

vi.mock("../../lib/github-history.js", () => ({
  DEFAULT_PASSWORD_REPO_NAME: "opensesame-passwords",
  listGithubRepos,
  createGithubPasswordRepo,
  remoteFromRepo: (repo: { cloneUrl: string }) => repo.cloneUrl,
}));

import type { CapabilityConnectorBinding } from "../../lib/capabilities.js";
import type { Connection } from "../../lib/connections.js";
import { GithubHistoryRemotePicker } from "./GithubHistoryRemotePicker.js";

function makeBinding(remote: string | null = null): CapabilityConnectorBinding {
  return { remote } as CapabilityConnectorBinding;
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    connectionId: "con_gh",
    status: "active",
    ...overrides,
  } as Connection;
}

const activeConnection = makeConnection();

describe("GithubHistoryRemotePicker", () => {
  beforeEach(() => {
    listGithubRepos.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("prompts to authorize GitHub when the connection is not active", () => {
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding()}
        connection={makeConnection({ status: "pending" })}
        disabled={false}
        onSelectRemote={() => {}}
      />,
    );
    expect(screen.getByText(/Authorize GitHub above/i)).toBeTruthy();
    expect(listGithubRepos).not.toHaveBeenCalled();
  });

  it("prompts when there is no connection at all", () => {
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding()}
        connection={undefined}
        disabled={false}
        onSelectRemote={() => {}}
      />,
    );
    expect(screen.getByText(/Authorize GitHub above/i)).toBeTruthy();
  });

  it("loads repos for an active connection and offers them", async () => {
    listGithubRepos.mockResolvedValue([
      {
        fullName: "octo/store",
        name: "store",
        private: true,
        cloneUrl: "https://github.com/octo/store.git",
        htmlUrl: "https://github.com/octo/store",
        defaultBranch: "main",
      },
      {
        fullName: "octo/public",
        name: "public",
        private: false,
        cloneUrl: "https://github.com/octo/public.git",
        htmlUrl: "https://github.com/octo/public",
        defaultBranch: "main",
      },
    ]);
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding()}
        connection={activeConnection}
        disabled={false}
        onSelectRemote={() => {}}
      />,
    );
    expect(await screen.findByText(/octo\/store \(private\)/)).toBeTruthy();
    expect(screen.getByText(/octo\/public \(public\)/)).toBeTruthy();
    expect(listGithubRepos).toHaveBeenCalledWith("con_gh");
  });

  it("reports the selected repository remote", async () => {
    const onSelectRemote = vi.fn();
    listGithubRepos.mockResolvedValue([
      {
        fullName: "octo/store",
        name: "store",
        private: true,
        cloneUrl: "https://github.com/octo/store.git",
        htmlUrl: "https://github.com/octo/store",
        defaultBranch: "main",
      },
    ]);
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding()}
        connection={activeConnection}
        disabled={false}
        onSelectRemote={onSelectRemote}
      />,
    );
    await screen.findByText(/octo\/store \(private\)/);
    await userEvent.selectOptions(
      screen.getByLabelText(/Repository for encrypted store/i),
      "https://github.com/octo/store.git",
    );
    expect(onSelectRemote).toHaveBeenCalledWith(
      "https://github.com/octo/store.git",
    );
  });

  it("creates a private repo and binds it as the remote", async () => {
    const onSelectRemote = vi.fn();
    createGithubPasswordRepo.mockResolvedValue({
      fullName: "octo/opensesame-passwords",
      name: "opensesame-passwords",
      private: true,
      cloneUrl: "https://github.com/octo/opensesame-passwords.git",
      htmlUrl: "https://github.com/octo/opensesame-passwords",
      defaultBranch: "main",
    });
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding()}
        connection={activeConnection}
        disabled={false}
        onSelectRemote={onSelectRemote}
      />,
    );
    await screen.findByText(/Select a repository…/i);
    await userEvent.click(
      screen.getByRole("button", { name: /Create private repo/i }),
    );
    await waitFor(() =>
      expect(onSelectRemote).toHaveBeenCalledWith(
        "https://github.com/octo/opensesame-passwords.git",
      ),
    );
    expect(createGithubPasswordRepo).toHaveBeenCalledWith("con_gh", {
      name: "opensesame-passwords",
      private: true,
    });
    // Refreshes the repo list after creating.
    await waitFor(() => expect(listGithubRepos).toHaveBeenCalledTimes(2));
  });

  it("shows an error when repo creation fails", async () => {
    createGithubPasswordRepo.mockRejectedValue(new Error("app not installed"));
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding()}
        connection={activeConnection}
        disabled={false}
        onSelectRemote={() => {}}
      />,
    );
    await screen.findByText(/Select a repository…/i);
    await userEvent.click(
      screen.getByRole("button", { name: /Create private repo/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/app not installed/);
  });

  it("shows an error when listing repos fails", async () => {
    listGithubRepos.mockRejectedValue(new Error("rate limited"));
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding()}
        connection={activeConnection}
        disabled={false}
        onSelectRemote={() => {}}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/rate limited/);
  });

  it("disables the create button while the name is blank", async () => {
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding()}
        connection={activeConnection}
        disabled={false}
        onSelectRemote={() => {}}
      />,
    );
    await screen.findByText(/Select a repository…/i);
    const input = screen.getByLabelText(/Create private password store/i);
    await userEvent.clear(input);
    expect(
      (
        screen.getByRole("button", {
          name: /Create private repo/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("reloads repos when Refresh list is clicked", async () => {
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding()}
        connection={activeConnection}
        disabled={false}
        onSelectRemote={() => {}}
      />,
    );
    await screen.findByText(/Select a repository…/i);
    await userEvent.click(
      screen.getByRole("button", { name: /Refresh list/i }),
    );
    await waitFor(() => expect(listGithubRepos).toHaveBeenCalledTimes(2));
  });

  it("shows the bound remote when one is set", async () => {
    render(
      <GithubHistoryRemotePicker
        binding={makeBinding("https://github.com/octo/store.git")}
        connection={activeConnection}
        disabled={false}
        onSelectRemote={() => {}}
      />,
    );
    expect(await screen.findByText(/Bound remote:/)).toBeTruthy();
    expect(screen.getByText("https://github.com/octo/store.git")).toBeTruthy();
  });
});
