/**
 * Pre-unlock surface for the last sign-in's outcome.
 *
 * The notifications bell only exists inside the unlocked shell, so a sign-in
 * that came back to a locked (or empty) vault used to vanish without a word —
 * the literal "the Google button just fails" bug. This banner renders the
 * stored outcome right on the unlock screen instead.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  type AuthOutcome,
  clearAuthOutcome,
  readAuthOutcome,
} from "../../lib/auth-outcome.js";
import { recoverPendingFederatedLink } from "../../lib/guest-auth.js";
import { listNotices, subscribeNotices } from "../../lib/notices.js";

let renderEpoch = 0;
const epochListeners = new Set<() => void>();

function bumpEpoch(): void {
  renderEpoch += 1;
  for (const listener of epochListeners) listener();
}

function subscribeEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  const unsubscribeNotices = subscribeNotices(listener);
  return () => {
    epochListeners.delete(listener);
    unsubscribeNotices();
  };
}

type BannerModel = {
  tone: "ok" | "warn" | "err";
  text: string;
};

function describeOutcome(outcome: AuthOutcome): BannerModel {
  switch (outcome.kind) {
    case "linked":
      return {
        tone: "ok",
        text: outcome.who
          ? `Signed in as ${outcome.who}.`
          : "Signed in. Your account is attached to this device.",
      };
    case "pending_link":
      return {
        tone: "ok",
        text: "Sign-in verified — unlock to attach it to this vault.",
      };
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
  // sessionStorage — re-raise the pending-link prompt. Idempotent, and the
  // notice subscription below re-renders this banner when it lands.
  useEffect(() => {
    recoverPendingFederatedLink();
  }, []);

  useSyncExternalStore(
    subscribeEpoch,
    () => `${renderEpoch}:${listNotices().length}`,
    () => "server",
  );

  const outcome = readAuthOutcome();
  const pendingNotice = listNotices().some(
    (notice) => notice.kind === "federated_link",
  );

  const dismiss = useCallback(() => {
    clearAuthOutcome();
    bumpEpoch();
  }, []);

  const model: BannerModel | null = outcome
    ? describeOutcome(outcome)
    : pendingNotice
      ? {
          tone: "ok",
          text: "Sign-in verified — unlock to attach it to this vault.",
        }
      : null;

  if (!model) return null;

  return (
    <output
      className={`note note--${model.tone} unlock__outcome`}
      aria-live="polite"
    >
      <span>{model.text}</span>
      {outcome ? (
        <button
          type="button"
          className="icon-btn unlock__outcome-dismiss"
          aria-label="Dismiss"
          onClick={dismiss}
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
      ) : null}
    </output>
  );
}
