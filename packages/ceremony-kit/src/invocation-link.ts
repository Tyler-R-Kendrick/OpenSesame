import {
  type AuthenticatorInvocation,
  AuthenticatorInvocationError,
  parseAuthenticatorInvocation,
} from "./authenticator-invocation.js";
import {
  type AuthenticatorInvocationKind,
  isAuthenticatorInvocationKind,
  matchCeremonyPath,
} from "./ceremony-routes.js";

/**
 * The authenticator hand-off link, `/invoke/<kind>?<handle>` (ADR 0140 §2,
 * plan step 10), read without touching a global — the one reader every
 * surface opens an invoke link with, as `readApprovalArrival` is for
 * `/approve/<ref>`.
 *
 * The kind is read raw from the path (never percent-decoded) and must be
 * one the spec lists; the query goes through `parseAuthenticatorInvocation`
 * and nothing else. The spec names no fragment for this route, so one that
 * rode along refuses the link. Whatever the outcome, a query or a fragment
 * leaves the address: the handle is held in memory by the caller.
 *
 * Nothing here fetches: a `request_uri` is handed to the app as it came, and
 * never read by the page that received it.
 */

/** A link longer than a hand-off needs is not read, only dropped. */
const MAX_LINK_LENGTH = 2048;

/** What a hand-off screen says, so a surface writes none of its own. */
export const INVOCATION_LABELS = {
  title: {
    mfa: "Approve with OpenSesame",
    oid4vp: "Present a credential with OpenSesame",
    oid4vci: "Add a credential to OpenSesame",
  } satisfies Record<AuthenticatorInvocationKind, string>,
  /** The screen's heading when there is no request to name. */
  heading: "Authenticator request",
  /** The key that hands the request to the native app. */
  open: "Open OpenSesame",
  /** The browser ceremony a user code falls back to. */
  fallback: "Continue in this browser",
  /** The title a refused link ends under. */
  refused: "OpenSesame did not open",
  /** The handle's row, by the query name it arrived under. */
  handle: {
    user_code: "Code",
    request_id: "Request",
    request_uri: "From",
  } as Readonly<Record<string, string>>,
} as const;

/** Refusals this reader adds to the parser's own. */
export const INVOCATION_WORDS = {
  unknownKind: "Unknown authenticator request.",
  fragment: "This link contains an unsupported parameter.",
  tooLong: "This authenticator link is invalid.",
} as const;

export type InvocationArrival =
  /** Not an invoke link. */
  | { kind: "none" }
  | { kind: "handoff"; invocation: AuthenticatorInvocation }
  /** An unknown kind, or a query the parser refused; `words` say which. */
  | { kind: "refused"; words: string };

/** What arrived, and the relative address to put in its place (`null`: none). */
export type InvocationArrivalRead = {
  arrival: InvocationArrival;
  scrubbed: string | null;
};

const NONE: InvocationArrivalRead = {
  arrival: { kind: "none" },
  scrubbed: null,
};

/** The raw kind segment at the tail of `pathname`, or `null`. */
export function invocationKindAt(pathname: string): string | null {
  return matchCeremonyPath("invoke", pathname)?.kind ?? null;
}

function refused(words: string, scrubbed: string | null) {
  return { arrival: { kind: "refused" as const, words }, scrubbed };
}

/**
 * Read an address: an invoke link's hand-off, and the bare path to put in
 * its place when a query or fragment rode along. An address that is not an
 * invoke path is `none` and left alone.
 */
export function readInvocationArrival(href: string): InvocationArrivalRead {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return NONE;
  }
  const kind = invocationKindAt(url.pathname);
  if (kind === null) return NONE;
  const scrubbed = url.search || url.hash ? url.pathname : null;
  if (!isAuthenticatorInvocationKind(kind)) {
    return refused(INVOCATION_WORDS.unknownKind, scrubbed);
  }
  if (href.length > MAX_LINK_LENGTH) {
    return refused(INVOCATION_WORDS.tooLong, scrubbed);
  }
  if (url.hash !== "") return refused(INVOCATION_WORDS.fragment, scrubbed);
  try {
    const invocation = parseAuthenticatorInvocation(kind, url.search);
    return { arrival: { kind: "handoff", invocation }, scrubbed };
  } catch (error) {
    if (error instanceof AuthenticatorInvocationError) {
      return refused(error.message, scrubbed);
    }
    throw error;
  }
}
