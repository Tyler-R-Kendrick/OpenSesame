/**
 * The token proof's second half (ADR 0146): which of a service's pinned
 * verify calls fits a connector, the values its `{placeholders}` take from the
 * connector's own stored endpoints, and the call itself — the pinned URL, the
 * token, no redirects, a bounded read. The target comes from the pinned
 * presets by the connector's service, never from the request.
 */

import {
  VERIFY_HOSTS,
  VERIFY_TARGETS,
} from "./connect-verify-targets.generated.mjs";
import {
  isJsonObject,
  isNumber,
  isString,
  readString,
} from "./json-boundary.mjs";

const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_MAX_BYTES = 64_000;

const isObject = isJsonObject;

function text(value, max = 256) {
  return readString(value)?.trim().slice(0, max) ?? "";
}

function pick(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part))
      current = current[Number(part)];
    else if (isObject(current)) current = current[part];
    else return "";
  }
  return isString(current) || isNumber(current)
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
/** The values one stored field gives for a source's placeholders, or null. */
function valuesFrom(source, data) {
  const [head, key] = source.field.split(".");
  const holder = head === "serverConfig" ? data.serverConfig : data[head];
  const filled = Array.isArray(holder)
    ? holder[Number(key)]
    : isObject(holder)
      ? holder[key]
      : undefined;
  if (!isString(filled)) return null;
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
  if (!match) return null;
  return Object.fromEntries(
    names.map((name, index) => [name, match[index + 1]]),
  );
}

/**
 * The per-account values (`{domain}`, `{shop}`) a verify target needs,
 * recovered from the connector's own stored endpoints. Fails closed: a
 * placeholder is filled only when every stored field that names it agrees,
 * and when the preset records the token endpoint, only from it — the token
 * goes back to the server that issued it, never to a host another field
 * names. An unfilled placeholder means no verify call is made.
 */
export function recoverParams(target, connector) {
  const data = isObject(connector?.data) ? connector.data : {};
  const sources = target.sources ?? [];
  const issuer = sources.filter(
    (source) => source.field === "serverConfig.token_endpoint",
  );
  const found = new Map();
  for (const source of sources) {
    const values = valuesFrom(source, data);
    if (!values) {
      if (issuer.includes(source)) return {};
      continue;
    }
    for (const [name, value] of Object.entries(values)) {
      found.set(name, [...(found.get(name) ?? []), value]);
    }
  }
  const params = {};
  for (const [name, values] of found) {
    if (new Set(values.map((value) => value.toLowerCase())).size === 1) {
      params[name] = values[0];
    }
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

/**
 * The reply's JSON, read up to VERIFY_MAX_BYTES. A reply larger than that is
 * reported `truncated` rather than unparseable: a big answer is still an
 * answer, and must not read as the service refusing the token.
 */
export async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return { value: null, truncated: false };
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > VERIFY_MAX_BYTES) {
      truncated = true;
      break;
    }
  }
  await reader.cancel().catch(() => undefined);
  if (truncated) return { value: null, truncated };
  try {
    return {
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      truncated,
    };
  } catch {
    return { value: null, truncated };
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
  const read = readable
    ? await boundedJson(response)
    : { value: null, truncated: false };
  if (!readable) await response.body?.cancel?.();
  const body = read.value;
  return {
    status: response.status,
    // Too large to inspect, but a 2xx answer all the same.
    ok: response.ok && (read.truncated || answered(body, target.kind)),
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
