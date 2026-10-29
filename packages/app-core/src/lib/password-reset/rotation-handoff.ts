/**
 * Starts the website password-reset ceremony for a queued rotation. The relay
 * sees only scope, item id and origin — never a password or candidate.
 */

import type { VaultItem } from "@opensesame/vault-core";
import { accountWebLoginOrigin } from "../vault/rotation-queue.js";
import type { RotationEvent } from "../vault/rotation-queue.js";
import type { RotationRelayResult } from "../vault/rotation-relay.js";
import { resetRotationActive } from "./rotation-handoff-active.js";
import {
  setVaultResetRunPhase,
  vaultResetRunFor,
} from "./vault-run-tracker.js";

export type PasswordResetHandOffResult =
  | boolean
  | { accepted: boolean; jobId?: string | null };

export type PasswordResetHandOff = (
  origin: string,
) => Promise<PasswordResetHandOffResult>;

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
  if (resetRotationActive(existing)) {
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
    const result = await handOff(origin);
    const accepted = typeof result === "boolean" ? result : result.accepted;
    const jobId = typeof result === "boolean" ? null : (result.jobId ?? null);
    if (accepted) {
      // Accepted is not done: the ceremony runs on the Host from here. The
      // queue event is consumed, but the run stays in-progress (with its
      // job id) until the notice bridge observes the terminal job status.
      setVaultResetRunPhase(
        event.scope,
        event.itemId,
        "in-progress",
        null,
        now,
        jobId,
      );
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
