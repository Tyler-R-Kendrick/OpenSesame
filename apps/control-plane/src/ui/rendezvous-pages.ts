import type { Continuation } from "../interactions/rendezvous.js";
import { escapeHtml } from "../middleware/security-headers.js";
import { sharedStyles } from "./interaction-pages.js";

/**
 * The public landing pages for `/i/<ref>` (ADR 0086 §2).
 *
 * Server-rendered, script-free, everything escaped — reached by a camera, a
 * wallet pass, a pasted link and whoever picked up the printout, under the
 * `claimPageSecurityHeaders` CSP (`default-src 'none'; style-src
 * 'unsafe-inline'`). They wear the product skin (`sharedStyles`) so the road
 * from a scanned code into the ceremony does not visibly change hands.
 *
 * A landing page says what *kind* of question waits and when it lapses, and it
 * offers a way to continue — but it discloses nothing about who is asking whom
 * for what, and it carries nothing but the opaque reference onward. Holding
 * one authorizes nothing, and the page must never imply otherwise.
 */

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>${sharedStyles}</style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

/** What a live landing page renders: kind prose, status, expiry, continuation. */
export interface RendezvousLandingModel {
  /** Plain words for the kind, e.g. "approve a device". Never the request. */
  kindProse: string;
  /** The interaction's current status, for display only. */
  status: string;
  /** RFC 3339 expiry, already rendered by the caller. */
  expiresAtISO: string;
  /** How to continue: launch the client app, or read as an address. */
  continuation: Continuation;
}

/**
 * The continuation block.
 *
 * Launcher mode is a single primary link into the client app carrying only the
 * reference — a `<a>`, not a form, so `form-action 'self'` never touches it and
 * the cross-origin navigation a click starts is allowed. Address mode is prose:
 * the reference is not a link to follow, it is a name that surfaces in the
 * reader's own inbox once they are signed in.
 */
function continuationBlock(continuation: Continuation): string {
  if (continuation.mode === "launcher") {
    const href = escapeHtml(continuation.url);
    return `<div class="panel">
       <p>Continue on this device to see what is being asked and answer it.</p>
       <p><a class="btn btn-primary" href="${href}">Open in OpenSesame</a></p>
       <p class="note">Opening OpenSesame carries only this reference — never the request.</p>
     </div>`;
  }
  return `<div class="panel">
       <p>This reference will appear in your inbox once you sign in to OpenSesame on a device.</p>
       <p class="note">The link itself grants nothing; open OpenSesame to answer.</p>
     </div>`;
}

/** The page a person lands on after scanning a live reference. */
export function renderRendezvousLanding(model: RendezvousLandingModel): string {
  return pageShell(
    "OpenSesame",
    `<h1>Someone is asking you to ${escapeHtml(model.kindProse)}</h1>
     <p class="lede">Status: ${escapeHtml(model.status)}. This request lapses at ${escapeHtml(model.expiresAtISO)}.</p>
     ${continuationBlock(model.continuation)}`,
  );
}

/** The refusals a landing page renders, one per terminal state a scan can hit. */
export type RendezvousRefusal = "not_found" | "expired" | "rate_limited";

const REFUSAL_COPY = {
  not_found: {
    title: "Nothing to approve",
    lede: "This link is not valid, or the request behind it is gone.",
  },
  expired: {
    title: "This request has expired",
    lede: "Start it again from the device that asked.",
  },
  rate_limited: {
    title: "Too many requests",
    lede: "Try opening this link again in a moment.",
  },
} satisfies Record<RendezvousRefusal, { title: string; lede: string }>;

/** A refusal page. No continuation: there is nothing left to continue into. */
export function renderRendezvousRefusal(kind: RendezvousRefusal): string {
  const copy = REFUSAL_COPY[kind];
  return pageShell(
    "OpenSesame",
    `<h1>${escapeHtml(copy.title)}</h1>
     <p class="lede">${escapeHtml(copy.lede)}</p>`,
  );
}
