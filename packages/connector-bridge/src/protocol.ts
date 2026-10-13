/**
 * The wire between a page and the connector bridge extension (ADR 0199): what a
 * page may ask, what the extension answers, and the limits both hold. Plain
 * data, parsed strictly at each end; neither side trusts the other's shape.
 */
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";

export const BRIDGE_CHANNEL = "opensesame.connector-bridge";
export const BRIDGE_VERSION = 1;

/** One request body, one response body, one call's time: a connection check, not a transfer. */
export const MAX_REQUEST_BODY = 256 * 1024;
export const MAX_RESPONSE_BODY = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_URL_LENGTH = 2048;
export const MAX_HEADERS = 64;
export const MAX_HEADER_VALUE = 8 * 1024;

export const BRIDGE_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

export type HeaderPair = [string, string];

export type BridgeFetchRequest = {
  providerId: string;
  url: string;
  method: BridgeMethod;
  headers: HeaderPair[];
  body: string | null;
};

export type BridgeFetchResponse = {
  status: number;
  headers: HeaderPair[];
  body: string;
};

export type BridgeHello = {
  bridge: "opensesame-connector-bridge";
  version: string;
  /** The hosts a person has allowed, never more than the table names. */
  granted: string[];
};

export type BridgePending = { pending: string[] };

export const BRIDGE_ERRORS = [
  "bad_request",
  "host_not_allowed",
  "not_granted",
  "denied_header",
  "too_large",
  "not_enabled",
  "redirect_refused",
  "timeout",
  "network",
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERRORS)[number];

export type BridgeOperation = "hello" | "need" | "fetch";

type Envelope = { id: string };
type Operation =
  | { op: "hello" }
  | { op: "need"; hosts: string[] }
  | { op: "fetch"; request: BridgeFetchRequest };
export type PageRequest = Envelope & Operation;

export type PageReply =
  | { id: string; result: BridgeHello | BridgeFetchResponse | BridgePending }
  | { id: string; error: BridgeErrorCode };

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;

function hasExactly(value: JsonObject, keys: readonly string[]): boolean {
  const have = Object.keys(value);
  return have.length === keys.length && keys.every((key) => key in value);
}

export function isBridgeHost(value: BoundaryValue): value is string {
  return isString(value) && value.length <= 253 && HOST.test(value);
}

function parseHeaders(value: BoundaryValue): HeaderPair[] | null {
  if (!Array.isArray(value) || value.length > MAX_HEADERS) return null;
  const out: HeaderPair[] = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [name, text] = pair;
    if (!isString(name) || !isString(text)) return null;
    out.push([name, text]);
  }
  return out;
}

function methodOf(value: BoundaryValue): BridgeMethod | null {
  return BRIDGE_METHODS.find((entry) => entry === value) ?? null;
}

export function parseFetchRequest(
  value: BoundaryValue,
): BridgeFetchRequest | null {
  if (
    !isJsonObject(value) ||
    !hasExactly(value, ["providerId", "url", "method", "headers", "body"])
  )
    return null;
  const { providerId, url, body } = value;
  const method = methodOf(value.method);
  const headers = parseHeaders(value.headers);
  if (
    !isString(providerId) ||
    !PROVIDER.test(providerId) ||
    !isString(url) ||
    url.length > MAX_URL_LENGTH ||
    !method ||
    !headers ||
    (body !== null && !isString(body))
  )
    return null;
  return { providerId, url, method, headers, body };
}

const ENVELOPE = ["channel", "version", "direction", "id", "op"];

function parseNeed(data: JsonObject): string[] | null {
  const hosts = data.hosts;
  if (
    !hasExactly(data, [...ENVELOPE, "hosts"]) ||
    !Array.isArray(hosts) ||
    hosts.length === 0 ||
    hosts.length > 16 ||
    !hosts.every(isBridgeHost)
  )
    return null;
  return hosts.filter(isBridgeHost);
}

/** What a page asked, or `null` when it is not exactly a bridge request. */
export function parsePageRequest(data: BoundaryValue): PageRequest | null {
  if (
    !isJsonObject(data) ||
    data.channel !== BRIDGE_CHANNEL ||
    data.version !== BRIDGE_VERSION ||
    data.direction !== "request" ||
    !isString(data.id) ||
    !ID.test(data.id)
  )
    return null;
  const { id } = data;
  if (data.op === "hello")
    return hasExactly(data, ENVELOPE) ? { id, op: "hello" } : null;
  if (data.op === "need") {
    const hosts = parseNeed(data);
    return hosts ? { id, op: "need", hosts } : null;
  }
  if (data.op !== "fetch" || !hasExactly(data, [...ENVELOPE, "request"]))
    return null;
  const request = parseFetchRequest(data.request);
  return request ? { id, op: "fetch", request } : null;
}

/** The envelope a request travels in. */
export function pageRequestMessage(request: PageRequest) {
  const base = {
    channel: BRIDGE_CHANNEL,
    version: BRIDGE_VERSION,
    direction: "request",
  };
  return { ...base, ...request };
}

/** The envelope an answer travels in. */
export function pageReplyMessage(reply: PageReply) {
  const base = {
    channel: BRIDGE_CHANNEL,
    version: BRIDGE_VERSION,
    direction: "response",
  };
  return "error" in reply
    ? { ...base, id: reply.id, ok: false, error: reply.error }
    : { ...base, id: reply.id, ok: true, result: reply.result };
}

function parseFetchResponse(value: BoundaryValue): BridgeFetchResponse | null {
  if (!isJsonObject(value) || !hasExactly(value, ["status", "headers", "body"]))
    return null;
  const headers = parseHeaders(value.headers);
  const { status, body } = value;
  if (
    !isNumber(status) ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599 ||
    !isString(body) ||
    !headers
  )
    return null;
  return { status, headers, body };
}

function parseHello(value: BoundaryValue): BridgeHello | null {
  if (
    !isJsonObject(value) ||
    !hasExactly(value, ["bridge", "version", "granted"])
  )
    return null;
  const { granted, version } = value;
  if (
    value.bridge !== "opensesame-connector-bridge" ||
    !isString(version) ||
    version.length > 32 ||
    !Array.isArray(granted) ||
    granted.length > 512 ||
    !granted.every(isBridgeHost)
  )
    return null;
  return {
    bridge: "opensesame-connector-bridge",
    version,
    granted: granted.filter(isBridgeHost),
  };
}

function parsePending(value: BoundaryValue): BridgePending | null {
  if (!isJsonObject(value) || !hasExactly(value, ["pending"])) return null;
  const { pending } = value;
  return Array.isArray(pending) && pending.every(isBridgeHost)
    ? { pending: pending.filter(isBridgeHost) }
    : null;
}

/** What the extension answered to `operation`, checked as strictly as the question was. */
export function parsePageReply(
  data: BoundaryValue,
  operation: BridgeOperation,
): PageReply | null {
  if (
    !isJsonObject(data) ||
    data.channel !== BRIDGE_CHANNEL ||
    data.version !== BRIDGE_VERSION ||
    data.direction !== "response" ||
    !isString(data.id) ||
    !ID.test(data.id)
  )
    return null;
  const { id } = data;
  if (data.ok === false) {
    const error = BRIDGE_ERRORS.find((entry) => entry === data.error);
    return error ? { id, error } : null;
  }
  if (data.ok !== true) return null;
  const result =
    operation === "hello"
      ? parseHello(data.result)
      : operation === "fetch"
        ? parseFetchResponse(data.result)
        : parsePending(data.result);
  return result ? { id, result } : null;
}
