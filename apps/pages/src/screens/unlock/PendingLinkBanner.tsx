/**
 * Pre-unlock surface for the last sign-in's outcome — and, since the account
 * menu gained its exits, for the last sign-out: "signed out", "choose the
 * account to sign in with", "choose an account to attach".
 *
 * The notifications bell only exists inside the unlocked shell, so a sign-in
 * that came back to a locked vault used to vanish without a word — the
 * literal "the Google button just fails" bug. This banner renders the stored
 * outcome right on the unlock screen instead. (An empty vault no longer lands
 * here: the return screen opens it and the person goes straight into the app.
 * A deferred account link gets no banner either — the bell's "Finish
 * attaching your sign-in" prompt is already waiting after unlock.)
 */

import {
  clearAuthOutcome,
  readAuthOutcome,
} from "@opensesame/app-core/lib/auth-outcome.js";
import { recoverPendingFederatedLink } from "@opensesame/app-core/lib/guest-auth.js";
import { signOut } from "@opensesame/app-core/lib/session-exit.js";
import { describeOutcome } from "@opensesame/app-core/screens/unlock/pending-link-banner-model.js";
import { useEffect, useReducer } from "react";

export function PendingLinkBanner() {
  // A reload drops in-memory notices while the assertion lives on in
  // sessionStorage — re-raise the pending-link prompt for the bell.
  // Idempotent, and a no-op unless a link is actually outstanding.
  useEffect(() => {
    recoverPendingFederatedLink();
  }, []);

  const [, bump] = useReducer((epoch: number) => epoch + 1, 0);

  const outcome = readAuthOutcome();
  if (!outcome) return null;
  const model = describeOutcome(outcome);

  return (
    <output
      className={
        model.tone === "plain"
          ? "note unlock__outcome"
          : `note note--${model.tone} unlock__outcome`
      }
      aria-live="polite"
    >
      <span>{model.text}</span>
      {outcome.kind === "authenticated" ? (
        <button
          type="button"
          className="btn"
          onClick={() => {
            signOut();
            bump();
          }}
        >
          Sign out
        </button>
      ) : null}
      <button
        type="button"
        className="icon-btn unlock__outcome-dismiss"
        aria-label="Dismiss"
        onClick={() => {
          clearAuthOutcome();
          bump();
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </output>
  );
}
