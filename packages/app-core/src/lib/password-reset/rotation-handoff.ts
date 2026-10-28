/**
 * Starts the website password-reset ceremony for a queued rotation. The relay
 * sees only scope, item id and origin — never a password or candidate.
 */

import type { VaultItem } from "@opensesame/vault-core";
import { accountWebLoginOrigin } from "../vault/rotation-queue.js";
import type { RotationEvent } from "../vault/rotation-queue.js";
import type { RotationRelayResult } from "../vault/rotation-relay.js";
import {
  setVaultResetRunPhase,
  vaultResetRunFor,
} from "./vault-run-tracker.js";

export type PasswordResetHandOff = (origin: string) => Promise<boolean>;

export type PasswordResetHandOffSeams = {
  handOff: PasswordResetHandOff | null;
};

export const passwordResetHandOffSeams: PasswordResetHandOffSeams = {
  handOff: null,
};

export async function dispatchPasswordResetRotation(
  event: RotationEvent,
  item: VaultItem | null,
  now = new Date(),
): Promise<RotationRelayResult> {
  const existing = vaultResetRunFor(event.scope, event.itemId);
  if (existing?.phase === "in-progress") {
    return { ok: false, detail: "A password reset is already running." };
  }
  setVaultResetRunPhase(event.scope, event.itemId, "queued", null, now);
  const origin = item?.kind === "account" ? accountWebLoginOrigin(item) : null;
  if (!origin) {
    setVaultResetRunPhase(
      event.scope,
      event.itemId,
      "failed",
      "No https site is configured for this item.",
      now,
    );
    return { ok: false, detail: "No https site is configured for this item." };
  }
  const handOff = passwordResetHandOffSeams.handOff;
  if (!handOff) {
    setVaultResetRunPhase(
      event.scope,
      event.itemId,
      "needs-you",
      "Password reset is not wired on this device.",
      now,
    );
    return {
      ok: false,
      detail: "Password reset is not wired on this device.",
    };
  }
  setVaultResetRunPhase(event.scope, event.itemId, "in-progress", null, now);
  try {
    const accepted = await handOff(origin);
    if (accepted) {
      setVaultResetRunPhase(event.scope, event.itemId, "done", null, now);
      return { ok: true };
    }
    setVaultResetRunPhase(
      event.scope,
      event.itemId,
      "needs-you",
      "The reset needs you on the provider site.",
      now,
    );
    return { ok: false, detail: "The reset needs you on the provider site." };
  } catch {
    setVaultResetRunPhase(
      event.scope,
      event.itemId,
      "failed",
      "The password reset could not be started.",
      now,
    );
    return { ok: false, detail: "The password reset could not be started." };
  }
}
