/**
 * List and create repositories through a GitHub App installation token.
 * PEM is used once per request and never stored.
 */
import {
  API,
  API_VERSION,
  UA,
  json,
  mintInstallationToken,
  readCredentials,
} from "./github-app-contents-shared.mjs";
import { githubAppCorsHeaders, mintGithubAppJwt } from "./github-app.mjs";

function readStringField(body, key) {
  return body && typeof body[key] === "string" ? body[key].trim() : "";
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function statusOr502(status) {
  return status >= 400 && status < 600 ? status : 502;
}

function corsGate(origin) {
  const cors = githubAppCorsHeaders(origin);
  if (origin && !cors["access-control-allow-origin"]) {
    return { forbidden: json(403, { error: "origin_not_allowed" }) };
  }
  return { cors };
}

async function mintInstallationTokenWithPermissions(creds, fetchImpl, permissions) {
  const jwt = mintGithubAppJwt(creds.appId, creds.pem);
  const response = await fetchImpl(
    `${API}/app/installations/${creds.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": UA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permissions }),
    },
  );
  const payload = parseJsonText(await response.text());
  if (!payload) throw Object.assign(new Error("installation_token_malformed"), { status: 502 });
  if (!response.ok || typeof payload.token !== "string") {
    throw Object.assign(
      new Error(
        typeof payload.message === "string"
          ? payload.message
          : "installation_token_failed",
      ),
      { status: response.status },
    );
  }
  return payload.token;
}

/** List repos: metadata is enough; do not demand administration. */
export async function mintListInstallationToken(creds, fetchImpl) {
  return mintInstallationTokenWithPermissions(creds, fetchImpl, {
    contents: "read",
    metadata: "read",
  });
}

/** Create repos: needs administration where the App was granted it. */
export async function mintWideInstallationToken(creds, fetchImpl) {
  return mintInstallationTokenWithPermissions(creds, fetchImpl, {
    contents: "write",
    metadata: "read",
    administration: "write",
  });
}

async function tokenOrError(creds, fetchImpl, cors, mint = mintWideInstallationToken) {
  try {
    return { token: await mint(creds, fetchImpl) };
  } catch (error) {
    const status =
      error && typeof error.status === "number" && error.status >= 400
        ? error.status
        : 502;
    return {
      error: json(
        status,
        {
          error: "token_failed",
          message: error instanceof Error ? error.message : "token failed",
        },
        cors,
      ),
    };
  }
}

function mapRepo(row) {
  if (!row || typeof row !== "object") return null;
  const fullName =
    typeof row.full_name === "string" ? row.full_name.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!fullName || !name) return null;
  return {
    fullName,
    name,
    private: Boolean(row.private),
    defaultBranch:
      typeof row.default_branch === "string" && row.default_branch
        ? row.default_branch
        : "main",
  };
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": UA,
  };
}

async function fetchInstallationRepoPage(token, page, fetchImpl, cors) {
  const response = await fetchImpl(
    `${API}/installation/repositories?per_page=100&page=${page}`,
    { headers: githubHeaders(token) },
  );
  const payload = parseJsonText(await response.text());
  if (!payload) return { error: json(502, { error: "upstream_malformed" }, cors) };
  if (!response.ok) {
    return {
      error: json(statusOr502(response.status), {
        error: "list_failed",
        message:
          typeof payload.message === "string"
            ? payload.message
            : `GitHub returned ${response.status}`,
      }, cors),
    };
  }
  const rows = Array.isArray(payload.repositories) ? payload.repositories : [];
  return { rows };
}

async function listInstallationRepositories(token, fetchImpl, cors) {
  const repositories = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await fetchInstallationRepoPage(token, page, fetchImpl, cors);
    if (result.error) return result;
    for (const row of result.rows) {
      const mapped = mapRepo(row);
      if (mapped) repositories.push(mapped);
    }
    if (result.rows.length < 100) break;
  }
  return { repositories };
}

/**
 * Body: `{ appId, pem, installationId }`.
 * Returns `{ repositories: [{ fullName, name, private, defaultBranch }] }`.
 */
export async function handleGithubAppInstallationRepos(
  body,
  origin,
  fetchImpl = fetch,
) {
  const gate = corsGate(origin);
  if (gate.forbidden) return gate.forbidden;
  const creds = readCredentials(body);
  if (!creds) return json(400, { error: "missing_credentials" }, gate.cors);
  const minted = await tokenOrError(
    creds,
    fetchImpl,
    gate.cors,
    mintListInstallationToken,
  );
  if (minted.error) return minted.error;
  const listed = await listInstallationRepositories(
    minted.token,
    fetchImpl,
    gate.cors,
  );
  if (listed.error) return listed.error;
  return json(200, { repositories: listed.repositories }, gate.cors);
}

function isValidRepoName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(name) && !name.endsWith(".");
}

function createRepoUrl(owner, accountType) {
  const kind = accountType.toLowerCase();
  if (kind === "organization" || kind === "org") {
    return `${API}/orgs/${encodeURIComponent(owner)}/repos`;
  }
  return `${API}/user/repos`;
}

async function postCreateRepo(token, url, name, isPrivate, fetchImpl, cors) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      private: isPrivate,
      auto_init: true,
      description: "OpenSesame sealed vault backup",
    }),
  });
  const payload = parseJsonText(await response.text());
  if (!payload) return { error: json(502, { error: "upstream_malformed" }, cors) };
  if (!response.ok) {
    return {
      error: json(statusOr502(response.status), {
        error: "create_failed",
        message:
          typeof payload.message === "string"
            ? payload.message
            : `GitHub returned ${response.status}`,
      }, cors),
    };
  }
  const mapped = mapRepo(payload);
  if (!mapped) return { error: json(502, { error: "upstream_malformed" }, cors) };
  return { repository: mapped };
}

/**
 * Body: `{ appId, pem, installationId, owner, name, private?, accountType? }`.
 * Creates under the install account (user or org).
 */
export async function handleGithubAppCreateRepo(
  body,
  origin,
  fetchImpl = fetch,
) {
  const gate = corsGate(origin);
  if (gate.forbidden) return gate.forbidden;
  const creds = readCredentials(body);
  const owner = readStringField(body, "owner");
  const name = readStringField(body, "name");
  const accountType = readStringField(body, "accountType");
  const isPrivate = body?.private !== false;
  if (!creds || !owner || !name) {
    return json(400, { error: "missing_fields" }, gate.cors);
  }
  if (!isValidRepoName(name)) {
    return json(400, { error: "invalid_name" }, gate.cors);
  }
  const minted = await tokenOrError(creds, fetchImpl, gate.cors);
  if (minted.error) return minted.error;
  const created = await postCreateRepo(
    minted.token,
    createRepoUrl(owner, accountType),
    name,
    isPrivate,
    fetchImpl,
    gate.cors,
  );
  if (created.error) return created.error;
  return json(200, { repository: created.repository }, gate.cors);
}

// Re-export for put-contents callers that share the attenuated mint.
export { mintInstallationToken };
