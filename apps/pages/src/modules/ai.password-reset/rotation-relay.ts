import { hostFetch } from "@opensesame/app-core/lib/identity.js";
import type { PasswordResetReadiness } from "@opensesame/app-core/lib/password-reset/readiness.js";
import { dispatchPasswordResetRotation } from "@opensesame/app-core/lib/password-reset/rotation-handoff.js";
import { passwordResetHandOffSeams } from "@opensesame/app-core/lib/password-reset/rotation-handoff.js";
import { startResetRunNoticeBridge } from "@opensesame/app-core/lib/password-reset/run-notice-bridge.js";
import {
  type RotationEvent,
  type RotationRelayResult,
  rotationSeams,
} from "@opensesame/app-core/lib/vault/rotation-relay.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  hostAgentRunListSchema,
  hostAgentRunSchema,
  hostRotationJobSchema,
  hostRotationReceiptSchema,
} from "./host-run-schemas.js";
async function postRotation(origin: string) {
  try {
    const response = await hostFetch("/api/v1/rotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        web_login_origin: origin,
        execute_now: true,
      }),
    });
    if (!response.ok) return { accepted: false, jobId: null };
    const body = hostRotationReceiptSchema.safeParse(
      await response.json().catch(() => null),
    );
    const jobId = body.success ? body.data.id : null;
    return { accepted: true, jobId };
  } catch {
    return { accepted: false, jobId: null };
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

/** Background job: mirror Host run state into the notice tray + toasts. */
export function createHostResetRunNoticeBridge() {
  return {
    start(signal: AbortSignal): void {
      const stop = startResetRunNoticeBridge({
        listAgentRuns: async () => {
          const response = await hostFetch("/api/v1/agent/runs");
          if (!response.ok) throw new Error("agent runs unavailable");
          const body = hostAgentRunListSchema.safeParse(await response.json());
          return body.success
            ? body.data.runs.flatMap((entry) => {
                const parsed = hostAgentRunSchema.safeParse(entry);
                return parsed.success ? [parsed.data] : [];
              })
            : [];
        },
        getRotationJob: async (jobId: string) => {
          const response = await hostFetch(
            `/api/v1/rotations/${encodeURIComponent(jobId)}`,
          );
          if (!response.ok) return null;
          const body = hostRotationJobSchema.safeParse(
            await response.json().catch(() => null),
          );
          return body.success && body.data.id === jobId ? body.data : null;
        },
      });
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener("abort", stop, { once: true });
    },
  };
}
