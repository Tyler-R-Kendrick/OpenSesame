/** @vitest-environment jsdom */
import { verify, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import type { JsonValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
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
  createGithubAppRepo,
  listGithubAppInstallationRepos,
} from "./github-app-repos.js";
import {
  sealPendingGithubAppSecret,
  stashPendingGithubAppSecret,
} from "./github-app-secret.js";
import { vaultStore } from "./vault/store.js";

const app = {
  id: credentials.appId,
  key: "github-oauth",
  displayName: "Repository fixture App",
  htmlUrl: null,
  ownerLogin: "fixture-owner",
  ownerType: "User",
  installedByLogin: null,
  installations: [
    { id: "77", accountLogin: "fixture-owner", accountType: "User" },
    { id: "88", accountLogin: "fixture-org", accountType: "Organization" },
  ],
};
const actualFetch = globalThis.fetch;
let server: ReturnType<typeof createServer>;
let port = 0;
let mode = "normal";
let total = 120;
let onRequest = (_path: string) => {};
let created: ReturnType<typeof repository> | null;
const tokens = new Map<string, { id: string; create: boolean }>();
const requests: { path: string; method: string; body: string }[] = [];
const errors: unknown[] = [];
function repository(
  name: string,
  id: number,
  owner = "fixture-owner",
  privateRepo = true,
) {
  return {
    id,
    name,
    full_name: `${owner}/${name}`,
    private: privateRepo,
    default_branch: "main",
    owner: { login: owner },
    archived: false,
    disabled: false,
  };
}
function assertion(header: string) {
  const parts = header.replace(/^Bearer /, "").split(".");
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      keyPair.publicKey,
      Buffer.from(parts[2] ?? "", "base64url"),
    ),
  ).toBe(true);
  expect(
    JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString()).iss,
  ).toBe(app.id);
}
type FixtureReply = { status: number; value: JsonValue };

