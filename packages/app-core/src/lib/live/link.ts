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
 * - `secret`: 32 random bytes, base64url. It keys the pairing codes and the
 *   carrier topic; alone it cannot read a request (that needs the owner's
 *   key) and cannot make an invite session's inner seal (that needs the code).
 * - `routes`, optional: base64url JSON of the owner's ICE servers, relay-only
 *   switch and carriers, read strictly by `routes.ts`. Absent, the link
 *   names no server:
 *   the two browsers pair by codes the two people pass each other
 *   (`pairing.ts`) and meet directly.
 *
 * Strict on purpose: anything that is not exactly a link is refused here,
 * never sent anywhere to find out.
 */

/** Routes are a few servers, base64url, never a document. */
const ROUTES = /^[A-Za-z0-9_-]{2,6000}$/;
const OWNER = /^[A-Za-z0-9_-]{87}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const LINK_MAX = 8192;

export type LiveLink = Readonly<{
  /** Whether the session also wants the out-of-band code. */
  admission: "invite" | "open";
  /** The owner's session public key, base64url. */
  owner: string;
  /** The link secret, base64url (32 bytes). */
  secret: string;
  /**
   * The routes segment as the link carries it, or null for none. Read it
   * with `linkRoutes` (`routes.ts`, the capability's): the door only needs
   * to know a link when it sees one, and what the routes say is the join
   * screen's to check before anything is contacted.
   */
  routes: string | null;
}>;

/** Read the `live=` value: `v1.<i|o>.<owner>.<secret>[.<routes>]`, or null. */
export function readLiveValue(value: string): LiveLink | null {
  const [version, mode, owner, secret, segment, ...rest] = value
    .trim()
    .split(".");
  if (version !== "v1" || rest.length > 0) return null;
  if (mode !== "i" && mode !== "o") return null;
  if (!owner || !OWNER.test(owner) || !secret || !SECRET.test(secret))
    return null;
  if (segment !== undefined && !ROUTES.test(segment)) return null;
  const routes = segment ?? null;
  return { admission: mode === "i" ? "invite" : "open", owner, secret, routes };
}

/** The `live=` value for a link. */
export function liveValue(link: LiveLink): string {
  const mode = link.admission === "invite" ? "i" : "o";
  const parts = ["v1", mode, link.owner, link.secret];
  if (link.routes) parts.push(link.routes);
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
