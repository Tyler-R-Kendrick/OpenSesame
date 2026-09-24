/**
 * What the Connect management proxy checks before it spends the deployment's
 * `VERCEL_TOKEN` (ADR 0127).
 *
 * The relay is public and an Origin header is only a browser convention, so
 * every route that changes the operator's Vercel Connect account — create a
 * connector, start an app-subject authorization, revoke the app's tokens —
 * needs the operator's management key as `Authorization: Bearer …`. With no
 * key configured those routes refuse (fail closed). The one anonymous route,
 * the connector list, answers only the fields the Pages catalog reads.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { returnToAllowed } from "./allowlist.mjs";

/** A management key shorter than this reads as unset. */
export const MIN_MANAGE_KEY_LENGTH = 32;
export const CALLBACK_PATH = "/api/connect/callback";

const MAX_CONNECTORS = 100;
const MAX_SCOPES = 64;
const CONNECTOR_FIELDS = [
  "id",
  "uid",
  "connectorId",
  "name",
  "displayName",
  "service",
  "type",
  "clientUrl",
  "website",
  "createdAt",
  "updatedAt",
  "reinstallAt",
];

function configuredKey() {
  return (process.env.OPENSESAME_CONNECT_MANAGE_KEY ?? "").trim();
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearerOf(header) {
  const raw = typeof header === "string" ? header.trim() : "";
  const match = /^Bearer\s+(\S+)$/i.exec(raw);
  return match ? match[1] : "";
}

/**
 * Null when `authorization` carries the operator's management key; otherwise
 * the refusal to send. Compared as SHA-256 digests in constant time, so
 * neither the key's length nor its prefix leaks through timing.
 */
export function manageRefusal(authorization) {
  const expected = configuredKey();
  if (expected.length < MIN_MANAGE_KEY_LENGTH) {
    return {
      status: 403,
      code: "management_disabled",
      message: "Connector management is disabled on this relay.",
    };
  }
  const presented = bearerOf(authorization);
  if (!presented) {
    return {
      status: 401,
      code: "manage_key_required",
      message: "A management key is required.",
    };
  }
  if (!timingSafeEqual(digest(presented), digest(expected))) {
    return {
      status: 401,
      code: "manage_key_invalid",
      message: "That management key is not accepted.",
    };
  }
  return null;
}

/** `proto://host` for a Node/Vercel request, as the callback relay sees it. */
export function requestHostOf(headers = {}) {
  const host = typeof headers.host === "string" ? headers.host : "";
  if (!host) return "";
  const forwarded =
    typeof headers["x-forwarded-proto"] === "string"
      ? headers["x-forwarded-proto"].split(",")[0].trim()
      : "";
  const proto = forwarded || (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function relayOrigins(requestHost) {
  const origins = new Set();
  const configured = (process.env.OPENSESAME_CONNECT_RELAY_ORIGIN ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const raw of [...configured, requestHost ?? ""]) {
    try {
      origins.add(new URL(raw).origin);
    } catch {
      // not an origin
    }
  }
  return origins;
}

/**
 * True only for this relay's own `/api/connect/callback` carrying nothing but
 * an allowlisted `return_to` — the only place Connect may send a browser
 * back to once an app-subject authorization finishes.
 */
export function callbackAllowed(raw, requestHost) {
  if (typeof raw !== "string" || raw.includes("#")) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (!relayOrigins(requestHost).has(url.origin)) return false;
  if (url.pathname !== CALLBACK_PATH) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "return_to") return false;
  return (
    returnToAllowed(url.searchParams.get("return_to"), url.origin) !== null
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopesOnly(tokens) {
  if (!isObject(tokens) || !Array.isArray(tokens.scopes)) return undefined;
  return {
    scopes: tokens.scopes
      .filter((scope) => typeof scope === "string")
      .slice(0, MAX_SCOPES),
  };
}

/** A connector row reduced to what the Pages catalog maps. */
export function publicConnector(row) {
  const out = {};
  if (!isObject(row)) return out;
  for (const field of CONNECTOR_FIELDS) {
    const value = row[field];
    if (typeof value === "string" || typeof value === "number") {
      out[field] = value;
    }
  }
  const userTokens = scopesOnly(row.userTokens);
  const appTokens = scopesOnly(row.appTokens);
  if (userTokens) out.userTokens = userTokens;
  if (appTokens) out.appTokens = appTokens;
  return out;
}

/** The list reply the anonymous route may answer: rows, nothing else. */
export function publicConnectorList(body) {
  const rows =
    isObject(body) && Array.isArray(body.connectors) ? body.connectors : [];
  return {
    connectors: rows
      .filter(isObject)
      .slice(0, MAX_CONNECTORS)
      .map(publicConnector),
  };
}

/** An upstream error reduced to its code and message. */
export function publicError(body) {
  const error = isObject(body) && isObject(body.error) ? body.error : {};
  return {
    error: {
      code:
        typeof error.code === "string"
          ? error.code.slice(0, 64)
          : "upstream_error",
      message:
        typeof error.message === "string"
          ? error.message.slice(0, 240)
          : "Connect refused the request.",
    },
  };
}
