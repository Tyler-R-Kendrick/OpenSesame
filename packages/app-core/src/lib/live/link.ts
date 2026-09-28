/**
 * A live-session link, as a person holds it (ADR 0148).
 *
 * `#live=v1.<i|o>.<owner>.<secret>[.<relays>]` — in the fragment, which a
 * browser never sends to the server hosting the app:
 *
 * - `i` / `o`: an invite session, which also wants the out-of-band code, or
 *   an open one, which admits whoever holds the link. Saying so lets the
 *   joiner's page ask for a code only when one exists — a missing code would
 *   otherwise count as a miss.
 * - `owner`: the session's ephemeral public key (32-byte x-only secp256k1,
 *   hex). Every message a joiner accepts is signed by it, so a link holder
 *   cannot pose as the owner.
 * - `secret`: 32 random bytes, base64url. A joiner proves it holds the link
 *   with it; alone it opens nothing in an invite-mode session.
 * - `relays`: optional, base64url of a JSON array of `wss://` relay URLs, for
 *   an owner who does not use the defaults.
 *
 * Strict on purpose: anything that is not exactly a link is refused here,
 * never sent anywhere to find out.
 */

import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { kvGet, kvSet } from "../kv.js";

const OWNER = /^[0-9a-f]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const B64URL = /^[A-Za-z0-9_-]{1,2048}$/;
export const MAX_RELAYS = 5;

export type LiveLink = Readonly<{
  /** Whether the session also wants the out-of-band code. */
  admission: "invite" | "open";
  /** The owner's session key, x-only hex. */
  owner: string;
  /** The link secret, base64url (32 bytes). */
  secret: string;
  /** The relays the owner named; empty means the configured defaults. */
  relays: readonly string[];
}>;

/** A relay a page may open: `wss://`, or `ws://` to this machine for tests. */
export function isRelayUrl(raw: string): boolean {
  if (raw.length > 200) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || url.search) return false;
  if (url.protocol === "wss:") return true;
  return (
    url.protocol === "ws:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

function b64urlDecode(raw: string): string | null {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
}

function b64urlEncode(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function relaysFrom(raw: string | undefined): string[] | null {
  if (raw === undefined) return [];
  if (!B64URL.test(raw)) return null;
  const decoded = b64urlDecode(raw);
  if (decoded === null) return null;
  let list: BoundaryValue;
  try {
    list = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_RELAYS)
    return null;
  const relays: string[] = [];
  for (const entry of list) {
    if (!isString(entry) || !isRelayUrl(entry)) return null;
    relays.push(entry);
  }
  return relays;
}

/** Read the `live=` value: `v1.<i|o>.<owner>.<secret>[.<relays>]`, or null. */
export function readLiveValue(value: string): LiveLink | null {
  const [version, mode, owner, secret, relays, ...rest] = value
    .trim()
    .split(".");
  if (version !== "v1" || rest.length > 0) return null;
  if (mode !== "i" && mode !== "o") return null;
  if (!owner || !OWNER.test(owner) || !secret || !SECRET.test(secret))
    return null;
  const named = relaysFrom(relays);
  if (!named) return null;
  const admission = mode === "i" ? "invite" : "open";
  return { admission, owner, secret, relays: named };
}

/** The `live=` value for a link. */
export function liveValue(link: LiveLink): string {
  const mode = link.admission === "invite" ? "i" : "o";
  const parts = ["v1", mode, link.owner, link.secret];
  if (link.relays.length > 0)
    parts.push(b64urlEncode(JSON.stringify(link.relays)));
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
  if (!trimmed || trimmed.length > 4096) return null;
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

const RELAYS_KEY = "live.relays.v1";

/** Well-formed relay addresses only, at most `MAX_RELAYS`; else none. */
export function readRelays(value: BoundaryValue): string[] {
  if (!Array.isArray(value) || value.length > MAX_RELAYS) return [];
  const relays: string[] = [];
  for (const entry of value) {
    if (!isString(entry) || !isRelayUrl(entry.trim())) return [];
    relays.push(entry.trim());
  }
  return relays;
}

/**
 * The relays a live session hosted on this device meets on — Settings ›
 * Capabilities' `liveRelays` (ADR 0148 §6). Empty: the built-in public ones.
 * Device configuration, like the other endpoints, so plaintext.
 */
export function loadLiveRelays(): string[] {
  try {
    const raw = kvGet(RELAYS_KEY);
    return raw ? readRelays(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveLiveRelays(relays: readonly string[]): void {
  kvSet(RELAYS_KEY, JSON.stringify(readRelays([...relays])));
}
