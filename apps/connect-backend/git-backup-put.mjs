/**
 * Forge-agnostic vault ciphertext upsert via the Connect relay.
 * Body: `{ forge, token, owner, repo, branch?, contentBase64, message?,
 *         username?, baseUrl? }` where forge is
 * gitlab|bitbucket|codeberg|origin|gitea. A `gitea` `baseUrl` must be a bare
 * public https origin (`forge-host-guard.mjs`); forge requests never follow
 * redirects.
 */

import { corsOrigin } from "./allowlist.mjs";
import { giteaBaseAllowed } from "./forge-host-guard.mjs";

const UA = "OpenSesame-ConnectRelay/1";
const BACKUP_PATH = "opensesame-vault.backup.json";
const FORGES = new Set(["gitlab", "bitbucket", "codeberg", "origin", "gitea"]);

function json(status, body, extraHeaders = {}) {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function corsHeaders(origin) {
  const allowed = corsOrigin(origin);
  if (!allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "access-control-max-age": "86400",
  };
}

function projectPath(owner, repo) {
  return `${owner}/${repo}`;
}

async function putGitlab(input, fetchImpl) {
  const id = encodeURIComponent(projectPath(input.owner, input.repo));
  const file = encodeURIComponent(input.path);
  const url = `https://gitlab.com/api/v4/projects/${id}/repository/files/${file}`;
  const headers = {
    "PRIVATE-TOKEN": input.token,
    "Content-Type": "application/json",
    "User-Agent": UA,
  };
  const existing = await fetchImpl(
    `${url}?ref=${encodeURIComponent(input.branch)}`,
    { headers },
  );
  const method = existing.ok ? "PUT" : "POST";
  const response = await fetchImpl(url, {
    method,
    headers,
    body: JSON.stringify({
      branch: input.branch,
      content: Buffer.from(input.contentBase64, "base64").toString("utf8"),
      commit_message: input.message,
      encoding: "text",
    }),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        typeof payload.message === "string"
          ? payload.message
          : `GitLab returned ${response.status}`,
    };
  }
  return {
    ok: true,
    commitSha:
      typeof payload.commit_id === "string"
        ? payload.commit_id
        : typeof payload.blob_id === "string"
          ? payload.blob_id
          : null,
  };
}

async function putBitbucket(input, fetchImpl) {
  const url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/src`;
  const auth = Buffer.from(
    `${input.username || "x-token-auth"}:${input.token}`,
  ).toString("base64");
  const body = new URLSearchParams();
  body.set(
    input.path,
    Buffer.from(input.contentBase64, "base64").toString("utf8"),
  );
  body.set("message", input.message);
  body.set("branch", input.branch);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `Bitbucket returned ${response.status}`;
    try {
      const payload = JSON.parse(text);
      if (typeof payload.error?.message === "string") {
        message = payload.error.message;
      }
    } catch {
      // keep status message
    }
    return { ok: false, status: response.status, message };
  }
  return { ok: true, commitSha: null };
}

async function putGiteaStyle(base, input, fetchImpl) {
  const path = input.path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `${base}/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${path}`;
  const headers = {
    Authorization: `token ${input.token}`,
    "Content-Type": "application/json",
    "User-Agent": UA,
    Accept: "application/json",
  };
  let sha = null;
  const existing = await fetchImpl(
    `${url}?ref=${encodeURIComponent(input.branch)}`,
    { headers, redirect: "error" },
  );
  if (existing.ok) {
    try {
      const row = JSON.parse(await existing.text());
      if (row && typeof row.sha === "string") sha = row.sha;
    } catch {
      // create
    }
  }
  const putBody = {
    message: input.message,
    content: input.contentBase64,
    branch: input.branch,
  };
  if (sha) putBody.sha = sha;
  const response = await fetchImpl(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(putBody),
    redirect: "error",
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        typeof payload.message === "string"
          ? payload.message
          : `Forge returned ${response.status}`,
    };
  }
  const commitSha =
    payload.commit && typeof payload.commit.sha === "string"
      ? payload.commit.sha
      : null;
  return { ok: true, commitSha };
}

async function putOrigin(input, fetchImpl) {
  // Cursor Origin mirrors GitHub Contents under /v1/origin.
  const path = input.path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `https://api.cursor.com/v1/origin/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${input.token}`,
    "Content-Type": "application/json",
    "User-Agent": UA,
    Accept: "application/json",
  };
  let sha = null;
  const existing = await fetchImpl(
    `${url}?ref=${encodeURIComponent(input.branch)}`,
    { headers },
  );
  if (existing.ok) {
    try {
      const row = JSON.parse(await existing.text());
      if (row && typeof row.sha === "string") sha = row.sha;
    } catch {
      // create
    }
  }
  const putBody = {
    message: input.message,
    content: input.contentBase64,
    branch: input.branch,
  };
  if (sha) putBody.sha = sha;
  const response = await fetchImpl(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(putBody),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        typeof payload.message === "string"
          ? payload.message
          : `Origin returned ${response.status}`,
    };
  }
  const commitSha =
    payload.commit && typeof payload.commit.sha === "string"
      ? payload.commit.sha
      : null;
  return { ok: true, commitSha };
}

