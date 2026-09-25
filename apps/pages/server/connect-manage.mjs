/**
 * Configured connectors (ADR 0146): the create body the page built from a
 * connector plan, reading and editing a connector, and proving a person's
 * token can be acquired. Every route here sits behind the management key
 * (`manage-auth.mjs`); the relay holds the Vercel token, never the page.
 *
 * The token proof asks Connect for the token, fingerprints it, calls the
 * service's own read-only verify endpoint with it — a target chosen from the
 * pinned presets by the connector's service, never from the request — and
 * answers with metadata. The token itself never leaves this module.
 */

import { createHash } from "node:crypto";
import {
  VERIFY_HOSTS,
  VERIFY_TARGETS,
} from "./connect-verify-targets.generated.mjs";

const CREATE_KEYS = [
  "service",
  "name",
  "uid",
  "type",
  "connectionMethod",
  "target",
  "params",
  "data",
];
const TYPES = new Set(["oauth", "api-key"]);
const METHODS = new Set(["oauth", "mcp", "api-key"]);
const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_MAX_BYTES = 64_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, max = 256) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * The create body, reduced to the keys Connect's create route accepts. A
 * legacy `{ service, name }` still works; a `connector` object is the whole
 * configuration. Returns a string when the body is refused.
 */
/** Each optional create key, and why Connect would refuse a bad one. */
const CREATE_CHECKS = [
  [
    "uid",
    (v) => /^[^\s%#]+\/[^\s%#]+$/.test(text(v)),
    "uid must look like service/name.",
  ],
  ["type", (v) => TYPES.has(v), "type must be oauth or api-key."],
  [
    "connectionMethod",
    (v) => METHODS.has(v),
    "connectionMethod must be oauth, mcp or api-key.",
  ],
  ["data", isObject, "data must be an object."],
  ["params", isObject, "params must be an object."],
];

export function createBodyOf(payload, projectId) {
  const source = isObject(payload.connector) ? payload.connector : payload;
  const body = {};
  for (const key of CREATE_KEYS) {
    if (source[key] !== undefined) body[key] = source[key];
  }
  body.service = text(body.service);
  if (!body.service) return "service is required.";
  body.name = text(body.name, 128) || body.service;
  for (const [key, valid, refusal] of CREATE_CHECKS) {
    if (body[key] !== undefined && !valid(body[key])) return refusal;
  }
  if (projectId) body.projectId = projectId;
  return body;
}

/** Secret-shaped names: anything saying secret, password or private key, and
 * the exact fields Connect stores credentials under. */
const SECRET_KEY = /secret|password|private_?key/i;
const SECRET_FIELDS = new Set([
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiToken",
  "verificationToken",
  "values",
  "value",
  "key",
]);

function secretField(key) {
  return SECRET_KEY.test(key) || SECRET_FIELDS.has(key);
}

/** A connector with every secret-shaped field removed, however deep. */
export function publicConnectorDetail(value, depth = 0) {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((item) => publicConnectorDetail(item, depth + 1));
  }
  if (!isObject(value)) {
    return typeof value === "string" ? value.slice(0, 2048) : value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretField(key)) continue;
    out[key] = publicConnectorDetail(item, depth + 1);
  }
  return out;
}

export function subjectOf(payload) {
  const subject = isObject(payload.subject) ? payload.subject : {};
  if (subject.type === "app") return { type: "app" };
  const id = text(subject.id, 128);
  if (subject.type === "user" && /^[A-Za-z0-9_.:@-]+$/.test(id)) {
    return { type: "user", id };
  }
  return null;
}

export function scopesOf(payload) {
  return Array.isArray(payload.scopes)
    ? payload.scopes
        .filter((scope) => typeof scope === "string" && scope.length <= 256)
        .slice(0, 64)
    : [];
}

export function fingerprintOf(token) {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

function pick(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part))
      current = current[Number(part)];
    else if (isObject(current)) current = current[part];
    else return "";
  }
  return typeof current === "string" || typeof current === "number"
    ? String(current).slice(0, 80)
    : "";
}

/** Which of the service's verify calls fits this connector. */
export function verifyTargetFor(connector) {
  const named = text(connector?.service, 128);
  const service = Object.hasOwn(VERIFY_TARGETS, named)
    ? named
    : (VERIFY_HOSTS[named] ?? "");
  const targets = VERIFY_TARGETS[service];
  if (!targets) return null;
  const data = isObject(connector.data) ? connector.data : {};
  if (connector.type === "api-key") return targets.apiKey ?? null;
  const mcp = targets.mcp;
  if (
    mcp &&
    text(data.serverUrl) &&
    text(data.serverUrl).startsWith(new URL(mcp.url).origin)
  ) {
    return mcp;
  }
  if (connector.connectionMethod === "mcp" && mcp) return mcp;
  return targets.oauth ?? null;
}

