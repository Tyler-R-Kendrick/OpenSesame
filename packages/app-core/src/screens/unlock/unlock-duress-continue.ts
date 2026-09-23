/**
 * After a matched duress trigger: open presentation via admitted compartment
 * keys (never the protected root), then leave unlock looking like a normal
 * session for open presentations, or like a wrong secret for locked ones.
 */

import { WrongPasswordError } from "@opensesame/vault-core";
import type { PresentationClass } from "../../lib/duress/access/context.js";
import {
  clearActivePresentation,
  setActivePresentation,
} from "../../lib/duress/compartment/presentation-runtime.js";
import { projectScopedView } from "../../lib/duress/compartment/scope.js";
import {
  mintPresentationSession,
  openPresentation,
} from "../../lib/duress/compartment/session.js";
import type { SlotPlaintext } from "../../lib/duress/crypto/slots.js";

export type DuressContinueStore = Readonly<{
  createGuest: (options?: { resume?: boolean }) => Promise<void>;
  cancelTotpChallenge?: () => void;
}>;

export type DuressContinueMatch = Readonly<{
  profileId: string;
  plaintext: SlotPlaintext;
}>;

/** Map slot presentation strings onto the closed PresentationClass set. */
export function resolveDuressPresentation(value: string): PresentationClass {
  switch (value) {
    case "normal":
    case "restricted":
    case "decoy":
    case "locked":
    case "unchanged":
      return value;
    default:
      return "restricted";
  }
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
  const presentation = resolveDuressPresentation(match.plaintext.presentation);
  if (presentation === "locked" || presentation === "unchanged") {
    clearActivePresentation();
    match.plaintext.compartmentKey.fill(0);
    match.plaintext.actionCapability?.fill(0);
    throw new WrongPasswordError(wrongSecretMessage);
  }

  const session = await mintPresentationSession({
    presentation,
    profileId: match.profileId,
    contextId: `duress:${match.profileId}:${crypto.randomUUID()}`,
    admittedKeys: [
      {
        compartmentRef: `compartment:${match.profileId}`,
        keyEpoch: 1,
        rawKey: match.plaintext.compartmentKey,
      },
    ],
  });

  const outcome = await openPresentation(session, null);
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
