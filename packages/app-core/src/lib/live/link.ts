/**
 * A live-session link, as a person holds it (ADR 0150).
 *
 * `#live=v1.<i|o>.<owner>.<secret>[.<routes>]` — in the fragment, which a
 * browser never sends to the server hosting the app:
 *
 * - `i` / `o`: an invite session, which also wants the out-of-band code, or
 *   an open one, which admits whoever holds the link. Saying so lets the
 *   joiner's page ask for a code only when one exists.
 * - `owner`: the session's ECDH P-256 public key (raw point, base64url).
 *   Requests are sealed to it and replies can only come from it, so a link
 *   holder can neither read another joiner's request nor pose as the owner.
 * - `secret`: 32 random bytes, base64url. It keys the pairing codes; alone it
 *   opens nothing in an invite session.
 * - `routes`, optional: base64url JSON of the owner's ICE servers, relay-only
 *   switch and carriers (`transport.ts`). Absent, the link names no server:
 *   the two browsers pair by codes the two people pass each other
 *   (`pairing.ts`) and meet directly.
 *
 * Strict on purpose: anything that is not exactly a link is refused here,
 * never sent anywhere to find out.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { fromB64url, toB64url } from "./b64.js";
import { type LiveRoutes, NO_ROUTES, hasRoutes, readRoutes } from "./routes.js";

const OWNER = /^[A-Za-z0-9_-]{87}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
/** Routes are a few servers, never a document. */
const ROUTES_MAX = 6000;
const LINK_MAX = 8192;

export type LiveLink = Readonly<{
  /** Whether the session also wants the out-of-band code. */
  admission: "invite" | "open";
  /** The owner's session public key, base64url. */
  owner: string;
  /** The link secret, base64url (32 bytes). */
  secret: string;
  /** How the joiner reaches the owner beyond a direct route. */
  routes: LiveRoutes;
}>;

function decodeRoutes(segment: string): LiveRoutes | null {
  if (segment.length > ROUTES_MAX) return null;
  const bytes = fromB64url(segment);
  if (!bytes) return null;
  try {
    const value: BoundaryValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return readRoutes(value);
  } catch {
    return null;
  }
}

function encodeRoutes(routes: LiveRoutes): string {
  const value: Record<string, BoundaryValue> = {};
  if (routes.ice.length > 0)
    value.ice = routes.ice.map((server) => ({
      ...server,
      urls: [...server.urls],
    }));
  if (routes.relay) value.relay = true;
  if (routes.carriers.length > 0)
    value.carriers = routes.carriers.map((carrier) => ({ ...carrier }));
  return toB64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Read the `live=` value: `v1.<i|o>.<owner>.<secret>[.<routes>]`, or null. */
export function readLiveValue(value: string): LiveLink | null {
  const [version, mode, owner, secret, segment, ...rest] = value
    .trim()
    .split(".");
  if (version !== "v1" || rest.length > 0) return null;
  if (mode !== "i" && mode !== "o") return null;
  if (!owner || !OWNER.test(owner) || !secret || !SECRET.test(secret))
    return null;
  const routes = segment === undefined ? NO_ROUTES : decodeRoutes(segment);
  if (!routes) return null;
  return { admission: mode === "i" ? "invite" : "open", owner, secret, routes };
}

/** The `live=` value for a link. */
export function liveValue(link: LiveLink): string {
  const mode = link.admission === "invite" ? "i" : "o";
  const parts = ["v1", mode, link.owner, link.secret];
  if (hasRoutes(link.routes)) parts.push(encodeRoutes(link.routes));
  return parts.join(".");
}

/** The whole link, on this app's own address. */
export function formatLiveLink(appUrl: string, link: LiveLink): string {
  const url = new URL(appUrl);
  url.search = "";
  url.hash = `live=${liveValue(link)}`;
  return url.toString();
}

/** A pasted link (`…#live=…`) or the bare value, or null. */
export function parseLiveLink(raw: string): LiveLink | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > LINK_MAX) return null;
  if (trimmed.startsWith("v1.")) return readLiveValue(trimmed);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const value = new URLSearchParams(url.hash.replace(/^#/, "")).get("live");
  return value ? readLiveValue(value) : null;
}

let held: LiveLink | null = null;

/**
 * Hand a link from the door to the live-join screen: the door is core and
 * the screen is the capability's, so the link waits here, in memory only,
 * for the screen to take it once.
 */
export function holdLiveLink(link: LiveLink | null): void {
  held = link;
}

export function takeHeldLiveLink(): LiveLink | null {
  const taken = held;
  held = null;
  return taken;
}