/** The credential header's value: a scheme, Basic pair, or the bare token. */
function authorizationFor(target, token) {
  if (target.basic) {
    const fill = (value) => (value ?? "").replaceAll("{key}", token);
    const pair = `${fill(target.basic.username)}:${fill(target.basic.password)}`;
    return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
  }
  return target.scheme ? `${target.scheme} ${token}` : token;
}

/**
 * A 200 is not always a yes: GraphQL answers a bad token with `errors`, and
 * some APIs answer an anonymous caller with an empty object.
 */
function answered(body, kind) {
  if (kind === "mcp") return true;
  if (!isObject(body) && !Array.isArray(body)) return false;
  if (isObject(body) && Array.isArray(body.errors) && body.errors.length > 0) {
    return false;
  }
  return !(isObject(body) && Object.keys(body).length === 0);
}

/**
 * Values for a target's `{placeholders}`, read back from the connector's own
 * stored endpoints (an Okta domain from its authorization endpoint). Only
 * host-shaped values are accepted, so nothing but a host label can reach the
 * verify URL.
 */
export function recoverParams(target, connector) {
  const data = isObject(connector?.data) ? connector.data : {};
  const params = {};
  for (const source of target.sources ?? []) {
    const [head, key] = source.field.split(".");
    const holder = head === "serverConfig" ? data.serverConfig : data[head];
    const filled = Array.isArray(holder)
      ? holder[Number(key)]
      : isObject(holder)
        ? holder[key]
        : undefined;
    if (typeof filled !== "string") continue;
    const names = [];
    const pattern = source.template
      .split(/(\{[a-z_]+\})/)
      .map((part) => {
        const name = /^\{([a-z_]+)\}$/.exec(part)?.[1];
        if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        names.push(name);
        return "([A-Za-z0-9.-]{1,253})";
      })
      .join("");
    const match = new RegExp(`^${pattern}$`).exec(filled);
    if (!match) continue;
    names.forEach((name, index) => {
      params[name] ??= match[index + 1];
    });
  }
  return params;
}

function fillParams(value, params) {
  return value.replace(/\{([a-z_]+)\}/g, (whole, name) =>
    name === "key" ? whole : (params[name] ?? whole),
  );
}

/** A target with every recoverable placeholder filled. */
export function resolveTarget(target, connector) {
  if (!target) return null;
  const params = recoverParams(target, connector);
  return {
    ...target,
    url: fillParams(target.url, params),
    headers: Object.fromEntries(
      Object.entries(target.headers ?? {}).map(([name, value]) => [
        name,
        fillParams(value, params),
      ]),
    ),
  };
}

/** True while the target still needs a value only its person knows. */
function openTemplate(target) {
  return /\{(?!key\})[a-z_]+\}/.test(
    [target.url, ...Object.values(target.headers ?? {})].join(" "),
  );
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  while (size < VERIFY_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Call the service's verify endpoint with the token: the service's own
 * answer is the proof the token works. No redirects are followed, so the
 * token goes to the pinned host and nowhere else.
 */
const MCP_INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "opensesame-token-check", version: "1" },
  },
});

/** The verify request: pinned URL, pinned headers, the token, no redirects. */
function verifyRequest(target, token) {
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    headers.set(name, value);
  }
  if (target.header)
    headers.set(target.header, authorizationFor(target, token));
  const init = { method: target.method, headers, redirect: "manual" };
  if (target.body) init.body = target.body;
  if (target.kind === "mcp") {
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    init.method = "POST";
    init.body = MCP_INITIALIZE;
  }
  return {
    url: target.url.replaceAll("{key}", encodeURIComponent(token)),
    init,
  };
}

async function verdict(target, response) {
  const readable = response.ok && target.kind !== "mcp";
  const body = readable ? await boundedJson(response) : null;
  if (!readable) await response.body?.cancel?.();
  return {
    status: response.status,
    ok: response.ok && answered(body, target.kind),
    account: body && target.accountField ? pick(body, target.accountField) : "",
  };
}

export async function verifyWithToken(target, token, fetchImpl = fetch) {
  if (!target || openTemplate(target)) return null;
  const { url, init } = verifyRequest(target, token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    return await verdict(target, response);
  } catch {
    return { status: 0, ok: false, account: "" };
  } finally {
    clearTimeout(timer);
  }
}
