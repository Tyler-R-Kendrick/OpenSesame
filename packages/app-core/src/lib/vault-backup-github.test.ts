/** @vitest-environment jsdom */
import { createHash, verify, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import type { JsonValue } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import {
  clearLocalBackupTarget,
  readLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { ensureDeviceIdentityKey } from "./device-identity-key.js";
import {
  allowGithub,
  openGithubTestOwner,
} from "./github-app-authority.test-support.js";
import { credentials, keyPair } from "./github-app-direct.test-support.js";
import {
  forgetLocalGithubApp,
  rememberLocalGithubApp,
} from "./github-app-local.js";
import {
  sealPendingGithubAppSecret,
  stashPendingGithubAppSecret,
} from "./github-app-secret.js";
import { createProject, setActiveProject } from "./projects.js";
import { restoreSavedGithubBackup } from "./vault-backup-github.js";
import { drainBackupWebhooks, syncVaultBackup } from "./vault-backup-sync.js";
import { VaultStore, vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";

const actualFetch = globalThis.fetch;
const app = {
  id: credentials.appId,
  key: "github-oauth",
  displayName: "Owned backup fixture",
  htmlUrl: null,
  ownerLogin: "fixture-owner",
  ownerType: "User",
  installedByLogin: null,
  installations: [
    { id: "77", accountLogin: "fixture-owner", accountType: "User" },
  ],
};
const base = "/repos/fixture-owner/backups";
let server: ReturnType<typeof createServer>;
let port = 0;
let source: ReturnType<typeof createItem>;
let contents: Buffer | null;
let head: string;
let count: number;
let mode: string;
let onWrite: () => void;
let confirmation: () => JsonValue;
let network: ReturnType<typeof allowGithub>;
const snapshots = new Map<string, Buffer>();
const requests: { path: string; method: string; body: string }[] = [];
const errors: unknown[] = [];
const destinations: VaultStore[] = [];
function blob(bytes: Buffer) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function reply(
  path: string,
  method: string,
  authorization: string,
  body: string,
) {
  if (path === "/app/installations/77/access_tokens") {
    if (mode === "denied") return { status: 403, value: {} };
    const jwt = authorization.replace(/^Bearer /, "").split(".");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${jwt[0]}.${jwt[1]}`),
        keyPair.publicKey,
        Buffer.from(jwt[2] ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(
      JSON.parse(Buffer.from(jwt[1] ?? "", "base64url").toString()).iss,
    ).toBe(app.id);
    expect(JSON.parse(body)).toEqual({
      repositories: ["backups"],
      permissions: { contents: "write", metadata: "read" },
    });
    return {
      status: 201,
      value: {
        token: "ghs_owned_backup_token",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      },
    };
  }
  expect(authorization).toBe("Bearer ghs_owned_backup_token");
  if (path === `${base}/git/ref/heads/backup/primary`)
    return {
      status: 200,
      value: {
        ref: "refs/heads/backup/primary",
        object: { type: "commit", sha: head },
      },
    };
  if (method === "PUT") {
    expect(path).toBe(`${base}/contents/opensesame-vault.backup.json`);
    const input = JSON.parse(body);
    expect(input.branch).toBe("backup/primary");
    expect(input.sha).toBe(contents ? blob(contents) : undefined);
    contents = Buffer.from(input.content, "base64");
    head = createHash("sha1")
      .update(contents)
      .update(String(++count))
      .digest("hex");
    snapshots.set(head, contents);
    onWrite();
    return { status: 201, value: confirmation() };
  }
  const parsed = new URL(path, "https://api.github.com");
  expect(parsed.pathname).toBe(`${base}/contents/opensesame-vault.backup.json`);
  const revision = parsed.searchParams.get("ref") ?? "";
  const bytes =
    revision === "backup/primary" ? contents : snapshots.get(revision);
  if (!bytes) return { status: 404, value: {} };
  const recovered = mode === "corrupt" ? Buffer.from("not a backup") : bytes;
  return {
    status: 200,
    value: {
      type: "file",
      path: "opensesame-vault.backup.json",
      sha: blob(recovered),
      encoding: "base64",
      size: recovered.length,
      content: recovered.toString("base64"),
    },
  };
}
beforeEach(async () => {
  configureHost(createTestHost({ locks: webLocksDouble() }));
  vi.stubGlobal("crypto", webcrypto);
  network = allowGithub();
  await openGithubTestOwner();
  await vaultStore.enrollPin("83619472");
  await vaultStore.removePassword();
  rememberLocalGithubApp(app);
  stashPendingGithubAppSecret(app, credentials.privateKey);
  await sealPendingGithubAppSecret();
  source = createItem("secret", "Source backup secret");
  if (source.kind !== "secret") throw new Error("Expected source secret");
  source.value = "owned-direct-backup-encrypted-canary";
  await vaultStore.saveItem(source);
  await vaultStore.flushPendingWrites();
  clearLocalBackupTarget();
  writeLocalBackupTarget({
    kind: "github_app",
    providerId: "github",
    connectionId: null,
    integrationId: "",
    installationId: "77",
    owner: "fixture-owner",
    repo: "backups",
    branch: "backup/primary",
    enabled: true,
    status: "pending",
    lastCommitSha: null,
    lastSyncedAt: null,
    lastError: null,
    config: null,
    pendingEvents: 2,
  });
  contents = null;
  head = "a".repeat(40);
  count = 0;
  mode = "normal";
  onWrite = () => {};
  confirmation = () => ({ commit: { sha: head } });
  snapshots.clear();
  requests.length = 0;
  errors.length = 0;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1048576) request.destroy();
    });
    request.on("end", () => {
      try {
        const path = request.url ?? "";
        const method = request.method ?? "";
        requests.push({ path, method, body });
        const result = reply(
          path,
          method,
          request.headers.authorization ?? "",
          body,
        );
        response.writeHead(result.status, {
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify(result.value));
      } catch (error) {
        errors.push(error);
        response.writeHead(500);
        response.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = z
    .object({ port: z.number().int().positive().max(65535) })
    .parse(server.address()).port;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.github.com")
      throw new Error("Unexpected provider origin");
    return actualFetch(
      `http://127.0.0.1:${port}${url.pathname}${url.search}`,
      init,
    );
  });
});
afterEach(async () => {
  for (const destination of destinations.splice(0)) {
    await destination.flushPendingWrites();
    destination.lock();
  }
  forgetLocalGithubApp();
  clearLocalBackupTarget();
  await vaultStore.flushPendingWrites();
  vaultStore.lock();
  await setActiveProject("personal");
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  expect(errors).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([40, 64])(
  "uses real default writes and %i-character provider poll IDs without exposing PEM",
  async (length) => {
    const result = await syncVaultBackup("github");
    expect(result?.lastCommitSha).toBe(head);
    expect(result?.status).toBe("ok");
    expect(contents?.toString()).not.toContain(
      "owned-direct-backup-encrypted-canary",
    );
    expect(JSON.stringify(requests)).not.toContain("PRIVATE KEY");
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "PUT",
      "GET",
    ]);
    expect(await drainBackupWebhooks()).toBe(0);
    head = "f".repeat(length);
    expect(await drainBackupWebhooks()).toBe(1);
    expect(
      requests.some((request) => request.path.startsWith("/api/github-app/")),
    ).toBe(false);
  },
);
it("restores real provider ciphertext into another PIN vault and preserves its identity", async () => {
  await syncVaultBackup("github");
  const project = await createProject(`Direct restore ${crypto.randomUUID()}`);
  await setActiveProject(project.id);
  const destination = new VaultStore();
  destinations.push(destination);
  await destination.createWithPin("68391527");
  const kept = createItem("note", "Destination-only note");
  await destination.saveItem(kept);
  const identity = await ensureDeviceIdentityKey(
    destination.getSnapshot().tomb,
  );
  await expect(
    restoreSavedGithubBackup("github", "wrong source PIN", destination),
  ).rejects.toThrow();
  await restoreSavedGithubBackup("github", "83619472", destination);
  await destination.flushPendingWrites();
  await vfsFlush();
  destination.lock();
  await expect(destination.unlockWithPin("83619472")).rejects.toThrow();
  await destination.unlockWithPin("68391527");
  expect(destination.getSnapshot().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: kept.id }),
      expect.objectContaining({ id: source.id }),
    ]),
  );
  expect(
    (await ensureDeviceIdentityKey(destination.getSnapshot().tomb)).keyId,
  ).toBe(identity.keyId);
});
it.each(["denied", "corrupt"])(
  "does not advance success/pending work for %s provider responses",
  async (refusal) => {
    mode = refusal;
    await expect(syncVaultBackup("github")).rejects.toThrow();
    const result = readLocalBackupTarget("github");
    expect(result?.status).toBe("error");
    expect(result?.lastCommitSha).toBeNull();
    expect(result?.pendingEvents).toBe(2);
  },
);
it("refuses policy withdrawal before credential egress", async () => {
  network.network.mockReturnValue({
    externalServices: "allow",
    allowedServiceOrigins: ["https://other.example"],
  });
  await expect(syncVaultBackup("github")).rejects.toThrow();
  expect(requests).toEqual([]);
});
it("retains a reconfigured target instead of publishing stale success or overwriting it on failure", async () => {
  onWrite = () => {
    const target = readLocalBackupTarget("github");
    if (target)
      writeLocalBackupTarget({ ...target, branch: "different-target" });
  };
  await expect(syncVaultBackup("github")).rejects.toThrow();
  expect(readLocalBackupTarget("github")).toMatchObject({
    branch: "different-target",
    status: "pending",
    pendingEvents: 2,
  });
});
it("holds the original direct fetch across provider awaits", async () => {
  const replacement = vi.fn(async () => {
    throw new Error("Must not adopt replacement transport");
  });
  onWrite = () => vi.stubGlobal("fetch", replacement);
  await expect(syncVaultBackup("github")).resolves.toMatchObject({
    status: "ok",
  });
  expect(replacement).not.toHaveBeenCalled();
});
it("does not record success when the original vault locks after the write", async () => {
  onWrite = () => vaultStore.lock();
  await expect(syncVaultBackup("github")).rejects.toThrow();
  expect(readLocalBackupTarget("github")).toMatchObject({
    status: "error",
    lastCommitSha: null,
    pendingEvents: 2,
  });
});

