/** @vitest-environment jsdom */
import { createHash, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import type { JsonValue } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { z } from "zod";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import {
  clearLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import {
  allowGithub,
  openGithubTestOwner,
} from "./github-app-authority.test-support.js";
import {
  githubBackupDiscoveryReply,
  verifyBackupAppAssertion,
} from "./github-app-backup-discovery.test-support.js";
import { credentials } from "./github-app-direct.test-support.js";
import {
  forgetLocalGithubApp,
  rememberLocalGithubApp,
} from "./github-app-local.js";
import {
  sealPendingGithubAppSecret,
  stashPendingGithubAppSecret,
} from "./github-app-secret.js";
import { setActiveProject } from "./projects.js";
import { type VaultStore, vaultStore } from "./vault/store.js";

const actualFetch = globalThis.fetch;
const appTemplate = {
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
let app = appTemplate;
let branch = "backup/primary";
type FixtureOptions = { appId?: string; branch?: string };
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
let heldWrite: { seen: () => void; gate: Promise<void> } | null = null;
let releaseWrite: (() => void) | null = null;
let network: ReturnType<typeof allowGithub>;
const snapshots = new Map<string, Buffer>();
const requests: { path: string; method: string; body: string }[] = [];
const errors: unknown[] = [];
const outcomes: { path: string; method: string; status: number }[] = [];
const destinations: VaultStore[] = [];
function blob(bytes: Buffer) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
type ProviderReply = { status: number; value: JsonValue };
const TOKENS = {
  read: "ghs_owned_backup_read_token",
  write: "ghs_owned_backup_token",
} as const;
/** One repository's contents, read for a read and write only for a write. */
function backupGrant(input: { permissions?: { contents?: unknown } }) {
  const access = input.permissions?.contents;
  if (access !== "read" && access !== "write")
    throw new Error(`Unexpected Contents access: ${String(access)}`);
  expect(input).toEqual({
    repositories: ["backups"],
    permissions: { contents: access, metadata: "read" },
  });
  return TOKENS[access];
}
function reply(
  path: string,
  method: string,
  authorization: string,
  body: string,
): ProviderReply {
  const discovery = githubBackupDiscoveryReply(
    path,
    method,
    authorization,
    app,
    branch,
    mode === "denied",
  );
  if (discovery) return discovery;
  if (path === "/app/installations/77/access_tokens") {
    expect(method).toBe("POST");
    if (mode === "denied") return { status: 403, value: {} };
    verifyBackupAppAssertion(authorization, app.id);
    const input = JSON.parse(body);
    if (
      JSON.stringify(input) ===
      JSON.stringify({ permissions: { metadata: "read" } })
    )
      return {
        status: 201,
        value: {
          token: "ghs_owned_repository_token",
          expires_at: new Date(Date.now() + 600000).toISOString(),
        },
      };
    return {
      status: 201,
      value: {
        token: backupGrant(input),
        expires_at: new Date(Date.now() + 600000).toISOString(),
      },
    };
  }
  // A read token reads; only the write token may put the backup.
  expect([`Bearer ${TOKENS.read}`, `Bearer ${TOKENS.write}`]).toContain(
    authorization,
  );
  if (path === `${base}/git/ref/heads/${branch}`)
    return {
      status: 200,
      value: {
        ref: `refs/heads/${branch}`,
        object: { type: "commit", sha: head },
      },
    };
  if (method === "PUT") {
    expect(authorization).toBe(`Bearer ${TOKENS.write}`);
    expect(path).toBe(`${base}/contents/opensesame-vault.backup.json`);
    const input = JSON.parse(body);
    expect(input.branch).toBe(branch);
    if (input.sha !== (contents ? blob(contents) : undefined))
      return {
        status: 409,
        value: { message: "Conditional backup SHA changed" },
      };
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
  const bytes = revision === branch ? contents : snapshots.get(revision);
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
async function setupGithubBackupProvider(options: FixtureOptions) {
  app = { ...appTemplate, id: options.appId ?? appTemplate.id };
  branch = options.branch ?? "backup/primary";
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
    branch,
    enabled: true,
    status: "pending",
    lastCommitSha: null,
    lastSyncedAt: null,
    lastError: null,
    config: null,
    pendingEvents: 2,
  });
  heldWrite = null;
  releaseWrite = null;
  contents = null;
  head = "a".repeat(40);
  count = 0;
  mode = "normal";
  onWrite = () => {};
  confirmation = () => ({ commit: { sha: head } });
  snapshots.clear();
  requests.length = 0;
  errors.length = 0;
  outcomes.length = 0;
  await startGithubBackupServer();
}
async function startGithubBackupServer() {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1048576) request.destroy();
    });
    request.on("end", async () => {
      try {
        const path = request.url ?? "";
        const method = request.method ?? "";
        requests.push({ path, method, body });
        if (method === "PUT" && heldWrite) {
          const held = heldWrite;
          heldWrite = null;
          held.seen();
          await held.gate;
        }
        const result = reply(
          path,
          method,
          request.headers.authorization ?? "",
          body,
        );
        outcomes.push({ path, method, status: result.status });
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
}
async function closeGithubBackupProvider() {
  releaseWrite?.();
  heldWrite = null;
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
}

/** Register actual source vault, sealed App key, independent RSA and HTTP provider fixture. */
export function useGithubBackupProviderFixture(options: FixtureOptions = {}) {
  beforeEach(() => setupGithubBackupProvider(options));
  afterEach(closeGithubBackupProvider);
  return {
    get app() {
      return app;
    },
    requests,
    outcomes,
    destinations,
    get source() {
      return source;
    },
    get contents() {
      return contents;
    },
    get network() {
      return network;
    },
    get head() {
      return head;
    },
    set head(value: string) {
      head = value;
    },
    set mode(value: string) {
      mode = value;
    },
    set onWrite(value: () => void) {
      onWrite = value;
    },
    set confirmation(value: () => JsonValue) {
      confirmation = value;
    },
    holdNextWrite() {
      if (heldWrite || releaseWrite)
        throw new Error("Provider write already held");
      let seen = () => {};
      const arrived = new Promise<void>((resolve) => {
        seen = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      heldWrite = { seen, gate };
      return {
        arrived,
        release: () => {
          releaseWrite?.();
          releaseWrite = null;
        },
      };
    },
  };
}
