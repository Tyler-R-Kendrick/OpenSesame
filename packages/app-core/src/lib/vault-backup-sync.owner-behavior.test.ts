import {
  type VaultBody,
  importVaultKey,
  openJson,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import {
  OWNER_PASSWORD,
  type OwnerTransition,
  RELAY,
  deferred,
  encryptedOwner,
} from "./__tests__/backup-prf-owner.test-support.js";
import { backupOriginAllowed } from "./backup-egress-gate.js";
import {
  type LocalBackupTarget,
  clearLocalBackupTarget,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { applyConnectCallbackBase } from "./connect-callback.js";
import { resetCategorySendsForTest } from "./feature-request-send.js";
import { rememberLocalGitRemote } from "./git-remote-local.js";
import {
  forgetLocalGithubApp,
  rememberLocalGithubApp,
  sealPendingGithubAppPem,
  stashPendingGithubAppSecret,
} from "./github-app-local.js";
import { resetSavedGitBackupForTest } from "./saved-git-backup.js";
import {
  drainBackupWebhooks,
  pushSavedForgeBackup,
  syncVaultBackup,
} from "./vault-backup-sync.js";
import { parseOfflineBackup } from "./vault/offline-backup.js";
import { vaultStore } from "./vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  PERSONAL_TOMB,
  readPlaintextFile,
} from "./vfs.js";

const PEM =
  "-----BEGIN PRIVATE KEY-----\nZmFrZS1waHlzaWNhbC1yZWxheS1maXh0dXJl\n-----END PRIVATE KEY-----";
const TOKEN = "fixture-owner-only-git-token";
let owner: Awaited<ReturnType<typeof encryptedOwner>>;

beforeEach(async () => {
  owner = await encryptedOwner();
  applyConnectCallbackBase(undefined);
  clearLocalBackupTarget();
  resetCategorySendsForTest();
  resetSavedGitBackupForTest();
  await owner.policy();
  expect(backupOriginAllowed(RELAY)).toBe(true);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await owner.recoverOwner();
  forgetLocalGithubApp();
  clearLocalBackupTarget();
  resetCategorySendsForTest();
  resetSavedGitBackupForTest();
  applyConnectCallbackBase(undefined);
  await owner.close();
});

function target(
  providerId: string,
  connectionId: string | null = null,
): LocalBackupTarget {
  return {
    kind: connectionId ? "git_remote" : "github_app",
    providerId,
    connectionId,
    integrationId: "",
    installationId: connectionId ? "" : "77",
    owner: "fixture-owner",
    repo: "private-backup",
    branch: "main",
    enabled: true,
    status: "pending",
    lastCommitSha: null,
    lastSyncedAt: null,
    lastError: null,
    config: null,
    pendingEvents: 3,
  };
}

async function github() {
  const app = {
    id: "123",
    key: "github-oauth",
    displayName: "Fixture backup App",
    htmlUrl: null,
    ownerLogin: null,
    ownerType: null,
    installedByLogin: null,
    installations: [],
  };
  rememberLocalGithubApp(app);
  stashPendingGithubAppSecret(app, PEM);
  await sealPendingGithubAppPem();
  await vaultStore.flushPendingWrites();
  const row = target("github");
  writeLocalBackupTarget(row);
  return row;
}

async function forge(
  authMode: "https_token" | "https_basic" | "ssh_agent" = "https_token",
  providerId = "gitlab",
  remoteUrl = "https://gitlab.com/fixture-owner/private-backup.git",
) {
  const remote = await rememberLocalGitRemote({
    displayName: "Fixture forge backup",
    configuration: {
      remote_url: remoteUrl,
      auth_mode: authMode,
      token: TOKEN,
      username: "fixture-user",
    },
  });
  await vaultStore.flushPendingWrites();
  const row = target(providerId, remote.id);
  writeLocalBackupTarget(row);
  return row;
}

async function verifyBackupBody(contentBase64: string) {
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(contentBase64), (character) =>
      character.charCodeAt(0),
    ),
  );
  expect(json).not.toContain(TOKEN);
  expect(json).not.toContain(PEM);
  const backup = parseOfflineBackup(json);
  const raw = await unwrapRawVaultKeyFromPassword(
    backup.vault.header,
    OWNER_PASSWORD,
  );
  try {
    return await openJson<VaultBody>(
      await importVaultKey(raw),
      backup.vault.body,
      vaultSealBinding(PERSONAL_TOMB, BODY_PATH),
    );
  } finally {
    raw.fill(0);
  }
}