it.each([
  { label: "missing", body: {} },
  { label: "null", body: null },
  { label: "array", body: [] },
  { label: "abbreviated", body: { commit: { sha: "deadbeef" } } },
  { label: "null object", body: { commit: { sha: "0".repeat(40) } } },
])(
  "keeps previous success and pending work for an actual provider's $label confirmation",
  async ({ body }) => {
    const previous = readLocalBackupTarget("github");
    if (!previous) throw new Error("Missing fixture target");
    writeLocalBackupTarget({
      ...previous,
      status: "ok",
      lastCommitSha: "c".repeat(40),
      lastSyncedAt: "2026-10-23T12:00:00.000Z",
      pendingEvents: 3,
    });
    confirmation = () => body;
    await expect(syncVaultBackup("github")).rejects.toThrow();
    expect(requests.some((request) => request.method === "PUT")).toBe(true);
    expect(readLocalBackupTarget("github")).toMatchObject({
      status: "error",
      lastCommitSha: "c".repeat(40),
      lastSyncedAt: "2026-10-23T12:00:00.000Z",
      pendingEvents: 3,
    });
    expect(readLocalBackupTarget("github")?.lastError).not.toContain(
      "PRIVATE KEY",
    );
  },
);

it.each([40, 64])(
  "refuses null %i-character provider poll IDs",
  async (length) => {
    await syncVaultBackup("github");
    const previous = readLocalBackupTarget("github");
    head = "0".repeat(length);
    await expect(drainBackupWebhooks()).rejects.toThrow();
    expect(readLocalBackupTarget("github")).toEqual(previous);
  },
);
