import {
  API,
  API_VERSION,
  BACKUP_PATH,
  UA,
  json,
  mintInstallationToken,
  readCredentials,
} from "./github-app-contents-shared.mjs";
import { githubAppCorsHeaders } from "./github-app.mjs";

function readStringField(body, key) {
  return body && typeof body[key] === "string" ? body[key].trim() : "";
}

function parsePutBody(body) {
  const creds = readCredentials(body);
  const owner = readStringField(body, "owner");
  const repo = readStringField(body, "repo");
  const branch = readStringField(body, "branch") || "main";
  const contentBase64 =
    body && typeof body.contentBase64 === "string" ? body.contentBase64 : "";
  const message = readStringField(body, "message") || "OpenSesame vault backup";
  const path = BACKUP_PATH;
  if (!creds || !owner || !repo || contentBase64 === "") return null;
  return { creds, owner, repo, branch, contentBase64, message, path };
}

async function mintTokenOrError(creds, owner, repo, fetchImpl, cors) {
  try {
    const token = await mintInstallationToken(
      { ...creds, owner, repo },
      fetchImpl,
    );
    return { ok: true, token };
  } catch (error) {
    const status =
      error && typeof error.status === "number" && error.status >= 400
        ? error.status
        : 502;
    return {
      ok: false,
      response: json(
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

async function readExistingSha(contentsUrl, branch, headers, fetchImpl) {
  try {
    const existing = await fetchImpl(
      `${contentsUrl}?ref=${encodeURIComponent(branch)}`,
      { headers },
    );
    if (!existing.ok) return null;
    const row = JSON.parse(await existing.text());
    return row && typeof row.sha === "string" ? row.sha : null;
  } catch {
    return null;
  }
}

async function putGithubContents({
  contentsUrl,
  headers,
  message,
  contentBase64,
  branch,
  existingSha,
  fetchImpl,
  cors,
}) {
  const putBody = { message, content: contentBase64, branch };
  if (existingSha) putBody.sha = existingSha;
  let putResponse;
  try {
    putResponse = await fetchImpl(contentsUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify(putBody),
    });
  } catch (error) {
    return {
      errorResponse: json(
        502,
        {
          error: "upstream_unreachable",
          message:
            error instanceof Error ? error.message : "GitHub unreachable",
        },
        cors,
      ),
    };
  }
  const putText = await putResponse.text();
  let putPayload;
  try {
    putPayload = JSON.parse(putText);
  } catch {
    return { errorResponse: json(502, { error: "upstream_malformed" }, cors) };
  }
  if (!putResponse.ok) {
    return {
      errorResponse: json(
        putResponse.status >= 400 && putResponse.status < 600
          ? putResponse.status
          : 502,
        {
          error: "put_failed",
          message:
            typeof putPayload.message === "string"
              ? putPayload.message
              : `GitHub returned ${putResponse.status}`,
        },
        cors,
      ),
    };
  }
  return {
    commitSha:
      putPayload.commit && typeof putPayload.commit.sha === "string"
        ? putPayload.commit.sha
        : null,
    contentSha:
      putPayload.content && typeof putPayload.content.sha === "string"
        ? putPayload.content.sha
        : null,
  };
}

export async function handleGithubAppPutContents(
  body,
  origin,
  fetchImpl = fetch,
) {
  const cors = githubAppCorsHeaders(origin);
  if (origin && !cors["access-control-allow-origin"]) {
    return json(403, { error: "origin_not_allowed" });
  }
  const parsed = parsePutBody(body);
  if (!parsed) return json(400, { error: "missing_fields" }, cors);
  const { creds, owner, repo, branch, contentBase64, message, path } = parsed;
  const minted = await mintTokenOrError(creds, owner, repo, fetchImpl, cors);
  if (!minted.ok) return minted.response;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${minted.token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": UA,
    "Content-Type": "application/json",
  };
  const contentsUrl = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const existingSha = await readExistingSha(
    contentsUrl,
    branch,
    headers,
    fetchImpl,
  );
  const put = await putGithubContents({
    contentsUrl,
    headers,
    message,
    contentBase64,
    branch,
    existingSha,
    fetchImpl,
    cors,
  });
  if (put.errorResponse) return put.errorResponse;
  return json(
    200,
    { commitSha: put.commitSha, contentSha: put.contentSha, path, branch },
    cors,
  );
}
