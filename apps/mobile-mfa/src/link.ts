import {
  InteractionLinkError,
  parseInteractionUrl,
  parseLegacyInteractionLink,
  readFragmentToken,
  scrubFragment,
} from "@opensesame/ceremony-kit";

/**
 * What this app was opened on (ADR 0086).
 *
 * Every rule here used to be a private parser in `App.tsx` that disagreed with
 * the ceremonies app on all four of its answers: it read the whole `href`
 * instead of the query, accepted `?code=` as a second spelling nobody had
 * chosen, special-cased `opensesame-mfa://` in a branch that then did exactly
 * what the fallback did, and never scrubbed the fragment at all. All four are
 * now `@opensesame/ceremony-kit`'s, which means one link vocabulary and one
 * place to fix it — the whole point of ADR 0086 §2.
 *
 * The one thing this module still owns is browser contact: `window.location`
 * and `history.replaceState`. The kit is deliberately global-free, so somebody
 * has to be the surface that touches them, and it is better that it is fifteen
 * lines here than a global reach from inside shared logic.
 */

/**
 * The alphabet a claim id must match before this screen will echo it.
 *
 * A claim id arrives from whoever wrote the link, and the only thing this app
 * does with one is print it in a dead-end hint. Pinning the alphabet is what
 * stops that hint from becoming a place to render somebody else's sentence;
 * anything outside it is dropped and the hint shows without the id.
 */
const CLAIM_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export type OpenedLink =
  /** No link: the standalone enrolment surface. */
  | { kind: "none" }
  /** The canonical `https://…/i/<ref>` form. */
  | { kind: "interaction"; ref: string }
  /** One of the four shapes that predate the canonical form. */
  | { kind: "legacy"; userCode: string; claimId?: string }
  /** The link carried credential material and must not be acted on. */
  | { kind: "refused" };

/**
 * Take the fragment out of the address bar, and say whether it held a bearer.
 *
 * Unconditional, and first: `apps/ceremonies` scrubs before it makes any call,
 * and the reason generalises to every surface. A fragment survives in
 * `history`, in a screenshot, in whatever the next `pushState` inherits, and
 * in a "share this page" sheet, and the window in which it is still there is
 * exactly the window in which the app is about to start doing things.
 *
 * A `#token=` fragment is a *claim* link (ADR 0045) that has been pointed at
 * the wrong app. Reporting it is what turns that into a visible refusal rather
 * than a token this app silently ignores while it stays on the clipboard.
 */
function scrubAndDetectBearer(): boolean {
  const { hash, pathname, search } = window.location;
  if (hash.length === 0) return false;
  const carriedBearer = readFragmentToken(hash) !== null;
  window.history.replaceState(null, "", scrubFragment(pathname, search));
  return carriedBearer;
}

/** The `claim_id` a legacy link carried, when it is safe to print. */
function readClaimId(href: string): string | undefined {
  const raw = new URL(href).searchParams.get("claim_id");
  if (raw === null || !CLAIM_ID.test(raw)) return undefined;
  return raw;
}

/**
 * Classify the address this app was opened on.
 *
 * Canonical first, legacy second, and nothing else: a shape that is neither is
 * `none`, because the app has a perfectly good standalone surface and guessing
 * at a half-recognised link is how a wrong ceremony gets started.
 *
 * `parseLegacyInteractionLink` throws rather than returning `null` when the
 * href names credential material, and that distinction is carried through
 * here: a link with no user code is simply not a link (`none`), while a link
 * with `?token=` is a link that should never have existed (`refused`).
 */
export function readOpenedLink(): OpenedLink {
  if (scrubAndDetectBearer()) return { kind: "refused" };
  const href = window.location.href;
  const canonical = parseInteractionUrl(href);
  if (canonical !== null) return { kind: "interaction", ref: canonical.ref };
  try {
    const legacy = parseLegacyInteractionLink(href);
    if (legacy === null) return { kind: "none" };
    const claimId = readClaimId(href);
    return claimId === undefined
      ? { kind: "legacy", userCode: legacy.userCode }
      : { kind: "legacy", userCode: legacy.userCode, claimId };
  } catch (e) {
    if (e instanceof InteractionLinkError) return { kind: "refused" };
    throw e;
  }
}
