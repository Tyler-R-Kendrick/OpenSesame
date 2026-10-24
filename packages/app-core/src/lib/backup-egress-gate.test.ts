/** @vitest-environment jsdom */
import { createHash, verify, webcrypto } from "node:crypto";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import type { NetworkPolicy } from "@opensesame/capability-composition";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { backupEgressGate, backupOriginAllowed } from "./backup-egress-gate.js";
import {
  clearLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import {
  getBackupStatus,
  resyncBackup,
  setBackupTargetEnabled,
} from "./backup.js";
import {
  allowGithub,
  openGithubTestOwner,
} from "./github-app-authority.test-support.js";
import {
  credentials,
  keyPair,
  tokenReply,
} from "./github-app-direct.test-support.js";
import {
  forgetLocalGithubApp,
  rememberLocalGithubApp,
} from "./github-app-local.js";
import {
  sealPendingGithubAppSecret,
  stashPendingGithubAppSecret,
} from "./github-app-secret.js";
import {
  stopVaultBackupObserver,
  vaultBackupObserverSeams,
} from "./vault-backup-observer.js";
import { vaultBackupSyncSeams } from "./vault-backup-sync.js";
import { vaultStore } from "./vault/store.js";

const originalSync = { ...vaultBackupSyncSeams };

/** The plan as the gate reads it: git backup running or not, and its network. */
function plan(
  running: boolean,
  externalServices: NetworkPolicy["externalServices"],
  allowedServiceOrigins: string[] = [],
): void {
  vi.spyOn(backupEgressGate, "running").mockReturnValue(running);
  vi.spyOn(backupEgressGate, "network").mockReturnValue({
    externalServices,
    allowedServiceOrigins,
  });
}

function enabledGithubTarget(): void {
  writeLocalBackupTarget({
    kind: "github_app",
    providerId: "github",
    connectionId: null,
    integrationId: "app-1",
    installationId: "777",
    owner: "octo",
    repo: "vault",
    branch: "main",
    enabled: true,
    status: "ready",
    lastCommitSha: null,
    lastSyncedAt: null,
    lastError: null,
    config: null,
    pendingEvents: 0,
  });
}

function stubPush() {
  const putContents = vi.fn(async () => ({ commitSha: "x" }));
  Object.assign(vaultBackupSyncSeams, {
    sealedEnvelopeJson: () => "{}",
    resolveCredentials: () => ({ appId: "1", pem: "pem" }),
    putContents,
  });
  return putContents;
}

type PolicyProviderState = {
  requests: { url: string; method: string; body: string }[];
  errors: unknown[];
  stored: Buffer | null;
  head: string;
};
function policyBlob(bytes: Buffer) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function policyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: PolicyProviderState,
) {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk.toString();
    if (body.length > 1048576) request.destroy();
  });
  request.on("end", () => {
    try {
      const url = request.url ?? "";
      const method = request.method ?? "";
      state.requests.push({ url, method, body });
      response.setHeader("Content-Type", "application/json");
      if (url === "/app/installations/777/access_tokens") {
        const jwt = (request.headers.authorization ?? "")
          .replace(/^Bearer /, "")
          .split(".");
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${jwt[0]}.${jwt[1]}`),
            keyPair.publicKey,
            Buffer.from(jwt[2] ?? "", "base64url"),
          ),
        ).toBe(true);
        expect(JSON.parse(body)).toEqual({
          repositories: ["vault"],
          permissions: { contents: "write", metadata: "read" },
        });
        tokenReply(response);
        return;
      }
      expect(request.headers.authorization).toBe(
        "Bearer ghs_fixture_ephemeral",
      );
      if (method === "PUT") {
        expect(url).toBe(
          "/repos/octo/vault/contents/opensesame-vault.backup.json",
        );
        const value = z
          .object({
            branch: z.literal("main"),
            content: z.string(),
            sha: z.string().optional(),
          })
          .parse(JSON.parse(body));
        if (
          value.sha !== (state.stored ? policyBlob(state.stored) : undefined)
        ) {
          response.writeHead(409);
          response.end("{}");
          return;
        }
        state.stored = Buffer.from(value.content, "base64");
        expect(state.stored.toString("base64")).toBe(value.content);
        expect(JSON.parse(state.stored.toString()).format).toBe(
          "opensesame-offline-backup",
        );
        state.head = createHash("sha1").update(state.stored).digest("hex");
        response.writeHead(201);
        response.end(JSON.stringify({ commit: { sha: state.head } }));
        return;
      }
      expect(method).toBe("GET");
      if (!state.stored || !url.endsWith(`ref=${state.head}`)) {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      response.end(
        JSON.stringify({
          type: "file",
          path: "opensesame-vault.backup.json",
          sha: policyBlob(state.stored),
          encoding: "base64",
          size: state.stored.length,
          content: state.stored.toString("base64"),
        }),
      );
    } catch (error) {
      state.errors.push(error);
      response.writeHead(500);
      response.end("{}");
    }
  });
}

/** Actual provider socket for the direct default; no App authority is mocked. */
async function directPolicyProvider() {
  const state: PolicyProviderState = {
    requests: [],
    errors: [],
    stored: null,
    head: "",
  };
  const server = createServer((request, response) =>
    policyRequest(request, response, state),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const actualFetch = globalThis.fetch;
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    expect(url.origin).toBe("https://api.github.com");
    return actualFetch(
      `http://127.0.0.1:${port}${url.pathname}${url.search}`,
      init,
    );
  });
  return {
    fetch,
    requests: state.requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      expect(state.errors).toEqual([]);
    },
  };
}

