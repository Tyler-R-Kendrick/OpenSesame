/** Direct App repository setup: original vault/lease/key, ephemeral tokens and bounded REST. */
import { type JsonObject, canonicalize } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type GithubDirectTransport,
  githubApiJson,
  githubRepositoryName,
} from "./github-app-direct.js";
import { pemFromVault, readLocalGithubApp } from "./github-app-local.js";
import {
  GithubDirectError,
  assertGithubCurrent,
  signGithubAppJwt,
} from "./github-app-signing.js";
import { captureGithubAuthority } from "./github-app-vault-transport.js";

export type GithubRepositoryOutcome = {
  ok: boolean;
  status: number;
  payload: JsonObject;
};

type Install = { id: string; accountLogin: string; accountType: string };
type Credentials = { appId: string; pem: string };
const credentials = z.object({
  appId: z.string().min(1).max(128),
  pem: z.string().min(1).max(65536),
});
const repo = z.object({
  id: z.number().int().positive().safe(),
  name: z.string().min(1).max(100),
  full_name: z.string().min(3).max(150),
  private: z.boolean(),
  default_branch: z.string().min(1).max(255),
  owner: z.object({ login: z.string().min(1).max(39) }),
  archived: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
function fail(): never {
  throw new GithubDirectError(
    "response",
    "GitHub returned an unexpected repository response.",
  );
}
function capture(input: Credentials) {
  const app = readLocalGithubApp();
  if (
    !app ||
    app.id !== input.appId ||
    pemFromVault(app) !== input.pem ||
    app.installations.length > 100
  )
    fail();
  const receipt = canonicalize({ ...app });
  const installs = app.installations.map((row) => ({ ...row }));
  const operation = captureGithubAuthority({
    binding: () => {
      const current = readLocalGithubApp();
      return (
        current !== null &&
        canonicalize({ ...current }) === receipt &&
        pemFromVault(current) === input.pem
      );
    },
  });
  const originalFetch = globalThis.fetch;
  const transport: GithubDirectTransport = {
    signal: operation.transport.signal,
    assertCurrent: operation.transport.assertCurrent,
    fetch: (input, init) => {
      operation.transport.assertCurrent();
      return originalFetch.call(globalThis, input, init);
    },
  };
  return {
    transport,
    installs,
    credentials: { ...input },
    close: operation.close,
  };
}
type Owner = ReturnType<typeof capture>;
function installationId(install: Install) {
  if (
    !/^[1-9]\d*$/.test(install.id) ||
    !Number.isSafeInteger(Number(install.id))
  )
    fail();
  return Number(install.id);
}
async function token(
  owner: Owner,
  install: Install,
  create: boolean,
): Promise<string> {
  const assertion = await signGithubAppJwt(
    owner.credentials.appId,
    owner.credentials.pem,
    owner.transport,
  );
  const permissions: JsonObject = { metadata: "read" };
  if (create) permissions.administration = "write";
  const value = await githubApiJson(
    owner.transport,
    `/app/installations/${installationId(install)}/access_tokens`,
    {
      method: "POST",
      token: assertion,
      body: { permissions },
    },
  );
  const result = z
    .object({
      token: z.string().min(1).max(4096),
      expires_at: z.string().datetime(),
    })
    .safeParse(value);
  if (!result.success || Date.parse(result.data.expires_at) <= Date.now())
    fail();
  assertGithubCurrent(owner.transport);
  return result.data.token;
}
function summary(value: z.infer<typeof repo>, install: Install): JsonObject {
  if (
    value.owner.login.toLowerCase() !== install.accountLogin.toLowerCase() ||
    value.full_name.toLowerCase() !==
      `${value.owner.login}/${value.name}`.toLowerCase() ||
    value.archived ||
    value.disabled
  )
    fail();
  githubRepositoryName(value.name);
  return {
    fullName: value.full_name,
    name: value.name,
    private: value.private,
    defaultBranch: value.default_branch,
    installationId: install.id,
    accountLogin: install.accountLogin,
    accountType: install.accountType,
  };
}
async function installedRepositories(owner: Owner, install: Install) {
  const accessToken = await token(owner, install, false);
  const rows: JsonObject[] = [];
  let seen = 0;
  for (let page = 1; page <= 10; page++) {
    const value = await githubApiJson(
      owner.transport,
      `/installation/repositories?per_page=100&page=${page}`,
      { method: "GET", token: accessToken },
    );
    const result = z
      .object({
        total_count: z.number().int().nonnegative().safe(),
        repositories: z.array(repo).max(100),
      })
      .safeParse(value);
    if (!result.success) fail();
    for (const item of result.data.repositories) {
      if (item.archived || item.disabled) continue;
      const mapped = summary(item, install);
      if (item.private) rows.push(mapped);
    }
    seen += result.data.repositories.length;
    if (seen > result.data.total_count) fail();
    if (seen === result.data.total_count) return rows;
    if (result.data.repositories.length < 100) fail();
  }
  throw new GithubDirectError(
    "response",
    "GitHub returned too many repositories to list in this operation.",
  );
}
async function list(owner: Owner): Promise<JsonObject> {
  const rows: JsonObject[] = [];
  let error: string | null = null;
  for (const install of owner.installs) {
    try {
      rows.push(...(await installedRepositories(owner, install)));
    } catch {
      assertGithubCurrent(owner.transport);
      error = "GitHub could not list every installation's repositories.";
    }
  }
  return { repositories: rows, error };
}
const createInput = z.object({
  installationId: z.string(),
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  name: z.string().min(1).max(100),
  accountType: z.string(),
});
async function creationInstallation(
  owner: Owner,
  input: z.infer<typeof createInput>,
) {
  const install = owner.installs.find((row) => row.id === input.installationId);
  if (
    !install ||
    install.accountLogin.toLowerCase() !== input.owner.toLowerCase()
  )
    fail();
  const assertion = await signGithubAppJwt(
    owner.credentials.appId,
    owner.credentials.pem,
    owner.transport,
  );
  const record = z
    .object({
      id: z.number().int().positive().safe(),
      account: z.object({
        login: z.string(),
        type: z.enum(["User", "Organization"]),
      }),
    })
    .safeParse(
      await githubApiJson(
        owner.transport,
        `/app/installations/${installationId(install)}`,
        { method: "GET", token: assertion },
      ),
    );
  if (
    !record.success ||
    record.data.id !== installationId(install) ||
    record.data.account.login.toLowerCase() !== input.owner.toLowerCase() ||
    (input.accountType && input.accountType !== record.data.account.type)
  )
    fail();
  return { install, accountType: record.data.account.type };
}
async function create(
  owner: Owner,
  input: z.infer<typeof createInput>,
): Promise<JsonObject> {
  githubRepositoryName(input.name);
  const { install, accountType } = await creationInstallation(owner, input);
  const accessToken = await token(owner, install, true);
  const path =
    accountType === "Organization"
      ? `/orgs/${encodeURIComponent(input.owner)}/repos`
      : "/user/repos";
  const created = repo.safeParse(
    await githubApiJson(owner.transport, path, {
      method: "POST",
      token: accessToken,
      body: { name: input.name, private: true, auto_init: true },
    }),
  );
  if (
    !created.success ||
    !created.data.private ||
    created.data.name !== input.name
  )
    fail();
  summary(created.data, install);
  const verified = repo.safeParse(
    await githubApiJson(
      owner.transport,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}`,
      { method: "GET", token: accessToken },
    ),
  );
  if (
    !verified.success ||
    verified.data.id !== created.data.id ||
    !verified.data.private ||
    verified.data.name !== input.name ||
    verified.data.default_branch !== created.data.default_branch
  )
    fail();
  assertGithubCurrent(owner.transport);
  return {
    repository: summary(verified.data, {
      ...install,
      accountType,
    }),
  };
}

/** Legacy operation-port names remain for view fixtures; no relative URL is ever fetched. */
export async function directGithubAppRepositoryRequest(
  path: string,
  body: JsonObject,
): Promise<GithubRepositoryOutcome> {
  let owner: Owner | null = null;
  try {
    const input = credentials.parse(body);
    owner = capture(input);
    const payload =
      path === "/api/github-app/installation-repos"
        ? await list(owner)
        : path === "/api/github-app/create-repo"
          ? await create(owner, createInput.parse(body))
          : fail();
    assertGithubCurrent(owner.transport);
    return { ok: true, status: 200, payload };
  } catch (error) {
    return {
      ok: false,
      status:
        error instanceof GithubDirectError && error.code === "authorization"
          ? 403
          : 502,
      payload: {
        message:
          error instanceof GithubDirectError
            ? error.message
            : "The GitHub repository operation did not complete.",
      },
    };
  } finally {
    owner?.close();
  }
}
