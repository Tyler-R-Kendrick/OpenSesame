/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import type { ServerResponse } from "node:http";
import { configureHost } from "@opensesame/app-core/host.js";
import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
} from "@opensesame/app-core/lib/backup-target-local.js";
import {
  allowGithub,
  openGithubTestOwner,
} from "@opensesame/app-core/lib/github-app-authority.test-support.js";
import {
  githubBackupDiscoveryReply,
  verifyBackupAppAssertion,
} from "@opensesame/app-core/lib/github-app-backup-discovery.test-support.js";
import {
  credentials,
  githubFixture,
} from "@opensesame/app-core/lib/github-app-direct.test-support.js";
import {
  forgetLocalGithubApp,
  rememberLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-local.js";
import { githubAppRepoSeams } from "@opensesame/app-core/lib/github-app-repos.js";
import {
  sealPendingGithubAppSecret,
  stashPendingGithubAppSecret,
} from "@opensesame/app-core/lib/github-app-secret.js";
import { DEFAULT_PASSWORD_REPO_NAME } from "@opensesame/app-core/lib/github-history.js";
import { stopVaultBackupObserver } from "@opensesame/app-core/lib/vault-backup-observer.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { localAppConnection } from "@opensesame/app-core/sections/connections/github-app-config-summary-model.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GithubBackupField } from "./GithubBackupRepo.js";

const actualFetch = globalThis.fetch;
const originalList = githubAppRepoSeams.postRelay;
const app = {
  id: "42",
  key: "github-oauth",
  displayName: "Owned pending repository fixture",
  htmlUrl: null,
  ownerLogin: "fixture-owner",
  ownerType: "User",
  installedByLogin: null,
  installations: [
    { id: "77", accountLogin: "fixture-owner", accountType: "User" },
  ],
};
const connection = localAppConnection("fixture-owner");
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Hold = { response: ServerResponse; ended: ReturnType<typeof deferred> };
let server: Awaited<ReturnType<typeof githubFixture>>;
const held: Hold[] = [];
const observed: ReturnType<typeof deferred>[] = [];
const errors: unknown[] = [];
const onReady = vi.fn();
function release(turn: number, names = ["vault-backup"]) {
  const slot = held[turn];
  if (!slot) throw new Error("Missing actual held repository response");
  if (!slot.response.writableEnded)
    slot.response.end(
      JSON.stringify({
        total_count: names.length,
        repositories: names.map((name, index) => ({
          id: index + 1,
          name,
          full_name: `fixture-owner/${name}`,
          private: true,
          default_branch: "main",
          owner: { login: "fixture-owner" },
        })),
      }),
    );
}
async function finish(turn: number, names?: string[]) {
  await act(async () => {
    release(turn, names);
    await held[turn]?.ended.promise;
    await observed[turn]?.promise;
  });
}
beforeEach(async () => {
  stopVaultBackupObserver();
  held.length = 0;
  observed.length = 0;
  errors.length = 0;
  onReady.mockClear();
  configureHost(createTestHost({ locks: webLocksDouble() }));
  vi.stubGlobal("crypto", webcrypto);
  allowGithub();
  await openGithubTestOwner();
  await vaultStore.enrollPin("83619472");
  await vaultStore.removePassword();
  rememberLocalGithubApp(app);
  stashPendingGithubAppSecret(app, credentials.privateKey);
  await sealPendingGithubAppSecret();
  clearLocalBackupTarget();
  server = await githubFixture((request, response) => {
    try {
      response.setHeader("content-type", "application/json");
      if (request.path === "/installation/repositories?per_page=100&page=1") {
        expect(request.method).toBe("GET");
        expect(request.headers.authorization).toBe(
          "Bearer ghs_owned_repository_token",
        );
        const ended = deferred();
        response.once("finish", ended.resolve);
        held.push({ response, ended });
        response.flushHeaders();
        return;
      }
      // Binding starts the real observer's branch poll, separately authorized
      // for this one repository. Inventory credentials must never serve it.
      if (
        request.path === "/repos/fixture-owner/vault-backup/git/ref/heads/main"
      ) {
        expect(request.method).toBe("GET");
        expect(request.headers.authorization).toBe(
          "Bearer ghs_owned_backup_poll_token",
        );
        response.end(
          JSON.stringify({
            ref: "refs/heads/main",
            object: { type: "commit", sha: "b".repeat(40) },
          }),
        );
        return;
      }
      const discovery = githubBackupDiscoveryReply(
        request.path,
        request.method,
        request.headers.authorization ?? "",
        app,
        "main",
        false,
      );
      if (discovery) {
        response.statusCode = discovery.status;
        response.end(JSON.stringify(discovery.value));
        return;
      }
      expect(request.path).toBe("/app/installations/77/access_tokens");
      expect(request.method).toBe("POST");
      verifyBackupAppAssertion(request.headers.authorization ?? "", app.id);
      const input = JSON.parse(request.body);
      const backupPoll = Object.hasOwn(input, "repositories");
      expect(input).toEqual(
        backupPoll
          ? {
              repositories: ["vault-backup"],
              permissions: { contents: "write", metadata: "read" },
            }
          : { permissions: { metadata: "read" } },
      );
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          token: backupPoll
            ? "ghs_owned_backup_poll_token"
            : "ghs_owned_repository_token",
          expires_at: new Date(Date.now() + 600000).toISOString(),
        }),
      );
    } catch (error) {
      errors.push(error);
      response.statusCode = 500;
      response.end("{}");
    }
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    return url.origin === "https://api.github.com"
      ? server.transport.fetch(input, init)
      : actualFetch(input, init);
  });
  // Observe the real adapter completing; do not replace its RSA, HTTP or JSON consumer.
  vi.spyOn(githubAppRepoSeams, "postRelay").mockImplementation(
    async (...args) => {
      const done = deferred();
      observed.push(done);
      try {
        return await originalList(...args);
      } finally {
        done.resolve();
      }
    },
  );
});
afterEach(async () => {
  cleanup();
  stopVaultBackupObserver();
  for (let turn = 0; turn < held.length; turn++) release(turn);
  forgetLocalGithubApp();
  clearLocalBackupTarget();
  await vaultStore.flushPendingWrites();
  vaultStore.lock();
  await server.close();
  expect(errors).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});
