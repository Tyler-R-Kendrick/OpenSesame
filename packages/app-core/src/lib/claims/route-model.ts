/**
 * What the `/claim` route shows for an arrival (ADR 0140 plan step 8), with
 * no React: where a ceremony starts, what a pasted link or token is, and the
 * one tray notice a claim's failure is reported through.
 *
 * The ceremony itself is `createClaimCeremony`'s; this module adds only what
 * a surface needs around it, so the words a refusal carries stay the model's
 * (`CLAIM_WORDS`, ceremony-kit's `claimRefusal`) and a screen never writes
 * its own.
 */

import { isClaimToken } from "@opensesame/ceremony-kit";
import { dismissNotice, setStatusNotice } from "../notices.js";
import type { ClaimCeremony, ClaimStart } from "./ceremony.js";
import { type ClaimArrival, readClaimArrival } from "./link.js";
import { claimStash } from "./stash.js";

/** The tray notice a claim reports through, one at a time. */
export const CLAIM_NOTICE = "identity.claim";

/** The label the done mark carries. */
export const CLAIM_ACCEPTED = "Claim accepted";

/** A drop link on an installation that does not carry drops. */
export const DROPS_UNAVAILABLE =
  "Drops are not available on this installation, so this drop link was not opened.";

const TITLE = "Claim";

/**
 * Where an arrival starts. A claim bearer this tab already presented is read
 * back rather than presented again; with nothing on the address, the stash
 * resumes a claim a sign-in interrupted.
 */
export function claimStartFor(
  ceremony: Pick<ClaimCeremony, "start">,
  arrival: ClaimArrival,
): ClaimStart {
  if (arrival.kind !== "claim") return ceremony.start(arrival);
  const saved = claimStash.read();
  const presented = saved?.token === arrival.token && saved.presented;
  return { kind: "load", token: arrival.token, presented };
}

/**
 * What the person pasted: a bare claim token, or a claim or drop link. A
 * link is read the way an arriving address is — its bearer from the
 * fragment, a query-string bearer refused. `null` when the entry is blank;
 * `none` when it is neither a token nor a link that carries one.
 */
export function claimEntry(raw: string): ClaimArrival | null {
  const entry = raw.trim();
  if (!entry) return null;
  if (isClaimToken(entry)) return { kind: "claim", token: entry };
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return { kind: "none" };
  }
  return readClaimArrival(url).arrival;
}

/**
 * Say why a claim (or a drop) stopped, in the tray; the same words mark the
 * page. One notice for the route, so a new failure replaces the last.
 */
export function reportClaim(words: string, title = TITLE): void {
  setStatusNotice({ id: CLAIM_NOTICE, tone: "err", title, body: words });
}

/** A drop link on an installation without drops, said once, in the tray. */
export function reportDropsUnavailable(): void {
  setStatusNotice({
    id: CLAIM_NOTICE,
    tone: "warn",
    title: TITLE,
    body: DROPS_UNAVAILABLE,
  });
}

/** Take a failure down when the person starts over or it succeeds. */
export function clearClaimNotice(): void {
  dismissNotice(CLAIM_NOTICE);
}
