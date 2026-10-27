/**
 * What a device asks of an owner's live session, and what the owner answers
 * (ADR 0196): the device authorization grant (RFC 8628) and the brokered use
 * of the connections the owner chose, carried on the seat's sealed channel.
 *
 * A *device* is a terminal or an agent — a client that has no vault to show
 * and no window of its own. It asks for authority (`dev.begin`), is handed a
 * code the owner compares on their screen (`dev.code`), hears the owner's
 * answer (`dev.auth`, by polling `dev.poll` or pushed the moment it is made),
 * and then names a connection and an operation (`dev.call`); the owner's tab
 * makes the call and returns only what the operation reports (`dev.result`).
 * No credential is on this vocabulary, in either direction.
 *
 * Every reader bounds every string and list, and a message that does not
 * match its shape exactly is dropped, never read as the nearest thing it
 * resembles.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  CONNECTIONS_MAX,
  CONNECTION_ID,
  type DeviceConnection,
  type DeviceItem,
  OPERATIONS_MAX,
  PROVIDER_ID,
  isOperationId,
} from "./connection-wire.js";
import {
  type DeviceResetMessage,
  readDeviceResetMessage,
} from "./device-reset-messages.js";

export {
  CONNECTIONS_MAX,
  type DeviceConnection,
  type DeviceItem,
  OPERATIONS_MAX,
  isOperationId,
};

const REQ = /^[A-Za-z0-9_-]{1,32}$/;
const INPUT_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{22}$/;
const USER_CODE = /^[A-Z]{4}-[A-Z]{4}$/;

export const WANT_MAX = 8;
export const INPUT_MAX = 8;
export const INPUT_VALUE_MAX = 2048;
export const ITEMS_MAX = 100;
const LABEL_MAX = 120;
const ITEM_ID_MAX = 200;
const ITEM_LABEL_MAX = 200;
const URL_MAX = 512;

/** RFC 8628 §3.5's answers to a poll, and `granted` for the success. */
export type DeviceAuthState =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "granted";

/** Why a call or a request was refused. The wire says no more than this. */
export type DeviceErrorCode =
  | "invalid_request"
  | "access_denied"
  | "expired_token"
  | "unsupported_operation"
  | "temporarily_unavailable"
  | "upstream_error"
  | "too_large";

const AUTH_STATES: readonly DeviceAuthState[] = [
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "granted",
];

const ERROR_CODES: readonly DeviceErrorCode[] = [
  "invalid_request",
  "access_denied",
  "expired_token",
  "unsupported_operation",
  "temporarily_unavailable",
  "upstream_error",
  "too_large",
];

/** What the device sends. */
export type DeviceRequest =
  /** Ask for authority; `want` names connections the owner may pre-select. */
  | Readonly<{ t: "dev.begin"; req: string; want: readonly string[] }>
  | Readonly<{ t: "dev.poll"; req: string; deviceCode: string }>
  | Readonly<{ t: "dev.list"; req: string }>
  | Readonly<{
      t: "dev.call";
      req: string;
      connection: string;
      operation: string;
      input: Readonly<Record<string, string>>;
    }>
  | Extract<DeviceResetMessage, { t: "dev.reset" | "dev.reset.status" }>;

/** What the owner's tab answers. */
export type DeviceReply =
  | Readonly<{
      t: "dev.code";
      req: string;
      /** The handle the device polls with; never shown, never the user code. */
      deviceCode: string;
      /** What the owner compares on their screen. */
      userCode: string;
      /** Seconds until the request lapses unanswered. */
      expiresIn: number;
      /** Seconds the device waits between polls. */
      interval: number;
    }>
  | Readonly<{
      t: "dev.auth";
      req: string;
      state: DeviceAuthState;
      /** With `slow_down`: the longer wait. */
      interval?: number;
      /** With `granted`: when the grant lapses (epoch ms), and what it covers. */
      expiresAt?: number;
      connections?: readonly DeviceConnection[];
    }>
  | Readonly<{
      t: "dev.conns";
      req: string;
      connections: readonly DeviceConnection[];
    }>
  | Readonly<{
      t: "dev.result";
      req: string;
      label: string;
      items: readonly DeviceItem[];
      /** The owner's tab cut the answer to fit a frame. */
      truncated: boolean;
    }>
  | Readonly<{ t: "dev.error"; req: string; error: DeviceErrorCode }>
  | Extract<DeviceResetMessage, { t: "dev.reset.grant" | "dev.reset.ack" }>;

export type DeviceMessage = DeviceRequest | DeviceReply;

/** Code points, not UTF-16 units: an emoji is one character. */
function characters(text: string): number {
  return [...text].length;
}

function bounded(value: BoundaryValue, max: number): value is string {
  return isString(value) && characters(value) <= max;
}

