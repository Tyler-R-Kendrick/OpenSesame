/**
 * After a matched duress trigger: open presentation via admitted compartment
 * keys (never the protected root), then leave unlock looking like a normal
 * session for open presentations, or like a wrong secret for locked ones.
 */

import { type AccountItem, WrongPasswordError } from "@opensesame/vault-core";
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
import {
  decodePlan,
  runDuressEffects,
} from "../../lib/duress/settings/modes/index.js";

/** Where the unlock path runs a plan's effects; a test records the calls here. */
export const duressContinueSeams = {
  runEffects: runDuressEffects,
};

export type DuressContinueStore = Readonly<{
  /** `decoy: true` — a sealed guest tomb is never wiped (VaultStore.createGuest). */
  createGuest: (options?: {
    resume?: boolean;
    decoy?: boolean;
  }) => Promise<void>;
  cancelTotpChallenge?: () => void;
  /** The open session's items; a plan's runner adds to it (`modes/effects.ts`). */
  addItems?: (items: AccountItem[]) => Promise<void>;
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
 * project a scoped view for PresentationShell, then open a fresh guest-road
 * session so the app shell unlocks without the protected root (INV-03 /
 * INV-05). The session is a decoy: it never wipes a guest tomb that holds a
 * sealed vault of its own, and the store draws it as the vault the unlock
 * screen was showing (`VaultState.decoy`). The minted outcome is locked (no
 * published decoy), so the overlay draws nothing for it: a decoy that says
 * "unavailable" is not read as an ordinary unlock.
 */
export async function continueAfterDuressMatch(
  store: DuressContinueStore,
  match: DuressContinueMatch,
  wrongSecretMessage: string,
): Promise<"duress_session"> {
  store.cancelTotpChallenge?.();
  const presentation = resolveDuressPresentation(match.plaintext.presentation);
  // The mode's plan is read before the slot's bytes are cleared, and its
  // first phase runs before anything is shown — or refused — so a locked
  // presentation still does what its mode says.
  const plan = decodePlan(match.plaintext.payload);
  await duressContinueSeams.runEffects(plan, "on_match", { store });
  if (presentation === "locked" || presentation === "unchanged") {
    clearActivePresentation();
    match.plaintext.compartmentKey.fill(0);
    match.plaintext.actionCapability?.fill(0);
    throw new WrongPasswordError(wrongSecretMessage);
  }

  try {
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
  } finally {
    match.plaintext.compartmentKey.fill(0);
    match.plaintext.actionCapability?.fill(0);
  }

  await store.createGuest({ decoy: true });
  await duressContinueSeams.runEffects(plan, "after_session", { store });
  return "duress_session";
}
