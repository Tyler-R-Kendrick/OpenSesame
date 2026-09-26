/**
 * The two ceremony aliases (`spec/config/ceremony-routes.json` `guest` and
 * `delegate`; ADR 0140 §1, D5, D12), read once at boot.
 *
 * Neither is a ceremony of its own. `/guest` is another name for the guest
 * road on the sign-in and unlock screens, and `/delegate#token=osc_dlg_…` is
 * another name for a Join invite (ADR 0136) — the link the removed
 * ceremonies app printed for a connection delegation, whose bearer is the
 * same `osc_dlg_` token Join spends. So an alias adds no authority path:
 *
 *   - `/delegate`: Join's own capture (`captureInviteFromPage`) takes a
 *     well-formed invite into memory, exactly as an invite at any other path;
 *     then whatever else the fragment held leaves the address too — a
 *     malformed bearer is still a bearer — and the path becomes the base,
 *     where the unlock screen opens the join ceremony with what was taken.
 *   - `/guest`: nothing to take. The address becomes the base and the
 *     arrival is noted, so the guest road — when the operator's "Allow
 *     guests" switch lets it be drawn at all (`guest-access.ts`) — takes the
 *     keyboard. It is pointed at, never pressed: the person still chooses.
 *
 * An alias carries no query either: a `?code=` riding along would be read at
 * the base as a sign-in callback, so it goes with the path.
 */

import { ceremonyPath } from "@opensesame/ceremony-kit";
import { env } from "../host.js";
import { maybePage } from "../ports.js";
import { underBase } from "./device-link.js";
import { captureInviteFromPage } from "./join/invite.js";

export type AliasArrival = "guest" | "delegate" | null;

let guestArrival = false;
let unbindActivity: (() => void) | null = null;

/** `/OpenSesame/` under base `/OpenSesame/`; `/` under `/`. */
function baseRoot(base: string): string {
  return `${base.replace(/\/+$/, "")}/`;
}

/** The alias this address opens, if it is one. */
export function aliasAt(pathname: string, base: string): AliasArrival {
  const at = underBase(pathname, base);
  if (at === ceremonyPath("delegate")) return "delegate";
  if (at === ceremonyPath("guest")) return "guest";
  return null;
}

/**
 * Note a `/guest` arrival, until a guest road takes it — or the person acts
 * first: a key or a press anywhere means somebody is already using the page,
 * and the keyboard is theirs (AGENTS.md §5, never steal focus).
 */
export function noteGuestArrival(): void {
  guestArrival = true;
  const page = maybePage();
  if (!page || unbindActivity) return;
  const forget = () => {
    guestArrival = false;
    unbindActivity?.();
  };
  page.addEventListener("keydown", forget, true);
  page.addEventListener("pointerdown", forget, true);
  unbindActivity = () => {
    page.removeEventListener("keydown", forget, true);
    page.removeEventListener("pointerdown", forget, true);
    unbindActivity = null;
  };
}

/** Look without taking: a guest road deciding whether to wait a frame. */
export function peekGuestArrival(): boolean {
  return guestArrival;
}

/** Hand the arrival to the guest road that takes the keyboard, once. */
export function takeGuestArrival(): boolean {
  const taken = guestArrival;
  guestArrival = false;
  unbindActivity?.();
  return taken;
}

/**
 * Take an alias out of this page's address before anything renders (boot),
 * or when its route mounts on an address boot did not see. Nothing is read
 * on any other path.
 */
export function captureAliasArrivalFromPage(): AliasArrival {
  const page = maybePage();
  if (!page) return null;
  const base = env().BASE_URL || "/";
  const alias = aliasAt(page.location.pathname, base);
  if (alias === null) return null;
  if (alias === "delegate") captureInviteFromPage();
  else noteGuestArrival();
  page.replaceUrl(baseRoot(base));
  return alias;
}

export function resetAliasArrivalForTests(): void {
  guestArrival = false;
  unbindActivity?.();
}
