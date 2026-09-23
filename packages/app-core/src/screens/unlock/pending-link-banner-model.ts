/**
 * View-model logic for `PendingLinkBanner` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type { AuthOutcome } from "../../lib/auth-outcome.js";

export type BannerModel = {
  tone: "ok" | "warn" | "err" | "plain";
  text: string;
};

/**
 * A name worth saying out loud: an email or a human name. A pairwise subject
 * is an opaque token — "Signed in as FpbWr3dA8kM_…" reads as a bug, so an
 * identifier that doesn't look human stays out of the banner.
 */
export function humanWho(who: string | undefined): string | null {
  if (!who) return null;
  const looksHuman = who.includes("@") || /\s/.test(who);
  return looksHuman || who.length <= 24 ? who : null;
}

export function describeOutcome(outcome: AuthOutcome): BannerModel {
  switch (outcome.kind) {
    case "authenticated": {
      const who = humanWho(outcome.who);
      return {
        tone: "ok",
        text: who
          ? `Signed in with your organization as ${who}. Unlock your vault to continue.`
          : "Signed in with your organization. Unlock your vault to continue.",
      };
    }
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
    case "signed_out":
      return {
        tone: "plain",
        text: outcome.switching
          ? "Signed out. Choose the account to sign in with."
          : "Signed out of this device.",
      };
    case "attach":
      return {
        tone: "plain",
        text: "Choose an account to attach to the one this device already has.",
      };
  }
}
