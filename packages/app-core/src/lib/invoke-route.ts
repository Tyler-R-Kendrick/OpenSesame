/**
 * What the `/invoke/:kind` route shows for an arrival (ADR 0140 plan step
 * 10), with no React: the hand-off a link carried, or the words it was
 * refused in, and the one tray notice a refusal is reported through. The
 * words are ceremony-kit's (`invocation-link.ts`, `authenticator-invocation.ts`).
 *
 * The route hands a request on and does nothing else: no Identity API call,
 * no vault, and never a fetch of a `request_uri` or a credential offer.
 */

import {
  INVOCATION_LABELS,
  INVOCATION_WORDS,
  type InvocationArrival,
  invocationKindAt,
} from "@opensesame/ceremony-kit";
import { dismissNotice, setStatusNotice } from "./notices.js";

export { INVOCATION_LABELS };

export type InvocationEntry = Exclude<InvocationArrival, { kind: "none" }>;

/**
 * Where `pathname` starts. What was read at boot answers only for the kind
 * it was read under; anything else — a route reached with nothing held for
 * it — is a link that cannot be handed on.
 */
export function invocationEntry(
  held: { arrival: InvocationArrival; at: string },
  pathname: string,
): InvocationEntry {
  const kind = invocationKindAt(pathname);
  if (
    held.arrival.kind !== "none" &&
    kind !== null &&
    invocationKindAt(held.at) === kind
  ) {
    return held.arrival;
  }
  return { kind: "refused", words: INVOCATION_WORDS.tooLong };
}

/** The tray notice a refused hand-off reports through, one at a time. */
export const INVOCATION_NOTICE = "identity.invocation";

/** Say why a link was refused, in the tray; the same words mark the page. */
export function reportInvocation(words: string): void {
  setStatusNotice({
    id: INVOCATION_NOTICE,
    tone: "err",
    title: INVOCATION_LABELS.refused,
    body: words,
  });
}

export function clearInvocationNotice(): void {
  dismissNotice(INVOCATION_NOTICE);
}