function installationReply(
  install: RegExpMatchArray,
  header: string,
  body: string,
): FixtureReply {
  assertion(header);
  if (mode === "denied" || (mode === "partial" && install[1] === "88"))
    return { status: 403, value: { message: credentials.privateKey } };
  if (!install[2])
    return {
      status: 200,
      value: {
        id: Number(install[1]),
        account: {
          login: install[1] === "77" ? "fixture-owner" : "fixture-org",
          type: install[1] === "77" ? "User" : "Organization",
        },
      },
    };
  const input = z
    .object({
      permissions: z.object({
        metadata: z.literal("read"),
        administration: z.literal("write").optional(),
      }),
    })
    .strict()
    .parse(JSON.parse(body));
  const token = `ghs_fixture_${install[1]}_${input.permissions.administration ? "create" : "read"}`;
  tokens.set(token, {
    id: install[1] ?? "",
    create: input.permissions.administration === "write",
  });
  return {
    status: 201,
    value: { token, expires_at: new Date(Date.now() + 600000).toISOString() },
  };
}
function reply(
  path: string,
  method: string,
  header: string,
  body: string,
): FixtureReply {
  const install = path.match(
    /^\/app\/installations\/(77|88)(\/access_tokens)?$/,
  );
  if (install) return installationReply(install, header, body);
  const grant = tokens.get(header.replace(/^Bearer /, ""));
  if (!grant) throw new Error("Unknown fixture grant");
  const url = new URL(path, "https://api.github.com");
  if (url.pathname === "/installation/repositories") {
    expect(grant.create).toBe(false);
    expect(url.searchParams.get("per_page")).toBe("100");
    const page = Number(url.searchParams.get("page"));
    const owner = grant.id === "77" ? "fixture-owner" : "fixture-org";
    const count = grant.id === "77" ? total : 0;
    const rows = Array.from(
      { length: Math.max(0, Math.min(100, count - (page - 1) * 100)) },
      (_, index) =>
        repository(
          `repo-${(page - 1) * 100 + index + 1}`,
          (page - 1) * 100 + index + 1,
          owner,
          mode !== "public" || index !== 0,
        ),
    );
    return { status: 200, value: { total_count: count, repositories: rows } };
  }
  if (method === "POST") {
    expect(grant.create).toBe(true);
    const input = z
      .object({
        name: z.string(),
        private: z.literal(true),
        auto_init: z.literal(true),
      })
      .strict()
      .parse(JSON.parse(body));
    expect(path).toBe(
      grant.id === "77" ? "/user/repos" : "/orgs/fixture-org/repos",
    );
    created = repository(
      input.name,
      9001,
      grant.id === "77" ? "fixture-owner" : "fixture-org",
      mode !== "public-create",
    );
    if (mode === "wrong-owner") created.owner.login = "foreign-owner";
    return { status: 201, value: created };
  }
  if (!created) throw new Error("No created repository");
  expect(path).toBe(`/repos/${created.full_name}`);
  return {
    status: 200,
    value: mode === "changed-id" ? { ...created, id: created.id + 1 } : created,
  };
}
beforeEach(async () => {
  configureHost(createTestHost({ locks: webLocksDouble() }));
  vi.stubGlobal("crypto", webcrypto);
  allowGithub();
  await openGithubTestOwner();
  rememberLocalGithubApp(app);
  stashPendingGithubAppSecret(app, credentials.privateKey);
  await sealPendingGithubAppSecret();
  mode = "normal";
  total = 120;
  created = null;
  onRequest = () => {};
  tokens.clear();
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
        onRequest(path);
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
  port = z.object({ port: z.number() }).parse(server.address()).port;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    expect(url.origin).toBe("https://api.github.com");
    return actualFetch(
      `http://127.0.0.1:${port}${url.pathname}${url.search}`,
      init,
    );
  });
});
afterEach(async () => {
  forgetLocalGithubApp();
  await vaultStore.flushPendingWrites();
  vaultStore.lock();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  expect(errors).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("lists all120 actual private repositories across native pages without PEM or relay calls", async () => {
  const value = await listGithubAppInstallationRepos();
  expect(value.error).toBeNull();
  expect(value.repositories).toHaveLength(120);
  expect(value.repositories[119]?.fullName).toBe("fixture-owner/repo-120");
  expect(
    requests
      .filter((row) => row.path.startsWith("/installation/repositories"))
      .map((row) => row.path),
  ).toEqual([
    "/installation/repositories?per_page=100&page=1",
    "/installation/repositories?per_page=100&page=2",
    "/installation/repositories?per_page=100&page=1",
  ]);
  expect(JSON.stringify(requests)).not.toContain("PRIVATE KEY");
  expect(requests.every((row) => !row.path.startsWith("/api/github-app"))).toBe(
    true,
  );
});
it("filters real public results without replacing a partial failure by empty success", async () => {
  mode = "public";
  const filtered = await listGithubAppInstallationRepos();
  expect(filtered.repositories).toHaveLength(118);
  mode = "partial";
  const partial = await listGithubAppInstallationRepos();
  expect(partial.repositories).toHaveLength(120);
  expect(partial.error).not.toBeNull();
  expect(partial.error).not.toContain("PRIVATE KEY");
});
it.each([
  { id: "77", owner: "fixture-owner", type: "User", path: "/user/repos" },
  {
    id: "88",
    owner: "fixture-org",
    type: "Organization",
    path: "/orgs/fixture-org/repos",
  },
])(
  "creates and reads back a usable initialized private repo for $type directly",
  async (account) => {
    const value = await createGithubAppRepo({
      installationId: account.id,
      owner: account.owner,
      accountType: account.type,
      name: "vault-backup",
    });
    expect(value).toMatchObject({
      fullName: `${account.owner}/vault-backup`,
      private: true,
      defaultBranch: "main",
      installationId: account.id,
    });
    expect(requests.map((row) => row.path)).toEqual([
      `/app/installations/${account.id}`,
      `/app/installations/${account.id}/access_tokens`,
      account.path,
      `/repos/${account.owner}/vault-backup`,
    ]);
    expect(JSON.stringify(requests)).not.toContain("PRIVATE KEY");
  },
);
it.each(["denied", "public-create", "wrong-owner", "changed-id"])(
  "does not bind an unverified provider repo: %s",
  async (refusal) => {
    mode = refusal;
    await expect(
      createGithubAppRepo({
        installationId: "77",
        owner: "fixture-owner",
        accountType: "User",
        name: "vault-backup",
      }),
    ).rejects.toThrow();
  },
);
it("keeps one original owner through pagination and adopts no replacement fetch", async () => {
  const replacement = vi.fn(async () => {
    throw new Error("Do not adopt this transport");
  });
  onRequest = (path) => {
    if (path.includes("page=1")) vi.stubGlobal("fetch", replacement);
  };
  expect((await listGithubAppInstallationRepos()).repositories).toHaveLength(
    120,
  );
  expect(replacement).not.toHaveBeenCalled();
});
it("stops before another provider call if the original App key is removed during token retrieval", async () => {
  onRequest = () => forgetLocalGithubApp();
  const result = await listGithubAppInstallationRepos();
  expect(result.repositories).toEqual([]);
  expect(result.error).not.toBeNull();
  expect(requests).toHaveLength(1);
});
it("rejects owner substitution before any creation request", async () => {
  await expect(
    createGithubAppRepo({
      installationId: "77",
      owner: "foreign-owner",
      accountType: "User",
      name: "vault-backup",
    }),
  ).rejects.toThrow();
  expect(requests).toEqual([]);
});

it("does not expose an unusable empty list as success when the bounded native pagination is exhausted", async () => {
  total = 1001;
  const result = await listGithubAppInstallationRepos();
  expect(result.error).not.toBeNull();
  expect(
    requests.filter((row) => row.path.includes("/installation/repositories")),
  ).toHaveLength(11);
});
it("makes no repository call after the actual owning vault locks", async () => {
  vaultStore.lock();
  const result = await listGithubAppInstallationRepos();
  expect(result.error).toMatch(/Unlock/u);
  expect(requests).toEqual([]);
});
