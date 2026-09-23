/**
 * The ambient single sign-on seam (ADR 0130 §4).
 *
 * Core federation, sign-out and the return screen need four things from
 * ambient SSO, and none of them may put `lib/ambient-auth/**` — and through
 * it the Entra SDK — into the entry graph of a deployment that did not
 * select the capability. So core calls through this record, whose defaults
 * describe an installation with ambient SSO off: nothing is auto-signed-in,
 * so there is no auto-auth to suppress, no transaction to cancel and no
 * ambient return to apply.
 *
 * `apps/pages/src/modules/identity.ambient-sso/runtime.ts` installs the real
 * implementations when the capability activates and restores these defaults
 * when its lease ends. Nothing here imports an implementation; a type-only
 * import erases at build and carries no module edge.
 */

import type { AuthenticationIntent } from "./ambient-auth/types.js";
import type { CompletedSignIn } from "./federation.js";

export type AmbientReturnResult = { returnTo?: string };

/** A completed sign-in whose saved intent was the ambient one. */
export type AmbientCompleted = CompletedSignIn & {
  intent: Extract<AuthenticationIntent, { kind: "ambient" }>;
};

export type AmbientAuthSeams = {
  /** Auto sign-in is fenced off after a local sign-out. */
  autoAuthSuppressed: () => boolean;
  /** Lift that fence: the person asked for a sign-in themselves. */
  clearAutoAuthSuppression: () => void;
  /** Raise it, so the next boot does not sign them straight back in. */
  fenceLocalSignOut: () => void;
  /** Abandon every ambient transaction still in flight. */
  cancelAllTransactions: () => void;
  /** Settle a return the ambient road started. */
  applyAmbientReturn: (
    result: AmbientCompleted,
  ) => Promise<AmbientReturnResult>;
};

const OFF: AmbientAuthSeams = {
  autoAuthSuppressed: () => false,
  clearAutoAuthSuppression: () => {},
  fenceLocalSignOut: () => {},
  cancelAllTransactions: () => {},
  applyAmbientReturn: async () => ({}),
};

export const ambientAuthSeams: AmbientAuthSeams = { ...OFF };

/** Restores the defaults; the module's dispose calls this. */
export function resetAmbientAuthSeams(): void {
  Object.assign(ambientAuthSeams, OFF);
}

/**
 * Whether a saved intent is the ambient one. Pure, and deliberately here
 * rather than in the capability's own tree: the return screen has to ask
 * the question before it knows whether the capability is even present.
 */
export function isAmbientIntent(
  intent: AuthenticationIntent | undefined,
): intent is Extract<AuthenticationIntent, { kind: "ambient" }> {
  return intent?.kind === "ambient";
}
