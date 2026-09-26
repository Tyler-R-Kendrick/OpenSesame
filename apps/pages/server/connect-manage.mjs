/**
 * Configured connectors (ADR 0146): the create body the page built from a
 * connector plan, reading and editing a connector, and proving a person's
 * token can be acquired. Every route here sits behind the management key
 * (`manage-auth.mjs`); the relay holds the Vercel token, never the page.
 *
 * The token proof asks Connect for the token, fingerprints it, calls the
 * service's own read-only verify endpoint with it (`connect-verify.mjs`: a
 * target chosen from the pinned presets by the connector's service, never
 * from the request) and answers with metadata. The token itself never leaves
 * the relay.
 */

import { createHash } from "node:crypto";
import { isJsonObject, isString, readString } from "./json-boundary.mjs";

export {
  boundedJson,
  recoverParams,
  resolveTarget,
  verifyTargetFor,
  verifyWithToken,
} from "./connect-verify.mjs";

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

const isObject = isJsonObject;

function text(value, max = 256) {
  return readString(value)?.trim().slice(0, max) ?? "";
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
    return isString(value) ? value.slice(0, 2048) : value;
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
        .filter((scope) => isString(scope) && scope.length <= 256)
        .slice(0, 64)
    : [];
}

export function fingerprintOf(token) {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}