function field(seedRepos: string[] = []) {
  return (
    <GithubBackupField
      connection={connection}
      online
      onFlash={vi.fn()}
      onReady={onReady}
      seedRepos={seedRepos}
    />
  );
}
async function waitHeld(count: number) {
  await waitFor(() => expect(held).toHaveLength(count));
}

it("focus and text selection retain the user's value while the real initial HTTP list body finishes", async () => {
  render(field());
  await waitHeld(1);
  const input = screen.getByRole<HTMLInputElement>("combobox", {
    name: "Repository",
  });
  await userEvent.click(input);
  await userEvent.keyboard("{Control>}a{/Control}");
  expect(input.value).toBe(DEFAULT_PASSWORD_REPO_NAME);
  await finish(0);
  expect(input.value).toBe(DEFAULT_PASSWORD_REPO_NAME);
  await userEvent.keyboard("fixture-owner/vault-backup");
  expect(input.value).toBe("fixture-owner/vault-backup");
  expect(
    screen.getByRole("option", {
      name: "fixture-owner/vault-backup",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("option", {
      name: "New · fixture-owner/vault-backup",
    }),
  ).toBeNull();
  expect(readLocalBackupTarget("github")).toBeNull();
});

it("a newer actual list answer wins when refresh inputs change and older HTTP replies finish last", async () => {
  const view = render(field());
  await waitHeld(1);
  const input = screen.getByRole<HTMLInputElement>("combobox", {
    name: "Repository",
  });
  await userEvent.clear(input);
  await userEvent.type(input, "fixture-owner/vault-backup");
  view.rerender(field(["fixture-owner/hint"]));
  await waitHeld(2);
  await finish(1);
  expect(input.value).toBe("fixture-owner/vault-backup");
  expect(
    screen.getByRole("option", {
      name: "fixture-owner/vault-backup",
    }),
  ).toBeTruthy();
  await finish(0, ["stale-only"]);
  expect(input.value).toBe("fixture-owner/vault-backup");
  expect(
    screen.getByRole("option", {
      name: "fixture-owner/vault-backup",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("option", {
      name: "New · fixture-owner/vault-backup",
    }),
  ).toBeNull();
});

it("a successful existing-repository bind retires the old refresh target snapshot before its actual response arrives", async () => {
  render(field());
  await waitHeld(1);
  await finish(0);
  const input = screen.getByRole<HTMLInputElement>("combobox", {
    name: "Repository",
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh repositories" }),
  );
  await waitHeld(2);
  await userEvent.clear(input);
  await userEvent.type(input, "fixture-owner/vault-backup");
  fireEvent.mouseDown(
    screen.getByRole("option", {
      name: "fixture-owner/vault-backup",
    }),
  );
  await screen.findByTestId("github-backup-repo");
  await waitFor(() =>
    expect(
      server.requests.filter(
        (request) =>
          request.path ===
          "/repos/fixture-owner/vault-backup/git/ref/heads/main",
      ),
    ).toHaveLength(1),
  );
  const before = JSON.stringify(readLocalBackupTarget("github"));
  const marker = onReady.mock.calls.length;
  await finish(1, ["stale-only"]);
  expect(screen.getByTestId("github-backup-repo").textContent).toBe(
    "fixture-owner/vault-backup",
  );
  expect(JSON.stringify(readLocalBackupTarget("github"))).toBe(before);
  expect(onReady.mock.calls.slice(marker)).not.toContainEqual([false]);
  // Selecting an existing repository starts a read, never an initial write.
  expect(server.requests.some((request) => request.method === "PUT")).toBe(
    false,
  );
  expect(
    server.requests.some(
      (request) =>
        request.path.includes("/user/repos") || request.path.includes("/orgs/"),
    ),
  ).toBe(false);
});
