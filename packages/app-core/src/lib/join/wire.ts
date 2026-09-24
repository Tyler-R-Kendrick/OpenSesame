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
  isNumber,
  isString,
} from "@opensesame/os-domain";

const MAX_ITEMS = 32;
const MAX_LIST = 16;
const MAX_SESSIONS = 50;
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;
/**
 * Characters that change how text reads without being text: C0/C1 controls,
 * bidi marks and overrides, line/paragraph separators, zero-width joiners
 * and spaces, invisible operators, the BOM and Unicode tag characters. Text a
 * person reads must say what it says, in the order it says it.
 */
function unsafe(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

/** A list shown in part, with how many entries it did not show. */
export type Shown = Readonly<{ shown: readonly string[]; more: number }>;

export type JoinOfferItem = Readonly<{
  id: string;
  displayName: string;
  providerId: string;
  actions: Shown;
  resources: Shown;
  /** How long an accepted delegation lasts, in seconds, when stated. */
  lifetime: number | null;
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

/**
 * A public session. `admitsOnAsk` is the session's own policy (ADR 0137):
 * whoever asks is seated at once, as an observer holding nothing. Anything
 * the endpoint did not spell exactly that way reads as the operator deciding
 * — the page never promises an admission the endpoint did not state.
 */
export type OpenSession = Readonly<{
  id: string;
  displayName: string;
  admitsOnAsk: boolean;
}>;

export type JoinReceipt = Readonly<{
  id: string;
  decision: "pending" | "admitted" | "refused";
  /** The seat an admission gave, when the endpoint said. */
  mode: "observer" | "participant" | null;
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
  // Code points, not UTF-16 units: a cut never splits a surrogate pair.
  const points = [...value]
    .filter((char) => !unsafe(char.codePointAt(0) ?? 0))
    .join("")
    .trim();
  const chars = [...points];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : points;
}

function id(value: BoundaryValue | undefined): string {
  if (!isString(value) || !ID.test(value)) throw new JoinWireError();
  return value;
}

/**
 * A list the person is consenting to. Never silently cut: past `MAX_LIST`
 * the rest is counted and shown as "+N more", and no length makes an offer
 * unreadable — it was already spent by being looked up.
 */
function texts(value: BoundaryValue | undefined, max: number): Shown {
  if (value === undefined || value === null) return { shown: [], more: 0 };
  if (!Array.isArray(value)) throw new JoinWireError();
  const clean = value.map((entry) => safeText(entry, max)).filter(Boolean);
  return {
    shown: clean.slice(0, MAX_LIST),
    more: Math.max(0, clean.length - MAX_LIST),
  };
}

/** A count carried by the tab's own stash, so a resumed offer loses none. */
function counted(list: Shown, carried: BoundaryValue | undefined): Shown {
  const extra = isNumber(carried) && carried > 0 ? Math.floor(carried) : 0;
  return { shown: list.shown, more: list.more + extra };
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
    actions: counted(texts(value.actions, 64), value.more_actions),
    resources: counted(texts(value.resources, 160), value.more_resources),
    lifetime:
      isNumber(value.expires_in_seconds) && value.expires_in_seconds > 0
        ? value.expires_in_seconds
        : null,
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
        admitsOnAsk: entry.admission === "observer_on_ask",
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
  const mode =
    decision === "admitted" &&
    (body.mode === "observer" || body.mode === "participant")
      ? body.mode
      : null;
  return { id: id(body.id), decision, mode };
}

/** How many delegations a claim minted — the page never needs more. */
export function readClaimed(body: JsonObject): number {
  if (!Array.isArray(body.delegations)) throw new JoinWireError();
  return Math.min(body.delegations.length, MAX_ITEMS);
}