/**
 * Upsert sealed vault ciphertext on a forge remote.
 */

async function putForForge(forge, body, input, deps) {
  const { fetchImpl, lookup } = deps;
  if (forge === "gitlab") return putGitlab(input, fetchImpl);
  if (forge === "bitbucket") return putBitbucket(input, fetchImpl);
  if (forge === "codeberg") {
    return putGiteaStyle("https://codeberg.org", input, fetchImpl);
  }
  if (forge === "gitea") {
    const baseUrl =
      body && typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    if (!baseUrl) {
      return { ok: false, status: 400, message: "gitea_base_url_required" };
    }
    const base = await giteaBaseAllowed(baseUrl, lookup);
    if (!base) {
      return { ok: false, status: 400, message: "gitea_base_url_refused" };
    }
    return putGiteaStyle(base, input, fetchImpl);
  }
  return putOrigin(input, fetchImpl);
}

function readTrimmed(body, key) {
  return body && typeof body[key] === "string" ? body[key].trim() : "";
}

function parseGitBackupPutBody(body) {
  const forge = readTrimmed(body, "forge").toLowerCase();
  const token = readTrimmed(body, "token");
  const owner = readTrimmed(body, "owner");
  const repo = readTrimmed(body, "repo");
  const branch = readTrimmed(body, "branch") || "main";
  const contentBase64 =
    body && typeof body.contentBase64 === "string" ? body.contentBase64 : "";
  const message = readTrimmed(body, "message") || "OpenSesame vault backup";
  const username = readTrimmed(body, "username");
  const path = BACKUP_PATH;
  if (!FORGES.has(forge) || !token || !owner || !repo || contentBase64 === "") {
    return null;
  }
  return {
    forge,
    body,
    input: {
      token,
      owner,
      repo,
      branch,
      contentBase64,
      message,
      path,
      username,
    },
  };
}
const REFUSALS = new Set(["gitea_base_url_required", "gitea_base_url_refused"]);

export async function handleGitBackupPut(
  body,
  origin,
  fetchImpl = fetch,
  lookup = undefined,
) {
  const cors = corsHeaders(origin);
  if (!cors["access-control-allow-origin"]) {
    return json(403, { error: "origin_not_allowed" });
  }
  const parsed = parseGitBackupPutBody(body);
  if (!parsed) {
    return json(400, { error: "missing_fields" }, cors);
  }
  const { forge, input } = parsed;

  let result;
  try {
    result = await putForForge(forge, body, input, { fetchImpl, lookup });
    if (result && result.ok === false && REFUSALS.has(result.message)) {
      return json(400, { error: result.message }, cors);
    }
  } catch (error) {
    return json(
      502,
      {
        error: "upstream_unreachable",
        message: error instanceof Error ? error.message : "Forge unreachable",
      },
      cors,
    );
  }
  if (!result.ok) {
    return json(
      result.status >= 400 && result.status < 600 ? result.status : 502,
      { error: "put_failed", message: result.message },
      cors,
    );
  }
  return json(
    200,
    {
      commitSha: result.commitSha,
      path: input.path,
      branch: input.branch,
      forge,
    },
    cors,
  );
}

export function handleGitBackupPutOptions(origin) {
  const cors = corsHeaders(origin);
  if (!cors["access-control-allow-origin"]) {
    return json(403, { error: "origin_not_allowed" });
  }
  return { status: 204, headers: cors, body: "" };
}
