import { hostFetch } from "@opensesame/app-core/lib/identity.js";
import type { PasswordResetReadiness } from "@opensesame/app-core/lib/password-reset/readiness.js";
import { dispatchPasswordResetRotation } from "@opensesame/app-core/lib/password-reset/rotation-handoff.js";
import { passwordResetHandOffSeams } from "@opensesame/app-core/lib/password-reset/rotation-handoff.js";
import {
  type RotationEvent,
  type RotationRelayResult,
  rotationSeams,
} from "@opensesame/app-core/lib/vault/rotation-relay.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
async function postRotation(origin: string): Promise<boolean> {
  try {
    const response = await hostFetch("/api/v1/rotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        web_login_origin: origin,
        execute_now: true,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type RotationRelayDeps = {
  readiness: () => Promise<PasswordResetReadiness>;
};

export function installPasswordResetRotationRelay(
  deps: RotationRelayDeps,
): () => void {
  const previousRelay = rotationSeams.relay;
  const previousHandOff = passwordResetHandOffSeams.handOff;
  passwordResetHandOffSeams.handOff = postRotation;
  rotationSeams.relay = async (
    event: RotationEvent,
  ): Promise<RotationRelayResult> => {
    const ready = await deps.readiness();
    if (!ready.ok) {
      return { ok: false, detail: "Password reset is not configured." };
    }
    const item =
      vaultStore
        .getSnapshot()
        .items.find((entry) => entry.id === event.itemId) ?? null;
    return dispatchPasswordResetRotation(event, item);
  };
  return () => {
    rotationSeams.relay = previousRelay;
    passwordResetHandOffSeams.handOff = previousHandOff;
  };
}
