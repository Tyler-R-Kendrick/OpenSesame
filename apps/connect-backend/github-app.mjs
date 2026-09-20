/**
 * GitHub App Manifest relay.
 *
 * GitHub posts the browser back to a fixed `redirect_url` with a one-time
 * `code`. The SPA cannot exchange that code itself — api.github.com does not
 * answer browser CORS — so this relay:
 * 1. bounces the browser to the app (`/api/github-app/callback`, same allowlist
 *    as Connect), and
 * 2. proxies the conversion (`POST /api/github-app/convert`) so every deploy
 *    (loopback Vite, GitHub Pages, Vercel) uses one callback shape.
 * 3. lists installations (`POST /api/github-app/installations`) with a
 *    one-shot app JWT so the connector page can name the owner and orgs.
 *
 * Holds no app credentials after the response leaves.
 */

import { createPrivateKey, sign } from "node:crypto";
import { corsOrigin } from "./allowlist.mjs";
import { handleCallback } from "./callback.mjs";

const CONVERSION = "https://api.github.com/app-manifests";
const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const UA = "OpenSesame-ConnectRelay/1";

/**
 * Bounce to return_to, renaming GitHub's `code`/`state` so the Pages SPA
 * does not treat the landing as an OIDC sign-in callback (`hasAuthResponse`
 * keys on `code`). The app claims via `github_app_code` + `github_app_state`.
 */
export function handleGithubAppCallback(requestUrl, requestHost) {
  const incoming = new URL(requestUrl, "http://relay.invalid");
  const params = incoming.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (code !== null) {
    params.delete("code");
    params.set("github_app_code", code);
  }
  if (state !== null) {
    params.delete("state");
    params.set("github_app_state", state);
  }
  if (!params.has("github_app")) params.set("github_app", "claim");
  return handleCallback(
    `${incoming.pathname}?${params.toString()}`,
    requestHost,
  );
}

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

export function githubAppCorsHeaders(origin) {
  const allowed = corsOrigin(origin);
  if (!allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    vary: "Origin",
  };
}

export function handleGithubAppConvertOptions(origin) {
  const cors = githubAppCorsHeaders(origin);
  if (!cors["access-control-allow-origin"]) {
    return {
      status: 403,
      headers: { "content-type": "text/plain" },
      body: "Origin not allowed.",
    };
  }
  return { status: 204, headers: cors, body: "" };
}

/**
 * Proxy the one-time manifest code to GitHub. `fetchImpl` is injectable for tests.
 */
