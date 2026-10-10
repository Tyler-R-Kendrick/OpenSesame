/**
 * What crosses between two browsers in a live session, read strictly
 * (ADR 0150 §3–§5).
 *
 * Two vocabularies:
 *
 * - **pairing** — inside the sealed codes two people pass each other: the
 *   joiner's request (a name, a note, the offer its transport made) and the
 *   owner's reply (the answer to that offer). An offer and an answer are
 *   opaque here: the session's transport reads them (`p2p.ts`).
 * - **channel** — the transport's channel once connected: the shared items'
 *   catalog, one-field-at-a-time reveals and copies, and an authorized edit.
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
const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
const REQ = /^[A-Za-z0-9_-]{1,32}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** The most an offer or answer may be, in characters: a WebRTC description fits. */
export const HANDSHAKE_MAX = 48 * 1024;

export const MAX_ITEMS = 200;
export const MAX_FIELDS = 32;
const LABEL_MAX = 120;
export const VALUE_MAX = 16 * 1024;

/** A joiner's request, as sealed in its request code. */
export type JoinRequest = Readonly<{
  id: string;
  name: string;
  note: string;
  /** The offer the joiner's transport made, opaque here. */
  offer: string;
  /**
   * The joiner greets until it holds the catalog, and the owner answers each
   * greeting (ADR 0186). A request from before that has no such field.
   */
  greets: boolean;
}>;

/** The owner's reply, as sealed in its reply code. */
export type JoinReply = Readonly<{
  /** The request it answers. */
  id: string;
  /** The answer the owner's transport made, opaque here. */
  answer: string;
  /**
   * The owner also listens for this seat on a NATS carrier the link names:
   * the joiner may carry the session there, sealed, when no peer route opens
   * (ADR 0167).
   */
  relay?: "nats";
}>;

export type SharePolicy = "read" | "use" | "edit";

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
  /** The joiner, until it holds the catalog: the owner answers with it. */
  | Readonly<{ t: "hello" }>
  | Readonly<{
      t: "reveal" | "copy";
      req: string;
      item: string;
      field: string;
    }>
  | Readonly<{
      t: "edit";
      req: string;
      item: string;
      field: string;
      value: string;
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

/** Whether a transport could take a handshake (`PeerTransport.readsOffer`). */
export type HandshakeReader = (handshake: string) => boolean;

function readHandshake(
  body: JsonObject,
  key: "offer" | "answer",
  reads: HandshakeReader,
): string | null {
  const handshake = body[key];
  return isString(handshake) &&
    handshake.length <= HANDSHAKE_MAX &&
    reads(handshake)
    ? handshake
    : null;
}

/** Absent in a request from before ADR 0186; anything but a boolean refuses it. */
function readGreets(value: BoundaryValue): boolean | null {
  if (value === undefined) return false;
  return value === true || value === false ? value : null;
}

/** Line breaks in a name or note read as the space they stand for. */
const BREAKS = /[\p{Zl}\p{Zp}\t\n\v\f\r\u0085]/gu;
/**
 * What draws nothing, or draws over what is around it: control, format
 * (zero-width, bidi override and isolate, tags, soft hyphen), private-use and
 * lone-surrogate characters, and the blank fillers no font draws.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}ᅟᅠ⠀ㅤﾠ]/gu;

/**
 * A joiner's name or note as the owner may be shown it: nothing that hides
 * or reorders the text around it, runs of space collapsed, none at the ends.
 * The joiner's page applies the same, so both sides read one string.
 */
export function cleanText(text: string): string {
  return text
    .replace(BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Clean text within `max` characters, or null; the raw text is bounded first. */
function readText(value: BoundaryValue, max: number): string | null {
  if (!bounded(value, max * 4)) return null;
  const cleaned = cleanText(value);
  return characters(cleaned) <= max ? cleaned : null;
}

/** The request inside a request code, or null; `reads` judges its offer. */
export function readJoinRequest(
  raw: string,
  reads: HandshakeReader,
): JoinRequest | null {
  const body = parse(raw, HANDSHAKE_MAX + 2048);
  if (!body) return null;
  const { id } = body;
  if (!isString(id) || !REQUEST_ID.test(id)) return null;
  const name = readText(body.name, NAME_MAX);
  const note = readText(body.note, NOTE_MAX);
  const greets = readGreets(body.greets);
  if (!name || note === null || greets === null) return null;
  const offer = readHandshake(body, "offer", reads);
  return offer ? { id, name, note, offer, greets } : null;
}

/** The reply inside a reply code, or null; `reads` judges its answer. */
export function readJoinReply(
  raw: string,
  reads: HandshakeReader,
): JoinReply | null {
  const body = parse(raw, HANDSHAKE_MAX + 1024);
  if (!body) return null;
  const { id } = body;
  if (!isString(id) || !REQUEST_ID.test(id)) return null;
  const answer = readHandshake(body, "answer", reads);
  if (!answer) return null;
  if (body.relay === undefined) return { id, answer };
  return body.relay === "nats" ? { id, answer, relay: "nats" } : null;
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
  if (policy !== "read" && policy !== "use" && policy !== "edit") return null;
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

function readEdit(body: JsonObject): ChannelMessage | null {
  const { req, item, field, value } = body;
  return isReq(req) && isId(item) && isId(field) && bounded(value, VALUE_MAX)
    ? { t: "edit", req, item, field, value }
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
    case "hello":
      return { t };
    case "reveal":
    case "copy":
      return readRequest(t, body);
    case "edit":
      return readEdit(body);
    default:
      return null;
  }
}
