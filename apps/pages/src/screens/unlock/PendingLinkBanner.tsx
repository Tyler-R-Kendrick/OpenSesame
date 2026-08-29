/**
 * Pre-unlock surface for the last sign-in's outcome.
 *
 * The notifications bell only exists inside the unlocked shell, so a sign-in
 * that came back to a locked vault used to vanish without a word — the
 * literal "the Google button just fails" bug. This banner renders the stored
 * outcome right on the unlock screen instead. (An empty vault no longer lands
 * here: the return screen opens it and the person goes straight into the app.
 * A deferred account link gets no banner either — the bell's "Finish
 * attaching your sign-in" prompt is already waiting after unlock.)
 */

import { useEffect, useReducer } from "react";
import {
  type AuthOutcome,
  clearAuthOutcome,
  readAuthOutcome,
} from "../../lib/auth-outcome.js";
import { recoverPendingFederatedLink } from "../../lib/guest-auth.js";

type BannerModel = {
  tone: "ok" | "warn" | "err";
  text: string;
};

/**
 * A name worth saying out loud: an email or a human name. A pairwise subject
 * is an opaque token — "Signed in as FpbWr3dA8kM_…" reads as a bug, so an
 * identifier that doesn't look human stays out of the banner.
 */
function humanWho(who: string | undefined): string | null {
  if (!who) return null;
  const looksHuman = who.includes("@") || /\s/.test(who);
  return looksHuman || who.length <= 24 ? who : null;
}

function describeOutcome(outcome: AuthOutcome): BannerModel {
  switch (outcome.kind) {
    case "linked": {
      const who = humanWho(outcome.who);
      return {
        tone: "ok",
        text: who
          ? `Signed in as ${who}.`
          : "Signed in. Your account is attached to this device.",
      };
    }
    case "link_failed":
      return {
        tone: "warn",
        text:
          outcome.detail ??
          "Signed in on this device, but the account could not be attached yet.",
      };
    case "error":
      return {
        tone: "err",
        text: outcome.detail ?? "Sign-in failed. Nothing was changed.",
      };
  }
}

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
      className={`note note--${model.tone} unlock__outcome`}
      aria-live="polite"
    >
      <span>{model.text}</span>
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