/** Text a person or a terminal may be shown: no control, format or private-use. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
function plain(value: BoundaryValue, max: number): value is string {
  return bounded(value, max) && value.trim() !== "" && !UNSAFE.test(value);
}

function isReq(value: BoundaryValue): value is string {
  return isString(value) && REQ.test(value);
}

function readWant(value: BoundaryValue): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WANT_MAX) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (!isString(entry) || !CONNECTION_ID.test(entry)) return null;
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

function readInput(
  value: BoundaryValue,
): Readonly<Record<string, string>> | null {
  if (value === undefined) return {};
  if (!isJsonObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > INPUT_MAX) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!INPUT_KEY.test(key) || !bounded(entry, INPUT_VALUE_MAX)) return null;
    out[key] = entry;
  }
  return out;
}

function readConnection(value: BoundaryValue): DeviceConnection | null {
  if (!isJsonObject(value)) return null;
  const { id, label, provider, operations } = value;
  if (!isString(id) || !CONNECTION_ID.test(id)) return null;
  if (!plain(label, LABEL_MAX)) return null;
  if (!isString(provider) || !PROVIDER_ID.test(provider)) return null;
  if (!Array.isArray(operations) || operations.length > OPERATIONS_MAX)
    return null;
  if (!operations.every(isOperationId)) return null;
  return { id, label, provider, operations };
}

function readConnections(
  value: BoundaryValue,
): readonly DeviceConnection[] | null {
  if (!Array.isArray(value) || value.length > CONNECTIONS_MAX) return null;
  const read = value.map(readConnection);
  return read.every((entry) => entry !== null) ? read : null;
}

function readItem(value: BoundaryValue): DeviceItem | null {
  if (!isJsonObject(value)) return null;
  const { id, label, url } = value;
  if (!plain(id, ITEM_ID_MAX) || !plain(label, ITEM_LABEL_MAX)) return null;
  if (url === undefined) return { id, label };
  return plain(url, URL_MAX) && url.startsWith("https://") && !/\s/u.test(url)
    ? { id, label, url }
    : null;
}

function readItems(value: BoundaryValue): readonly DeviceItem[] | null {
  if (!Array.isArray(value) || value.length > ITEMS_MAX) return null;
  const read = value.map(readItem);
  return read.every((entry) => entry !== null) ? read : null;
}

function readInterval(value: BoundaryValue): number | null {
  return isNumber(value) && Number.isInteger(value) && value >= 1 && value <= 60
    ? value
    : null;
}

function readBegin(req: string, body: JsonObject): DeviceMessage | null {
  const want = readWant(body.want);
  return want ? { t: "dev.begin", req, want } : null;
}

function readCall(req: string, body: JsonObject): DeviceMessage | null {
  const { connection, operation } = body;
  const input = readInput(body.input);
  if (!isString(connection) || !CONNECTION_ID.test(connection)) return null;
  if (!isOperationId(operation) || !input) return null;
  return { t: "dev.call", req, connection, operation, input };
}

function readCode(req: string, body: JsonObject): DeviceMessage | null {
  const { deviceCode, userCode, expiresIn, interval } = body;
  if (!isString(deviceCode) || !DEVICE_CODE.test(deviceCode)) return null;
  if (!isString(userCode) || !USER_CODE.test(userCode)) return null;
  const wait = readInterval(interval);
  if (!isNumber(expiresIn) || !Number.isInteger(expiresIn) || expiresIn < 1)
    return null;
  if (expiresIn > 3600 || wait === null) return null;
  return {
    t: "dev.code",
    req,
    deviceCode,
    userCode,
    expiresIn,
    interval: wait,
  };
}

function readAuth(req: string, body: JsonObject): DeviceMessage | null {
  const state = AUTH_STATES.find((entry) => entry === body.state);
  if (!state) return null;
  if (state === "slow_down") {
    const interval = readInterval(body.interval);
    return interval === null ? null : { t: "dev.auth", req, state, interval };
  }
  if (state !== "granted") return { t: "dev.auth", req, state };
  const connections = readConnections(body.connections);
  if (!connections || !isNumber(body.expiresAt)) return null;
  return {
    t: "dev.auth",
    req,
    state,
    expiresAt: body.expiresAt,
    connections,
  };
}

function readResult(req: string, body: JsonObject): DeviceMessage | null {
  const items = readItems(body.items);
  if (!items || !plain(body.label, LABEL_MAX)) return null;
  if (body.truncated !== true && body.truncated !== false) return null;
  return {
    t: "dev.result",
    req,
    label: body.label,
    items,
    truncated: body.truncated,
  };
}

/** One device message by its `t`, or null; `req` is read here, once. */
export function readDeviceMessage(
  t: string,
  body: JsonObject,
): DeviceMessage | null {
  const { req } = body;
  if (!isReq(req)) return null;
  switch (t) {
    case "dev.begin":
      return readBegin(req, body);
    case "dev.poll":
      return isString(body.deviceCode) && DEVICE_CODE.test(body.deviceCode)
        ? { t, req, deviceCode: body.deviceCode }
        : null;
    case "dev.list":
      return { t, req };
    case "dev.call":
      return readCall(req, body);
    case "dev.code":
      return readCode(req, body);
    case "dev.auth":
      return readAuth(req, body);
    case "dev.conns": {
      const connections = readConnections(body.connections);
      return connections ? { t, req, connections } : null;
    }
    case "dev.result":
      return readResult(req, body);
    case "dev.error": {
      const error = ERROR_CODES.find((entry) => entry === body.error);
      return error ? { t, req, error } : null;
    }
    default:
      return readDeviceResetMessage(t, body);
  }
}

/** Whether a channel message is one of the device vocabulary's. */
export function isDeviceMessage(
  message: Readonly<{ t: string }>,
): message is DeviceMessage {
  return message.t.startsWith("dev.");
}

/** Whether a message is one of the four things a device may ask. */
export function isDeviceRequest(
  message: Readonly<{ t: string }>,
): message is DeviceRequest {
  return (
    message.t === "dev.begin" ||
    message.t === "dev.poll" ||
    message.t === "dev.list" ||
    message.t === "dev.call" ||
    message.t === "dev.reset" ||
    message.t === "dev.reset.status"
  );
}

/** Whether a message is one of the owner's five answers. */
export function isDeviceReply(
  message: Readonly<{ t: string }>,
): message is DeviceReply {
  return (
    message.t === "dev.code" ||
    message.t === "dev.auth" ||
    message.t === "dev.conns" ||
    message.t === "dev.result" ||
    message.t === "dev.error" ||
    message.t === "dev.reset.grant" ||
    message.t === "dev.reset.ack"
  );
}