describe("default backup relay using encrypted owner credentials", () => {
  it.each(["github", "gitlab"])(
    "pushes a recoverable ciphertext snapshot through %s's physical relay",
    async (provider) => {
      if (provider === "github") await github();
      else await forge("https_basic");
      const fetch = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          Response.json({ commitSha: "fixture-commit" }),
      );
      vi.stubGlobal("fetch", fetch);
      const result = await syncVaultBackup(provider);
      expect(result).toMatchObject({
        status: "ok",
        lastCommitSha: "fixture-commit",
        lastError: null,
        pendingEvents: 0,
      });
      expect(result?.lastSyncedAt).toEqual(expect.any(String));
      expect(fetch).toHaveBeenCalledTimes(1);
      const call = fetch.mock.calls[0];
      if (!call) throw new Error("Expected a physical relay call");
      const [url, init] = call;
      expect(String(url)).toBe(
        `${RELAY}/api/${provider === "github" ? "github-app/put-contents" : "git-backup/put"}`,
      );
      const request: {
        appId?: string;
        pem?: string;
        token?: string;
        username?: string;
        contentBase64: string;
      } = JSON.parse(String(init?.body));
      if (provider === "github")
        expect(request).toMatchObject({ appId: "123", pem: PEM });
      else
        expect(request).toMatchObject({
          token: TOKEN,
          username: "fixture-user",
        });
      const opened = await verifyBackupBody(request.contentBase64);
      expect(
        opened.items.some(
          (item) =>
            item.kind === "secret" &&
            item.value.includes(provider === "github" ? PEM : TOKEN),
        ),
      ).toBe(true);
      expect(readLocalBackupTarget(provider)).toEqual(result);
    },
  );

  it.each([
    [403, { message: "fixture relay refused" }, "fixture relay refused"],
    [409, { error: "fixture conflict" }, "fixture conflict"],
    [503, {}, "Backup write failed (503)"],
  ] as const)(
    "preserves pending work and records a %i relay error",
    async (status, payload, message) => {
      await github();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(payload, { status })),
      );
      await expect(syncVaultBackup("github")).rejects.toThrow(message);
      expect(readLocalBackupTarget("github")).toMatchObject({
        status: "error",
        lastError: message,
        pendingEvents: 3,
        lastCommitSha: null,
      });
    },
  );

  it("accepts a completed push with no commit id without inventing one", async () => {
    await forge();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("malformed physical relay payload")),
    );
    expect(await syncVaultBackup("gitlab")).toMatchObject({
      status: "ok",
      lastCommitSha: null,
    });
  });

  it.each(["policy", "allowlist", "missing-relay"])(
    "refuses %s before any physical backup call",
    async (reason) => {
      await github();
      if (reason === "policy") await owner.policy([RELAY], true);
      if (reason === "allowlist")
        await owner.policy(["https://other-relay.example.test"]);
      if (reason === "missing-relay") {
        const current = host();
        configureHost({
          ...current,
          env: { ...current.env, VITE_CONNECT_CALLBACK_BASE: "" },
        });
      }
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(syncVaultBackup("github")).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      expect(await drainBackupWebhooks()).toBe(0);
    },
  );

  it("resolves a generic Git target from its real remote URL and refuses non-HTTPS authority", async () => {
    const row = await forge("https_token", "git");
    const fetch = vi.fn(async () =>
      Response.json({ commitSha: "generic-forge-commit" }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await pushSavedForgeBackup(row)).toBe("generic-forge-commit");
    const ssh = await forge("ssh_agent");
    await expect(pushSavedForgeBackup(ssh)).rejects.toThrow(/HTTPS token/);
    const unknown = await forge(
      "https_token",
      "git",
      "https://unknown-forge.example.test/a.git",
    );
    await expect(pushSavedForgeBackup(unknown)).rejects.toThrow(/HTTPS token/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("default webhook draining", () => {
  it("requires sealed App credentials and enabled App targets", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ events: [{ id: "event-1" }, { id: "event-2" }] }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await drainBackupWebhooks()).toBe(0);
    const row = await github();
    writeLocalBackupTarget({ ...row, enabled: false });
    expect(await drainBackupWebhooks()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    writeLocalBackupTarget(row);
    expect(await drainBackupWebhooks()).toBe(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `${RELAY}/api/github-app/webhook-pending`,
    );
  });

  it.each(["http-error", "invalid-json", "wrong-shape", "offline"])(
    "treats %s as no webhook delivery",
    async (outcome) => {
      await github();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (outcome === "offline")
            throw new Error("fixture physical network unavailable");
          if (outcome === "http-error")
            return new Response("", { status: 503 });
          if (outcome === "invalid-json") return new Response("not JSON");
          return Response.json({ events: "not an event collection" });
        }),
      );
      expect(await drainBackupWebhooks()).toBe(0);
      expect(readLocalBackupTarget("github")?.pendingEvents).toBe(3);
    },
  );
});

describe("held physical relay completion", () => {
  it.each(["lock", "synthetic", "fresh-owner"] as const)(
    "cannot update metadata or accept old authority after %s",
    async (transition: OwnerTransition) => {
      await github();
      const entered = deferred<void>();
      const release = deferred<Response>();
      const fetch = vi.fn(async () => {
        entered.resolve();
        return release.promise;
      });
      vi.stubGlobal("fetch", fetch);
      const pending = syncVaultBackup("github").then(
        () => null,
        (error: Error) => error,
      );
      try {
        await entered.promise;
        await owner.transition(transition);
        const snapshot = vaultStore.getSnapshot();
        const header = readPlaintextFile(PERSONAL_TOMB, HEADER_PATH);
        const metadata = readLocalBackupTarget("github");
        release.resolve(Response.json({ commitSha: "stale-owner-commit" }));
        expect(await pending).toBeInstanceOf(Error);
        expect(vaultStore.getSnapshot()).toEqual(snapshot);
        expect(readPlaintextFile(PERSONAL_TOMB, HEADER_PATH)).toBe(header);
        expect(readLocalBackupTarget("github")).toEqual(metadata);
        if (transition === "fresh-owner") {
          fetch.mockImplementation(async () =>
            Response.json({ commitSha: "fresh-owner-commit" }),
          );
          expect(await syncVaultBackup("github")).toMatchObject({
            status: "ok",
            lastCommitSha: "fresh-owner-commit",
          });
        }
      } finally {
        release.resolve(Response.json({ commitSha: "fixture-close" }));
        await pending;
      }
    },
  );
});
