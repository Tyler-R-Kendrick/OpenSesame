/**
 * After a matched duress trigger: open presentation via admitted compartment
 * keys (never the protected root), then leave unlock looking like a normal
 * session for open presentations, or like a wrong secret for locked ones.
 */

import type { PresentationClass } from "../../lib/duress/access/context.js";
import {
  clearActivePresentation,
  setActivePresentation,
} from "../../lib/duress/compartment/presentation-runtime.js";
import type { PublishedCompartment } from "../../lib/duress/compartment/registry.js";
import { projectScopedView } from "../../lib/duress/compartment/scope.js";
import {
  mintPresentationSession,
  openPresentation,
} from "../../lib/duress/compartment/session.js";
import type { SlotPlaintext } from "../../lib/duress/crypto/slots.js";
import { WrongPasswordError } from "../../lib/vault/crypto.js";

export type DuressContinueStore = Readonly<{
  createGuest: (options?: { resume?: boolean }) => Promise<void>;
  cancelTotpChallenge?: () => void;
}>;

export type DuressContinueMatch = Readonly<{
  profileId: string;
  plaintext: SlotPlaintext;
  /** Optional sealed presentation blob; missing → unavailable shell. */
  published?: PublishedCompartment | null;
  compartmentRef?: string;
  keyEpoch?: number;
}>;

function presentationOf(value: string): PresentationClass {
  if (
    value === "normal" ||
    value === "restricted" ||
    value === "decoy" ||
    value === "locked" ||
    value === "unchanged"
  ) {
    return value;
  }
  return "restricted";
}

/**
 * Decoy / restricted / normal: mint a presentation session from the slot key,
 * project a scoped view for PresentationShell, then open the isolated guest
 * tomb so the app shell unlocks without the protected root (INV-03 / INV-05).
 */
export async function continueAfterDuressMatch(
  store: DuressContinueStore,
  match: DuressContinueMatch,
  wrongSecretMessage: string,
): Promise<"duress_session"> {
  store.cancelTotpChallenge?.();
  const presentation = presentationOf(match.plaintext.presentation);
  if (presentation === "locked" || presentation === "unchanged") {
    clearActivePresentation();
    match.plaintext.compartmentKey.fill(0);
    match.plaintext.actionCapability?.fill(0);
    throw new WrongPasswordError(wrongSecretMessage);
  }

  const compartmentRef =
    match.compartmentRef ?? `compartment:${match.profileId}`;
  const keyEpoch = match.keyEpoch ?? 1;
  const session = await mintPresentationSession({
    presentation,
    profileId: match.profileId,
    contextId: `duress:${match.profileId}:${crypto.randomUUID()}`,
    admittedKeys: [
      {
        compartmentRef,
        keyEpoch,
        rawKey: match.plaintext.compartmentKey,
      },
    ],
  });

  const outcome = await openPresentation(session, match.published ?? null);
  const view = projectScopedView(outcome);
  setActivePresentation({
    profileId: match.profileId,
    outcome,
    view,
  });

  match.plaintext.compartmentKey.fill(0);
  match.plaintext.actionCapability?.fill(0);

  await store.createGuest();
  return "duress_session";
}
