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
import {
  type NoticeOpen,
  appendStatusNotice,
  dismissNotice,
} from "../notices.js";
import type { ClaimCeremony, ClaimStart } from "./ceremony.js";
import { showClaimDropBanner } from "./claim-drop-banner.js";
import { type ClaimArrival, readClaimArrival } from "./link.js";
import { claimStash } from "./stash.js";

/** Tray rows for claim and drop outcomes share this id prefix. */
export const CLAIM_NOTICE = "identity.claim";

/** Status glyph on the page — the tray carries the full sentence (ADR 0163). */
export const CLAIM_FAILURE_MARK = "Claim could not continue";
export const DROP_FAILURE_MARK = "Drop could not open";
/** Glyph label when a drop fails; the tray holds the full refusal (ADR 0163). */
export const DROP_FAILURE_MARK_WITH_TRAY = `${DROP_FAILURE_MARK}. Full message in the bell`;

/** The label the done mark carries. */
export const CLAIM_ACCEPTED = "Claim accepted";

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

function unlockOpen(words: string): NoticeOpen | undefined {
  if (/\b(unlock|locked)\b/i.test(words)) {
    return { to: "/unlock", label: "Unlock" };
  }
  return undefined;
}

/**
 * Say why a claim (or a drop) stopped — in the tray only; the page keeps a
 * status glyph. Each outcome is its own notice so history survives reload.
 */
export function reportClaim(words: string, title = TITLE): void {
  appendStatusNotice({
    id: `${CLAIM_NOTICE}.${crypto.randomUUID()}`,
    tone: "err",
    title,
    body: words,
    open: unlockOpen(words),
  });
  showClaimDropBanner({ title, body: words });
}

/** Legacy single-slot id; new outcomes are not removed when the field clears. */
export function clearClaimNotice(): void {
  dismissNotice(CLAIM_NOTICE);
}
