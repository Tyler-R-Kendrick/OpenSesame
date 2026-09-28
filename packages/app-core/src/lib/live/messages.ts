/**
 * What crosses between two browsers in a live session, read strictly
 * (ADR 0148 §3–§5).
 *
 * Two channels, two vocabularies:
 *
 * - **signal** — NIP-44 encrypted over Nostr relays, before and during the
 *   WebRTC handshake: an ask, the owner's answer, the SDP.
 * - **channel** — the WebRTC data channel once connected: the shared items'
 *   catalog and one-field-at-a-time reveals and copies.
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

export const NAME_MAX = 64;
export const NOTE_MAX = 280;
const SDP_MAX = 48 * 1024;
const PROOF = /^[0-9a-f]{64}$/;
const REQ = /^[A-Za-z0-9_-]{1,32}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const MAX_ITEMS = 200;
export const MAX_FIELDS = 32;
const LABEL_MAX = 120;
export const VALUE_MAX = 16 * 1024;

export type RefusalReason = "declined" | "code" | "ended" | "full";
const REFUSALS: readonly RefusalReason[] = [
  "declined",
  "code",
  "ended",
  "full",
];

export type Signal =
  | Readonly<{ t: "ask"; name: string; note: string; proof: string }>
  | Readonly<{ t: "wait" }>
  | Readonly<{ t: "refuse"; reason: RefusalReason }>
  | Readonly<{ t: "offer"; sdp: string }>
  | Readonly<{ t: "answer"; sdp: string }>
  | Readonly<{ t: "bye" }>;

export type SharePolicy = "read" | "use";

export type SharedField = Readonly<{
  key: string;
  label: string;
  concealed: boolean;
  /** Present only for a field that is not concealed. */
  value: string | null;
}>;

export type SharedItem = Readonly<{
  id: string;
  name: string;
  type: string;
  fields: readonly SharedField[];
}>;

export type Catalog = Readonly<{
  title: string;
  policy: SharePolicy;
  /** Epoch milliseconds. */
  expiresAt: number;
  items: readonly SharedItem[];
}>;

export type ChannelMessage =
  | Readonly<{ t: "catalog"; catalog: Catalog }>
  | Readonly<{ t: "value"; req: string; value: string }>
  | Readonly<{ t: "denied"; req: string }>
  | Readonly<{ t: "end" }>
  | Readonly<{
      t: "reveal" | "copy";
      req: string;
      item: string;
      field: string;
    }>;

/** Code points, not UTF-16 units: an emoji is one character. */
export function characters(text: string): number {
  return [...text].length;
}

function bounded(value: BoundaryValue, max: number): value is string {
  return isString(value) && characters(value) <= max;
}

function parse(raw: string, limit: number): JsonObject | null {
  if (raw.length > limit) return null;
  try {
    const value: BoundaryValue = JSON.parse(raw);
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

function readSdp(body: JsonObject): string | null {
  const { sdp } = body;
  return isString(sdp) && sdp.length <= SDP_MAX && sdp.startsWith("v=0")
    ? sdp
    : null;
}

function readAsk(body: JsonObject): Signal | null {
  const { name, note, proof } = body;
  if (!bounded(name, NAME_MAX) || !bounded(note, NOTE_MAX)) return null;
  if (!isString(proof) || !PROOF.test(proof)) return null;
  return { t: "ask", name: name.trim(), note: note.trim(), proof };
}

/** One signalling message, or null. */
export function readSignal(raw: string): Signal | null {
  const body = parse(raw, SDP_MAX + 1024);
  if (!body) return null;
  switch (body.t) {
    case "ask":
      return readAsk(body);
    case "wait":
    case "bye":
      return { t: body.t };
    case "refuse": {
      const reason = REFUSALS.find((entry) => entry === body.reason);
      return reason ? { t: "refuse", reason } : null;
    }
    case "offer":
    case "answer": {
      const sdp = readSdp(body);
      return sdp ? { t: body.t, sdp } : null;
    }
    default:
      return null;
  }
}

function readField(value: BoundaryValue): SharedField | null {
  if (!isJsonObject(value)) return null;
  const { key, label, concealed } = value;
  if (!isString(key) || !ID.test(key) || !bounded(label, LABEL_MAX))
    return null;
  if (concealed !== true && concealed !== false) return null;
  if (concealed) return { key, label, concealed, value: null };
  const shown = value.value;
  if (!bounded(shown, VALUE_MAX)) return null;
  return { key, label, concealed, value: shown };
}

function readItem(value: BoundaryValue): SharedItem | null {
  if (!isJsonObject(value)) return null;
  const { id, name, type, fields } = value;
  if (!isString(id) || !ID.test(id) || !bounded(name, LABEL_MAX)) return null;
  if (!isString(type) || !ID.test(type) || !Array.isArray(fields)) return null;
  if (fields.length > MAX_FIELDS) return null;
  const read = fields.map(readField);
  if (read.some((field) => field === null)) return null;
  return { id, name, type, fields: read.filter((field) => field !== null) };
}

function readCatalog(value: BoundaryValue): Catalog | null {
  if (!isJsonObject(value)) return null;
  const { title, policy, expiresAt, items } = value;
  if (!bounded(title, LABEL_MAX) || !isNumber(expiresAt)) return null;
  if (policy !== "read" && policy !== "use") return null;
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return null;
  const read = items.map(readItem);
  if (read.some((item) => item === null)) return null;
  return {
    title,
    policy,
    expiresAt,
    items: read.filter((item) => item !== null),
  };
}

function isReq(value: BoundaryValue): value is string {
  return isString(value) && REQ.test(value);
}

function isId(value: BoundaryValue): value is string {
  return isString(value) && ID.test(value);
}

function readRequest(
  t: "reveal" | "copy",
  body: JsonObject,
): ChannelMessage | null {
  const { req, item, field } = body;
  return isReq(req) && isId(item) && isId(field)
    ? { t, req, item, field }
    : null;
}

/** One data-channel message, or null. */
export function readChannelMessage(raw: string): ChannelMessage | null {
  const body = parse(raw, 1024 * 1024);
  if (!body) return null;
  const { t, req } = body;
  switch (t) {
    case "catalog": {
      const catalog = readCatalog(body.catalog);
      return catalog ? { t, catalog } : null;
    }
    case "value":
      return isReq(req) && bounded(body.value, VALUE_MAX)
        ? { t, req, value: body.value }
        : null;
    case "denied":
      return isReq(req) ? { t, req } : null;
    case "end":
      return { t };
    case "reveal":
    case "copy":
      return readRequest(t, body);
    default:
      return null;
  }
}
