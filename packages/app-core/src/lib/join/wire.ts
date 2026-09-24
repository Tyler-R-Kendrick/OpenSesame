/**
 * The join road's wire shapes, read defensively (ADR 0136).
 *
 * Every body here comes from an endpoint a link may have named, so it is
 * bounded before it is believed: a count cap on every list, a length cap on
 * every string, control characters stripped, identifiers held to the grammar
 * the Host mints. An offer that references an item it does not carry is
 * refused whole — rendering half of a manifest is how a person consents to
 * something they were not shown.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

const MAX_ITEMS = 32;
const MAX_LIST = 16;
const MAX_SESSIONS = 50;
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;
// Control characters and bidi overrides: text a person reads must say what
// it says, in the order it says it.
function unsafe(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

export type JoinOfferItem = Readonly<{
  id: string;
  displayName: string;
  providerId: string;
  actions: readonly string[];
  resources: readonly string[];
  required: boolean;
  dependencies: readonly string[];
}>;

export type JoinOffer = Readonly<{
  id: string;
  manifestDigest: string;
  /** Epoch milliseconds, or null when the endpoint did not say. */
  expiresAt: number | null;
  items: readonly JoinOfferItem[];
}>;

export type OpenSession = Readonly<{ id: string; displayName: string }>;

export type JoinReceipt = Readonly<{
  id: string;
  decision: "pending" | "admitted" | "refused";
}>;

export class JoinWireError extends Error {
  constructor() {
    super("The endpoint answered with something that is not an invite.");
    this.name = "JoinWireError";
  }
}

export function safeText(
  value: BoundaryValue | undefined,
  max: number,
): string {
  if (!isString(value)) return "";
  const clean = [...value]
    .filter((char) => !unsafe(char.codePointAt(0) ?? 0))
    .join("")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function id(value: BoundaryValue | undefined): string {
  if (!isString(value) || !ID.test(value)) throw new JoinWireError();
  return value;
}

function texts(value: BoundaryValue | undefined, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST * 4)
    throw new JoinWireError();
  return value
    .slice(0, MAX_LIST)
    .map((entry) => safeText(entry, max))
    .filter(Boolean);
}

function ids(value: BoundaryValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS)
    throw new JoinWireError();
  return value.map((entry) => id(entry));
}

function item(value: BoundaryValue): JoinOfferItem {
  if (!isJsonObject(value)) throw new JoinWireError();
  return {
    id: id(value.id),
    displayName:
      safeText(value.display_name, 80) ||
      safeText(value.provider_id, 80) ||
      "Unnamed connection",
    providerId: safeText(value.provider_id, 64),
    actions: texts(value.actions, 64),
    resources: texts(value.resources, 160),
    required: value.required === true,
    dependencies: ids(value.dependencies),
  };
}

function expiry(value: BoundaryValue | undefined): number | null {
  if (!isString(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** `{ offer: OfferView }` from `POST /api/v1/delegations/present`. */
export function readOffer(body: JsonObject): JoinOffer {
  const offer = body.offer;
  if (!isJsonObject(offer) || !Array.isArray(offer.items))
    throw new JoinWireError();
  if (offer.items.length === 0 || offer.items.length > MAX_ITEMS)
    throw new JoinWireError();
  const items = offer.items.map(item);
  const known = new Set(items.map((entry) => entry.id));
  if (known.size !== items.length) throw new JoinWireError();
  for (const entry of items) {
    if (entry.dependencies.some((dep) => !known.has(dep) || dep === entry.id))
      throw new JoinWireError();
  }
  return {
    id: id(offer.id),
    manifestDigest: safeText(offer.manifest_digest, 80),
    expiresAt: expiry(offer.expires_at),
    items,
  };
}

/** `{ sessions: [...] }` from `GET /api/v1/shared-sessions?visibility=public`. */
export function readOpenSessions(body: JsonObject): OpenSession[] {
  if (!Array.isArray(body.sessions)) throw new JoinWireError();
  return body.sessions.slice(0, MAX_SESSIONS).flatMap((entry) => {
    if (!isJsonObject(entry) || !isString(entry.id) || !ID.test(entry.id))
      return [];
    return [
      {
        id: entry.id,
        displayName: safeText(entry.display_name, 80) || entry.id,
      },
    ];
  });
}

/** `{ id, decision }` from `POST …/join-requests`. */
export function readReceipt(body: JsonObject): JoinReceipt {
  const decision = body.decision;
  if (
    decision !== "pending" &&
    decision !== "admitted" &&
    decision !== "refused"
  )
    throw new JoinWireError();
  return { id: id(body.id), decision };
}

/** How many delegations a claim minted — the page never needs more. */
export function readClaimed(body: JsonObject): number {
  if (!Array.isArray(body.delegations)) throw new JoinWireError();
  return Math.min(body.delegations.length, MAX_ITEMS);
}
