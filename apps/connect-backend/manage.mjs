/**
 * Connect management proxy. Holds the Vercel access token server-side so the
 * static Pages PWA never asks a person to paste one. Provider tokens stay in
 * Connect — this only creates/lists connectors and starts authorize/revoke.
 * Every route but the list needs the operator's management key
 * (`OPENSESAME_CONNECT_MANAGE_KEY`, `manage-auth.mjs`); the Origin header
 * alone gates nothing a non-browser client cannot forge.
 */

import {
  callbackAllowed,
  manageRefusal,
  publicConnectorList,
  publicError,
  requestHostOf,
} from "./manage-auth.mjs";

const CONNECT_API = "https://api.vercel.com";

function vercelToken() {
  return (process.env.VERCEL_TOKEN ?? "").trim();
}

function teamId() {
  return (process.env.VERCEL_TEAM_ID ?? "").trim();
}

function projectId() {
  return (process.env.VERCEL_PROJECT_ID ?? "").trim();
}

function teamQuery(extra = {}) {
  const params = new URLSearchParams();
  if (extra.limit) params.set("limit", extra.limit);
  if (extra.projectId) params.set("projectId", extra.projectId);
  const team = teamId();
  if (team) params.set("teamId", team);
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function vercelFetch(path, init = {}) {
  const token = vercelToken();
  if (!token) {
    return {
      status: 503,
      body: {
        error: { code: "unconfigured", message: "VERCEL_TOKEN is not set." },
      },
    };
  }
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${CONNECT_API}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

export function corsHeaders(origin) {
  const allowed = new Set(
    (process.env.OPENSESAME_CONNECT_APP_ORIGINS ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  const loopback =
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    origin.startsWith("https://localhost:") ||
    origin.startsWith("https://127.0.0.1:");
  const permit = loopback || allowed.has(origin);
  if (!permit) return null;
  const headers = {
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,accept,authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  return headers;
}

function json(status, cors, body) {
  return {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function invalid(cors, message) {
  return json(400, cors, { error: { code: "invalid_request", message } });
}

function connectorIdOf(payload) {
  return typeof payload.connectorId === "string"
    ? payload.connectorId.trim()
    : "";
}

async function listConnectors(_payload, cors) {
  const project = projectId();
  const extra = project
    ? { limit: "100", projectId: project }
    : { limit: "100" };
  const reply = await vercelFetch(`/v2/connect/connectors${teamQuery(extra)}`);
  const ok = reply.status >= 200 && reply.status < 300;
  // Anonymous: the rows the catalog maps, never the upstream body whole.
  return json(
    reply.status,
    cors,
    ok ? publicConnectorList(reply.body) : publicError(reply.body),
  );
}

async function createConnector(payload, cors) {
  const service =
    typeof payload.service === "string" ? payload.service.trim() : "";
  if (!service) return invalid(cors, "service is required.");
  const name =
    typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : service;
  const body = { service, name };
  const project = projectId();
  if (project) body.projectId = project;
  const reply = await vercelFetch(`/v1/connect/connectors${teamQuery()}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return json(reply.status, cors, reply.body);
}

async function authorizeConnector(payload, cors, req) {
  const connectorId = connectorIdOf(payload);
  if (!connectorId) return invalid(cors, "connectorId is required.");
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((scope) => typeof scope === "string")
    : undefined;
  const callbackUrl =
    typeof payload.callbackUrl === "string" && payload.callbackUrl.trim()
      ? payload.callbackUrl.trim()
      : undefined;
  if (callbackUrl && !callbackAllowed(callbackUrl, req.requestHost)) {
    return json(400, cors, {
      error: {
        code: "invalid_callback",
        message: "callbackUrl must be this relay's /api/connect/callback.",
      },
    });
  }
  const authorizeBody = { subject: { type: "app" } };
  if (scopes?.length) authorizeBody.scopes = scopes;
  if (callbackUrl) authorizeBody.returnUrl = callbackUrl;
  const reply = await vercelFetch(
    `/v1/connect/authorize/${encodeURIComponent(connectorId)}`,
    { method: "POST", body: JSON.stringify(authorizeBody) },
  );
  return json(reply.status, cors, reply.body);
}

async function revokeConnector(payload, cors) {
  const connectorId = connectorIdOf(payload);
  if (!connectorId) return invalid(cors, "connectorId is required.");
  const reply = await vercelFetch(
    `/v1/connect/connectors/${encodeURIComponent(connectorId)}/tokens`,
    {
      method: "DELETE",
      body: JSON.stringify({ subject: { type: "app" } }),
    },
  );
  if (reply.status >= 200 && reply.status < 300) {
    return json(200, cors, { revoked: true });
  }
  return json(reply.status, cors, reply.body);
}

/** `mutation` routes spend the operator's token and need the manage key. */
const ROUTES = new Map([
  ["GET /api/connect/connectors", { run: listConnectors, mutation: false }],
  ["POST /api/connect/connectors", { run: createConnector, mutation: true }],
  ["POST /api/connect/authorize", { run: authorizeConnector, mutation: true }],
  ["POST /api/connect/revoke", { run: revokeConnector, mutation: true }],
]);

function refuse(cors, refusal) {
  const headers =
    refusal.status === 401
      ? { ...cors, "www-authenticate": 'Bearer realm="connect-manage"' }
      : cors;
  return json(refusal.status, headers, {
    error: { code: refusal.code, message: refusal.message },
  });
}

/**
 * @param {{ method: string, path: string, origin: string, body?: object,
 *   authorization?: string, requestHost?: string }} req
 */
export async function handleManage(req) {
  const cors = corsHeaders(req.origin ?? "");
  if (!cors) {
    return {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "Origin not allowed.",
    };
  }
  if (req.method === "OPTIONS") {
    return { status: 204, headers: cors, body: "" };
  }
  const route = ROUTES.get(`${req.method} ${req.path}`);
  if (!route) {
    return {
      status: 404,
      headers: { ...cors, "content-type": "text/plain; charset=utf-8" },
      body: "Unknown Connect management route.",
    };
  }
  if (route.mutation) {
    const refusal = manageRefusal(req.authorization);
    if (refusal) return refuse(cors, refusal);
  }
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  return route.run(payload, cors, req);
}

/** The `handleManage` input for a Vercel function's request. */
export function manageInput(req, path) {
  const body =
    req.method === "GET" || req.method === "OPTIONS" ? {} : (req.body ?? {});
  return {
    method: req.method ?? "GET",
    path,
    origin: req.headers.origin ?? "",
    authorization: req.headers.authorization ?? "",
    requestHost: requestHostOf(req.headers),
    body: typeof body === "object" && body !== null ? body : {},
  };
}

/** Read a UTF-8 body from a Node IncomingMessage (raw, for HMAC). */
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** Read a JSON body from a Node IncomingMessage. */
export function readJsonBody(req) {
  return readRawBody(req).then((raw) => {
    if (!raw) return {};
    return JSON.parse(raw);
  });
}
