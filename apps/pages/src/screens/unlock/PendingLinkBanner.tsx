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
 *
 * Only the quiet outcomes are drawn (signed in, signed out, attach). A failed
 * or half-finished sign-in goes to the tray, where it waits for the bell.
 *
 * It is also where the fresh document a reset left for says what the reset
 * left behind (`ResetLeftNotice`), ahead of the outcome.
 */

import {
  clearAuthOutcome,
  readAuthOutcome,
} from "@opensesame/app-core/lib/auth-outcome.js";
import { recoverPendingFederatedLink } from "@opensesame/app-core/lib/guest-auth.js";
import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { signOut } from "@opensesame/app-core/lib/session-exit.js";
import { describeOutcome } from "@opensesame/app-core/screens/unlock/pending-link-banner-model.js";
import { useEffect, useReducer } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconSignOut } from "../../components/Icons.js";
import { ResetLeftNotice } from "./ResetLeftNotice.js";

export function PendingLinkBanner() {
  // A reload drops in-memory notices while the assertion lives on in
  // sessionStorage — re-raise the pending-link prompt for the bell.
  // Idempotent, and a no-op unless a link is actually outstanding.
  useEffect(() => {
    recoverPendingFederatedLink();
  }, []);

  const [, bump] = useReducer((epoch: number) => epoch + 1, 0);

  const outcome = readAuthOutcome();
  const model = outcome ? describeOutcome(outcome) : null;
  // A failed sign-in is never drawn here: it goes to the tray (it is waiting in
  // the bell after unlock) and the stored record is spent so it is raised once.
  const failedTone =
    model?.tone === "err" || model?.tone === "warn" ? model.tone : null;
  const failedText = failedTone ? model?.text : undefined;
  const failedTitle =
    outcome?.kind === "link_failed" ? "Account link" : "Sign-in";
  useEffect(() => {
    if (!failedTone || !failedText) return;
    setStatusNotice({
      id: "unlock:outcome",
      tone: failedTone,
      title: failedTitle,
      body: failedText,
    });
    clearAuthOutcome();
    bump();
  }, [failedTone, failedText, failedTitle]);

  // What the last reset left behind comes before anything else on the
  // screen the fresh document opens on (`ResetLeftNotice`).
  if (!outcome || !model || failedTone) return <ResetLeftNotice />;

  return (
    <>
      <ResetLeftNotice />
      <output
        className={
          model.tone === "ok"
            ? "note note--ok unlock__outcome"
            : "note unlock__outcome"
        }
        aria-live="polite"
      >
        <span>{model.text}</span>
        {outcome.kind === "authenticated" ? (
          <IconKey
            label="Sign out"
            small
            onClick={() => {
              signOut();
              bump();
            }}
          >
            <IconSignOut size={16} />
          </IconKey>
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
    </>
  );
}