describe("git backup's calls hold inside the operator's policy (ADR 0142)", () => {
  afterEach(() => {
    stopVaultBackupObserver();
    clearLocalBackupTarget();
    Object.assign(vaultBackupSyncSeams, originalSync);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a Settings tile reading the status starts nothing while external services are denied", async () => {
    plan(true, "deny");
    enabledGithubTarget();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const interval = vi.spyOn(globalThis, "setInterval");
    await getBackupStatus("github");
    await setBackupTargetEnabled(true, "github");
    expect(interval).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a vault mutation pushes nothing while denied, and a manual sync still does", async () => {
    enabledGithubTarget();
    const putContents = stubPush();
    plan(true, "deny");
    await vaultBackupObserverSeams.runSync("vault");
    await vaultBackupObserverSeams.runSync("webhook");
    expect(putContents).not.toHaveBeenCalled();
    // A person asking for it by hand is not an automatic call.
    await vaultBackupObserverSeams.runSync("manual");
    expect(putContents).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    plan(true, "allow");
    await vaultBackupObserverSeams.runSync("vault");
    expect(putContents).toHaveBeenCalledTimes(2);
  });

  it("withdrawn by the operator, it makes no call at all — a manual one included", async () => {
    enabledGithubTarget();
    const putContents = stubPush();
    plan(false, "allow");
    await vaultBackupObserverSeams.runSync("manual");
    await vaultBackupObserverSeams.runSync("vault");
    expect(putContents).not.toHaveBeenCalled();
    expect(backupOriginAllowed("https://relay.example")).toBe(false);
  });

  it("starts the observer once the plan allows external services", async () => {
    plan(true, "allow");
    enabledGithubTarget();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const interval = vi.spyOn(globalThis, "setInterval");
    await getBackupStatus("github");
    expect(interval).toHaveBeenCalledTimes(1);
  });

  it("a genuine direct manual resync holds the provider allowlist and sends exactly one PUT", async () => {
    configureHost(createTestHost({ locks: webLocksDouble() }));
    vi.stubGlobal("crypto", webcrypto);
    allowGithub();
    await openGithubTestOwner();
    const app = {
      id: credentials.appId,
      key: "github-oauth",
      displayName: "Policy fixture App",
      htmlUrl: null,
      ownerLogin: "octo",
      ownerType: "User",
      installedByLogin: null,
      installations: [{ id: "777", accountLogin: "octo", accountType: "User" }],
    };
    rememberLocalGithubApp(app);
    stashPendingGithubAppSecret(app, credentials.privateKey);
    await sealPendingGithubAppSecret();
    await vaultStore.flushPendingWrites();
    enabledGithubTarget();
    const provider = await directPolicyProvider();
    vi.stubGlobal("fetch", provider.fetch);
    try {
      plan(false, "allow");
      await expect(resyncBackup("github")).rejects.toThrow();
      expect(provider.fetch).not.toHaveBeenCalled();
      expect(provider.requests).toEqual([]);
      plan(true, "allow", ["https://relay.example"]);
      await expect(resyncBackup("github")).rejects.toThrow();
      expect(provider.fetch).not.toHaveBeenCalled();
      expect(provider.requests).toEqual([]);
      plan(true, "allow", ["https://api.github.com"]);
      await expect(resyncBackup("github")).resolves.toBeUndefined();
      expect(
        provider.requests.filter((row) => row.method === "PUT"),
      ).toHaveLength(1);
      expect(provider.requests.map((row) => row.method)).toEqual([
        "POST",
        "GET",
        "PUT",
        "GET",
      ]);
      expect(
        provider.fetch.mock.calls.every(
          ([url]) => new URL(String(url)).origin === "https://api.github.com",
        ),
      ).toBe(true);
      expect(JSON.stringify(provider.requests)).not.toContain("PRIVATE KEY");
    } finally {
      forgetLocalGithubApp();
      await vaultStore.flushPendingWrites();
      vaultStore.lock();
      await provider.close();
    }
  });

  it("a non-empty allowedServiceOrigins is an allowlist for every backup call", () => {
    plan(true, "allow", ["https://relay.example"]);
    expect(
      backupOriginAllowed("https://relay.example/api/git-backup/put"),
    ).toBe(true);
    expect(backupOriginAllowed("https://elsewhere.example/api")).toBe(false);
    expect(backupOriginAllowed("not a url")).toBe(false);
    vi.restoreAllMocks();
    plan(true, "allow", []);
    expect(backupOriginAllowed("https://elsewhere.example/api")).toBe(true);
  });
});
