/**
 * An invite to join, as a person holds it (ADR 0044, ADR 0136).
 *
 * An invite is two things that travel separately: a bearer link, and an
 * out-of-band code the owner reads aloud or sends some other way. The link
 * alone opens nothing. This module only reads and shapes them — it never
 * spends one — and it is strict on purpose: a paste that is not an invite is
 * refused here rather than posted somewhere to find out.
 *
 * The link may name the endpoint that minted it (`#token=…&endpoint=…`). That
 * name is untrusted input like everything else in a URL: the ceremony shows
 * it, flags it when it is not this deployment's own endpoint, and never
 * writes it into settings. Inferring the endpoint from the link's *origin*
 * — what the removed ceremony did — was wrong twice: a Pages or ceremonies
 * link is not served by the endpoint, and a pasted link silently re-pointed
 * the whole app's authority at whoever wrote it.
 */

import { maybePage } from "../../ports.js";
import { dismissNotice, setStatusNotice } from "../notices.js";
import { normalizeApiBase } from "../urls.js";

/** `osc_dlg_<offer id>.<random>` — the only bearer the join road spends. */
const INVITE_TOKEN = /^osc_dlg_[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{32,128}$/;

/** The consent code alphabet the Host mints from (`generate_user_code`). */
const CODE_ALPHABET = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;

const SESSION_ID =
  /^(?:session:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** A join request's note: the Host's own bound, in characters (ADR 0079 §7). */
export const NOTE_MAX = 280;

/** Characters as the Host counts them (`chars().count()`), not UTF-16 units. */
export function noteLength(note: string): number {
  return [...note.trim()].length;
}

export type Invite = Readonly<{
  token: string;
  /** The endpoint the link names, normalized — or null when it names none. */
  endpoint: string | null;
}>;

/** What arrived in the address bar, once it has been taken out of it. */
export type CapturedInvite =
  | Readonly<{ kind: "invite"; invite: Invite }>
  /** A bearer in the query string: logged, cached and sent as Referer. */
  | Readonly<{ kind: "leaked" }>;

export function isInviteToken(raw: string): boolean {
  return INVITE_TOKEN.test(raw);
}

function endpointFrom(raw: string | null): string | null {
  if (!raw) return null;
  return normalizeApiBase(raw);
}

function fromFragment(hash: string): Invite | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token")?.trim() ?? "";
  if (!isInviteToken(token)) return null;
  return { token, endpoint: endpointFrom(params.get("endpoint")) };
}

/**
 * Read a pasted invite: a link carrying `#token=`, or the bare token. Any
 * other text is not an invite. A token in a query string is refused — the
 * owner's tool never writes one, and one that arrives that way has already
 * been written to somebody's logs.
 */
export function parseInvite(raw: string): Invite | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (isInviteToken(trimmed)) return { token: trimmed, endpoint: null };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return fromFragment(url.hash);
}

/**
 * Normalize the out-of-band code to the Host's spelling, or null. The Host
 * counts every mismatch toward burning the offer, so a code that cannot be
 * right never leaves the page: case, spaces and the dash are forgiven,
 * anything outside the alphabet is not.
 */
export function normalizeInviteCode(raw: string): string | null {
  const letters = raw.toUpperCase().replace(/[\s-]/g, "");
  if (!CODE_ALPHABET.test(letters)) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** A public session's id, in the Host's canonical spelling, or null. */
export function normalizeSessionId(raw: string): string | null {
  const match = SESSION_ID.exec(raw.trim().toLowerCase());
  return match ? `session:${match[1]}` : null;
}

let captured: CapturedInvite | null = null;

/** `?…` or `#…` with the invite's own parameters taken out, nothing else. */
function without(raw: string, mark: "?" | "#"): string {
  const params = new URLSearchParams(raw.replace(/^[?#]/, ""));
  params.delete("token");
  params.delete("endpoint");
  const rest = params.toString();
  return rest ? `${mark}${rest}` : "";
}

/**
 * Take an invite out of this page's address, once, before anything renders.
 *
 * The bearer leaves history immediately — a reload, a bookmark or a shared
 * screen must not carry it — and is held in memory until the unlock screen
 * asks for it. Only an invite's own parameters are removed: a drop link's
 * `osc_clm_` fragment belongs to the claim route and is left exactly as it
 * arrived, and anything else in the address stays where it was.
 */
export function captureInviteFromPage(): CapturedInvite | null {
  const page = maybePage();
  if (!page) return captured;
  const { pathname, search, hash } = page.location;
  const queried = new URLSearchParams(search).get("token") ?? "";
  if (queried.startsWith("osc_dlg_")) {
    captured = { kind: "leaked" };
    page.replaceUrl(`${pathname}${without(search, "?")}${hash}`);
    return captured;
  }
  const invite = hash ? fromFragment(hash) : null;
  if (!invite) return captured;
  captured = { kind: "invite", invite };
  page.replaceUrl(`${pathname}${search}${without(hash, "#")}`);
  return captured;
}

const arrivals = new Set<() => void>();
const WAITING_NOTICE = "join.invite-waiting";
let watching = false;

/**
 * Keep taking invites out of the address after boot. A link pasted into a
 * tab that already runs the app changes only the fragment — the page never
 * reloads, boot never runs again, and without this the bearer would sit in
 * the address bar for as long as the tab lives.
 */
export function watchInviteArrivals(): void {
  const page = maybePage();
  if (!page || watching) return;
  watching = true;
  page.addEventListener("hashchange", () => {
    const before = captured;
    if (captureInviteFromPage() === before) return;
    // Nobody on screen can open the ceremony (the vault is unlocked): say
    // the invite is waiting rather than swallow it until the next lock.
    if (arrivals.size === 0) {
      setStatusNotice({
        id: WAITING_NOTICE,
        tone: "info",
        title: "An invite is waiting",
        body: "Lock the vault to join with it.",
      });
      return;
    }
    for (const listener of arrivals) listener();
  });
}

/** Hear of an invite captured after boot. Returns the unsubscribe. */
export function onInviteArrival(listener: () => void): () => void {
  arrivals.add(listener);
  return () => {
    arrivals.delete(listener);
  };
}

/** Hand the captured invite to the ceremony, and forget it here. */
export function takeCapturedInvite(): CapturedInvite | null {
  const taken = captured;
  captured = null;
  if (taken) dismissNotice(WAITING_NOTICE);
  return taken;
}

/** Look without taking: a screen deciding whether to open the ceremony. */
export function peekCapturedInvite(): CapturedInvite | null {
  return captured;
}

export function resetCapturedInviteForTests(): void {
  captured = null;
}
