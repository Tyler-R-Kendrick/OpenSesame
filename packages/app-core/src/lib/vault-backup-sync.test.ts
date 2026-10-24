/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupEgressGate } from "./backup-egress-gate.js";
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { githubAppRelayBase } from "./github-app-relay.js";
import { syncVaultBackup, vaultBackupSyncSeams } from "./vault-backup-sync.js";

const original = { ...vaultBackupSyncSeams };
const originalGate = { ...backupEgressGate };
const COMMIT_SHA1 = "a".repeat(40);
const COMMIT_SHA256 = "b".repeat(64);
const PRIOR_COMMIT = "c".repeat(40);
const PRIOR_SYNC = "2026-10-23T12:00:00.000Z";
const PRIVATE_VALUE = "do-not-display-provider-credential";

beforeEach(() => {
  clearLocalBackupTarget();
  Object.assign(vaultBackupSyncSeams, original);
});

afterEach(() => {
  Object.assign(vaultBackupSyncSeams, original);
  Object.assign(backupEgressGate, originalGate);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("syncVaultBackup", () => {
  it("no-ops when backup is disabled", async () => {
    writeLocalBackupTarget({
      kind: "github_app",
      providerId: "github",
      connectionId: null,
      integrationId: "",
      installationId: "9",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled: false,
      status: "ok",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: null,
      pendingEvents: 0,
    });
    const putContents = vi.fn(async () => ({ commitSha: "x" }));
    Object.assign(vaultBackupSyncSeams, {
      putContents,
      sealedEnvelopeJson: () => "{}",
      resolveCredentials: () => ({ appId: "1", pem: "PEM" }),
    });
    const result = await syncVaultBackup("github");
    expect(result?.enabled).toBe(false);
    expect(putContents).not.toHaveBeenCalled();
  });

  it("pushes sealed ciphertext for a GitHub App target", async () => {
    writeLocalBackupTarget({
      kind: "github_app",
      providerId: "github",
      connectionId: null,
      integrationId: "",
      installationId: "9",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled: true,
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: null,
      pendingEvents: 0,
    });
    const putContents = vi.fn(async () => ({ commitSha: COMMIT_SHA1 }));
    Object.assign(vaultBackupSyncSeams, {
      putContents,
      sealedEnvelopeJson: () => '{"format":"opensesame-offline-backup","v":1}',
      resolveCredentials: () => ({ appId: "1", pem: "PEM" }),
    });
    const result = await syncVaultBackup("github");
    expect(putContents).toHaveBeenCalled();
    expect(result?.lastCommitSha).toBe(COMMIT_SHA1);
    expect(readLocalBackupTarget("github")?.status).toBe("ok");
  });

  it("pushes sealed ciphertext for a GitLab git_remote target", async () => {
    writeLocalBackupTarget({
      kind: "git_remote",
      providerId: "gitlab",
      connectionId: "git_local_abc",
      integrationId: "",
      installationId: "",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled: true,
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: { remoteUrl: "https://gitlab.com/acme/vault.git" },
      pendingEvents: 0,
    });
    const putForgeContents = vi.fn(async () => ({ commitSha: COMMIT_SHA1 }));
    Object.assign(vaultBackupSyncSeams, {
      putForgeContents,
      sealedEnvelopeJson: () => '{"v":1}',
      resolveForgeCredentials: () => ({
        forge: "gitlab" as const,
        token: "glpat-x",
        username: null,
      }),
    });
    const result = await syncVaultBackup("gitlab");
    expect(putForgeContents).toHaveBeenCalled();
    expect(result?.lastCommitSha).toBe(COMMIT_SHA1);
    expect(readLocalBackupTarget("gitlab")?.providerId).toBe("gitlab");
  });

  it("syncs remaining targets when one fails and rejects with the first error", async () => {
    writeLocalBackupTarget({
      kind: "github_app",
      providerId: "github",
      connectionId: null,
      integrationId: "",
      installationId: "9",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled: true,
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: null,
      pendingEvents: 0,
    });
    writeLocalBackupTarget({
      kind: "git_remote",
      providerId: "gitlab",
      connectionId: "git_local_abc",
      integrationId: "",
      installationId: "",
      owner: "acme",
      repo: "vault",
      branch: "main",
      enabled: true,
      status: "pending",
      lastCommitSha: null,
      lastSyncedAt: null,
      lastError: null,
      config: { remoteUrl: "https://gitlab.com/acme/vault.git" },
      pendingEvents: 0,
    });
    const putContents = vi.fn(async () => {
      throw new Error("relay down");
    });
    const putForgeContents = vi.fn(async () => ({ commitSha: COMMIT_SHA256 }));
    Object.assign(vaultBackupSyncSeams, {
      putContents,
      putForgeContents,
      sealedEnvelopeJson: () => '{"v":1}',
      resolveCredentials: () => ({ appId: "1", pem: "PEM" }),
      resolveForgeCredentials: () => ({
        forge: "gitlab" as const,
        token: "glpat-x",
        username: null,
      }),
    });
    await expect(syncVaultBackup()).rejects.toThrow("relay down");
    expect(putForgeContents).toHaveBeenCalled();
    expect(readLocalBackupTarget("gitlab")?.status).toBe("ok");
    expect(readLocalBackupTarget("gitlab")?.lastCommitSha).toBe(COMMIT_SHA256);
    expect(readLocalBackupTarget("github")?.status).toBe("error");
    expect(readLocalBackupTarget("github")?.lastError).toBe("relay down");
  });
});

function enabledConfirmedTarget(providerId: "github" | "gitlab"): void {
  writeLocalBackupTarget({
    kind: providerId === "github" ? "github_app" : "git_remote",
    providerId,
    connectionId: "git_local_confirmed",
    integrationId: "",
    installationId: "9",
    owner: "acme",
    repo: "vault",
    branch: "main",
    enabled: true,
    status: "ok",
    lastCommitSha: PRIOR_COMMIT,
    lastSyncedAt: PRIOR_SYNC,
    lastError: null,
    config: null,
    pendingEvents: 3,
  });
  Object.assign(backupEgressGate, {
    running: () => true,
    network: () => null,
  });
  Object.assign(vaultBackupSyncSeams, {
    sealedEnvelopeJson: () => '{"ciphertext":"sealed"}',
    resolveCredentials: () => ({ appId: "1", pem: PRIVATE_VALUE }),
    resolveForgeCredentials: () => ({
      forge: "gitlab" as const,
      token: PRIVATE_VALUE,
      username: null,
    }),
  });
}

function expectPreviousSuccessPreserved(providerId: string): void {
  const stored = readLocalBackupTarget(providerId);
  expect(stored?.status).toBe("error");
  expect(stored?.lastCommitSha).toBe(PRIOR_COMMIT);
  expect(stored?.lastSyncedAt).toBe(PRIOR_SYNC);
  expect(stored?.pendingEvents).toBe(3);
  expect(stored?.lastError).not.toContain(PRIVATE_VALUE);
}

const INVALID_CONFIRMATIONS = [
  ["malformed JSON", "{"],
  ["non-object JSON", "null"],
  ["array JSON", "[]"],
  ["missing commit", "{}"],
  ["null commit", JSON.stringify({ commitSha: null })],
  ["empty commit", JSON.stringify({ commitSha: "" })],
  ["whitespace commit", JSON.stringify({ commitSha: " \n" })],
  ["abbreviated commit", JSON.stringify({ commitSha: "deadbeef" })],
  ["non-hex commit", JSON.stringify({ commitSha: "g".repeat(40) })],
  ["null Git object", JSON.stringify({ commitSha: "0".repeat(40) })],
  ["explicit refusal", JSON.stringify({ ok: false, commitSha: COMMIT_SHA1 })],
  [
    "invalid acknowledgement",
    JSON.stringify({ ok: "true", commitSha: COMMIT_SHA1 }),
  ],
  [
    "provider error with a commit",
    JSON.stringify({ error: PRIVATE_VALUE, commitSha: COMMIT_SHA1 }),
  ],
  [
    "oversized confirmation",
    JSON.stringify({ commitSha: COMMIT_SHA1, extra: "x".repeat(65536) }),
  ],
];

describe.each(["github", "gitlab"] as const)(
  "%s backup write confirmation",
  (providerId) => {
    it.each(INVALID_CONFIRMATIONS)(
      "rejects %s without advancing the previous successful backup",
      async (_label, body) => {
        enabledConfirmedTarget(providerId);
        const fetch = vi.fn(async () => new Response(body));
        vi.stubGlobal("fetch", fetch);
        await expect(syncVaultBackup(providerId)).rejects.toThrow(/Backup/);
        expect(fetch).toHaveBeenCalledTimes(1);
        expectPreviousSuccessPreserved(providerId);
      },
    );

    it.each([COMMIT_SHA1, COMMIT_SHA256])(
      "preserves a confirmed Git object %s",
      async (commitSha) => {
        enabledConfirmedTarget(providerId);
        const fetch = vi.fn(async () =>
          Response.json(
            commitSha === COMMIT_SHA1
              ? { commitSha }
              : { commitSha, ok: true, error: null },
          ),
        );
        vi.stubGlobal("fetch", fetch);
        const result = await syncVaultBackup(providerId);
        expect(result?.status).toBe("ok");
        expect(result?.lastCommitSha).toBe(commitSha);
        expect(result?.lastSyncedAt).not.toBe(PRIOR_SYNC);
        expect(result?.lastSyncedAt).not.toBeNull();
        expect(result?.lastError).toBeNull();
        expect(readLocalBackupTarget(providerId)?.pendingEvents).toBe(0);
        const path =
          providerId === "github"
            ? "/api/github-app/put-contents"
            : "/api/git-backup/put";
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
          `${githubAppRelayBase()}${path}`,
          expect.objectContaining({ method: "POST" }),
        );
      },
    );

    it.each([401, 503])(
      "reports HTTP %s without reflecting provider credentials",
      async (status) => {
        enabledConfirmedTarget(providerId);
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            Response.json({ error: PRIVATE_VALUE }, { status }),
          ),
        );
        await expect(syncVaultBackup(providerId)).rejects.toThrow(
          `Backup write failed (${status})`,
        );
        expectPreviousSuccessPreserved(providerId);
      },
    );

    it("preserves an actual transport failure without reporting a write", async () => {
      enabledConfirmedTarget(providerId);
      const failure = new TypeError("Network request failed");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
      await expect(syncVaultBackup(providerId)).rejects.toBe(failure);
      expectPreviousSuccessPreserved(providerId);
    });

    it("does not create first-success metadata for a missing confirmation", async () => {
      enabledConfirmedTarget(providerId);
      const previous = readLocalBackupTarget(providerId);
      if (!previous) throw new Error("Missing fixture target");
      writeLocalBackupTarget({
        ...previous,
        status: "pending",
        lastCommitSha: null,
        lastSyncedAt: null,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({})),
      );
      await expect(syncVaultBackup(providerId)).rejects.toThrow(/Backup/);
      const stored = readLocalBackupTarget(providerId);
      expect(stored?.status).toBe("error");
      expect(stored?.lastCommitSha).toBeNull();
      expect(stored?.lastSyncedAt).toBeNull();
      expect(stored?.pendingEvents).toBe(3);
    });
  },
);

describe.each(["github", "gitlab"] as const)(
  "%s adapter confirmation boundary",
  (providerId) => {
    it.each([null, "", "not-a-git-object"])(
      "refuses an unconfirmed adapter result %s at the status commit boundary",
      async (commitSha) => {
        enabledConfirmedTarget(providerId);
        const put = vi.fn(async () => ({ commitSha }));
        Object.assign(
          vaultBackupSyncSeams,
          providerId === "github"
            ? { putContents: put }
            : { putForgeContents: put },
        );
        await expect(syncVaultBackup(providerId)).rejects.toThrow(
          "Backup write did not confirm a commit.",
        );
        expect(put).toHaveBeenCalledTimes(1);
        expectPreviousSuccessPreserved(providerId);
      },
    );
  },
);