export async function handleGithubAppConvert(body, origin, fetchImpl = fetch) {
  const cors = githubAppCorsHeaders(origin);
  if (origin && !cors["access-control-allow-origin"]) {
    return json(403, { error: "origin_not_allowed" });
  }
  const code = body && typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return json(400, { error: "missing_code" }, cors);
  }
  let response;
  try {
    response = await fetchImpl(
      `${CONVERSION}/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": UA,
        },
      },
    );
  } catch (error) {
    return json(
      502,
      {
        error: "upstream_unreachable",
        message: error instanceof Error ? error.message : "GitHub unreachable",
      },
      cors,
    );
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(
      502,
      { error: "upstream_malformed", message: text.slice(0, 200) },
      cors,
    );
  }
  if (!response.ok) {
    return json(
      response.status >= 400 && response.status < 600 ? response.status : 502,
      {
        error: "conversion_failed",
        message:
          typeof payload.message === "string"
            ? payload.message
            : `GitHub returned ${response.status}`,
      },
      cors,
    );
  }
  // Manifest conversion often omits `owner`. With the one-shot PEM, name the
  // registrant from JWT GET /app so the connector page can show it without a
  // later public slug lookup (which 404s for unpublished Apps).
  if (
    payload &&
    typeof payload === "object" &&
    typeof payload.pem === "string" &&
    payload.pem.includes("PRIVATE KEY") &&
    payload.id != null
  ) {
    try {
      const jwt = mintGithubAppJwt(payload.id, payload.pem);
      const appRes = await fetchImpl(`${API}/app`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": UA,
        },
      });
      if (appRes.ok) {
        const appPayload = await appRes.json();
        if (
          appPayload &&
          typeof appPayload === "object" &&
          appPayload.owner &&
          typeof appPayload.owner === "object"
        ) {
          payload.owner = appPayload.owner;
          // Also flatten for clients that only read top-level fields.
          if (typeof appPayload.owner.login === "string") {
            payload.ownerLogin = appPayload.owner.login;
          }
          if (typeof appPayload.owner.type === "string") {
            payload.ownerType = appPayload.owner.type;
          }
        }
      }
    } catch {
      // Client may still fill owner later via /installations.
    }
  }
  return json(200, payload, cors);
}

function b64url(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buf.toString("base64url");
}

/** Mint the short-lived RS256 app JWT GitHub expects. */
export function mintGithubAppJwt(appId, pem) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }),
  );
  const data = `${header}.${claims}`;
  const key = createPrivateKey(pem);
  const sig = sign("RSA-SHA256", Buffer.from(data), key);
  return `${data}.${b64url(sig)}`;
}

/**
 * List installs for the App. Body: `{ appId, pem }`. PEM is used once and
 * never stored. Returns `{ owner, installations }` when GitHub answers.
 */
export async function handleGithubAppInstallations(
  body,
  origin,
  fetchImpl = fetch,
) {
  const cors = githubAppCorsHeaders(origin);
  if (origin && !cors["access-control-allow-origin"]) {
    return json(403, { error: "origin_not_allowed" });
  }
  const appId =
    body && (typeof body.appId === "string" || typeof body.appId === "number")
      ? String(body.appId).trim()
      : "";
  const pem = body && typeof body.pem === "string" ? body.pem.trim() : "";
  if (!appId || !pem) {
    return json(400, { error: "missing_credentials" }, cors);
  }
  let jwt;
  try {
    jwt = mintGithubAppJwt(appId, pem);
  } catch (error) {
    return json(
      400,
      {
        error: "invalid_key",
        message: error instanceof Error ? error.message : "Invalid PEM",
      },
      cors,
    );
  }
  let response;
  try {
    response = await fetchImpl(`${API}/app/installations?per_page=100`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": UA,
      },
    });
  } catch (error) {
    return json(
      502,
      {
        error: "upstream_unreachable",
        message: error instanceof Error ? error.message : "GitHub unreachable",
      },
      cors,
    );
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(
      502,
      { error: "upstream_malformed", message: text.slice(0, 200) },
      cors,
    );
  }
  if (!response.ok) {
    return json(
      response.status >= 400 && response.status < 600 ? response.status : 502,
      {
        error: "list_failed",
        message:
          typeof payload.message === "string"
            ? payload.message
            : `GitHub returned ${response.status}`,
      },
      cors,
    );
  }
  if (!Array.isArray(payload)) {
    return json(502, { error: "upstream_malformed" }, cors);
  }
  const installations = [];
  for (const row of payload) {
    if (!row || typeof row !== "object") continue;
    const id = row.id != null ? String(row.id) : "";
    const account =
      row.account && typeof row.account === "object" ? row.account : null;
    const login =
      account && typeof account.login === "string" ? account.login : "";
    const type =
      account && typeof account.type === "string" ? account.type : "";
    if (!/^\d+$/.test(id) || !login) continue;
    installations.push({
      id,
      accountLogin: login,
      accountType: type,
    });
  }
  let ownerLogin = null;
  let ownerType = null;
  try {
    const appRes = await fetchImpl(`${API}/app`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": UA,
      },
    });
    if (appRes.ok) {
      const appPayload = await appRes.json();
      const owner =
        appPayload &&
        typeof appPayload === "object" &&
        appPayload.owner &&
        typeof appPayload.owner === "object"
          ? appPayload.owner
          : null;
      if (owner && typeof owner.login === "string") ownerLogin = owner.login;
      if (owner && typeof owner.type === "string") ownerType = owner.type;
    }
  } catch {
    // Install list is enough; owner fills on a later refresh.
  }
  return json(200, { installations, ownerLogin, ownerType }, cors);
}

/**
 * Public app card by slug — fills owner when the convert payload omitted it.
 * Body: `{ slug }`.
 */
export async function handleGithubAppLookup(body, origin, fetchImpl = fetch) {
  const cors = githubAppCorsHeaders(origin);
  if (origin && !cors["access-control-allow-origin"]) {
    return json(403, { error: "origin_not_allowed" });
  }
  const slug =
    body && typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) {
    return json(400, { error: "invalid_slug" }, cors);
  }
  let response;
  try {
    response = await fetchImpl(`${API}/apps/${encodeURIComponent(slug)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": UA,
      },
    });
  } catch (error) {
    return json(
      502,
      {
        error: "upstream_unreachable",
        message: error instanceof Error ? error.message : "GitHub unreachable",
      },
      cors,
    );
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(502, { error: "upstream_malformed" }, cors);
  }
  if (!response.ok) {
    return json(
      response.status >= 400 && response.status < 600 ? response.status : 502,
      {
        error: "lookup_failed",
        message:
          typeof payload.message === "string" ? payload.message : "not found",
      },
      cors,
    );
  }
  const owner =
    payload.owner && typeof payload.owner === "object" ? payload.owner : null;
  return json(
    200,
    {
      id: payload.id != null ? String(payload.id) : "",
      name: typeof payload.name === "string" ? payload.name : "",
      slug: typeof payload.slug === "string" ? payload.slug : slug,
      htmlUrl: typeof payload.html_url === "string" ? payload.html_url : null,
      ownerLogin: owner && typeof owner.login === "string" ? owner.login : null,
      ownerType: owner && typeof owner.type === "string" ? owner.type : null,
    },
    cors,
  );
}
