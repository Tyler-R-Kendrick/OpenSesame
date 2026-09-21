/**
 * Connect management proxy. Holds the Vercel access token server-side so the
 * static Pages PWA never asks a person to paste one. Provider tokens stay in
 * Connect — this only creates/lists connectors and starts authorize/revoke.
 */

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
    "access-control-allow-headers": "content-type,accept",
    "access-control-max-age": "86400",
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

/**
 * @param {{ method: string, path: string, origin: string, body?: object }} req
 */
export async function handleManage(req) {
  const origin = req.origin ?? "";
  const cors = corsHeaders(origin);
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

  const path = req.path;
  const payload = req.body && typeof req.body === "object" ? req.body : {};

  if (req.method === "GET" && path === "/api/connect/connectors") {
    const project = projectId();
    const extra = project
      ? { limit: "100", projectId: project }
      : { limit: "100" };
    const reply = await vercelFetch(
      `/v2/connect/connectors${teamQuery(extra)}`,
    );
    return json(reply.status, cors, reply.body);
  }

  if (req.method === "POST" && path === "/api/connect/connectors") {
    const service =
      typeof payload.service === "string" ? payload.service.trim() : "";
    if (!service) {
      return json(400, cors, {
        error: { code: "invalid_request", message: "service is required." },
      });
    }
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

  if (req.method === "POST" && path === "/api/connect/authorize") {
    const connectorId =
      typeof payload.connectorId === "string" ? payload.connectorId.trim() : "";
    if (!connectorId) {
      return json(400, cors, {
        error: { code: "invalid_request", message: "connectorId is required." },
      });
    }
    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((scope) => typeof scope === "string")
      : undefined;
    const callbackUrl =
      typeof payload.callbackUrl === "string" && payload.callbackUrl.trim()
        ? payload.callbackUrl.trim()
        : undefined;
    const authorizeBody = { subject: { type: "app" } };
    if (scopes?.length) authorizeBody.scopes = scopes;
    if (callbackUrl) authorizeBody.returnUrl = callbackUrl;
    const reply = await vercelFetch(
      `/v1/connect/authorize/${encodeURIComponent(connectorId)}`,
      { method: "POST", body: JSON.stringify(authorizeBody) },
    );
    return json(reply.status, cors, reply.body);
  }

  if (req.method === "POST" && path === "/api/connect/revoke") {
    const connectorId =
      typeof payload.connectorId === "string" ? payload.connectorId.trim() : "";
    if (!connectorId) {
      return json(400, cors, {
        error: { code: "invalid_request", message: "connectorId is required." },
      });
    }
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

  return {
    status: 404,
    headers: { ...cors, "content-type": "text/plain; charset=utf-8" },
    body: "Unknown Connect management route.",
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
