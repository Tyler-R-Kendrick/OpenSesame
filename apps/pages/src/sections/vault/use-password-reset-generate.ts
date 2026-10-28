import { passwordResetVaultUiSeams } from "@opensesame/app-core/lib/password-reset/vault-ui-seam.js";
import {
  accountWebLoginOrigin,
  enqueueManualRotation,
} from "@opensesame/app-core/lib/vault/rotation-queue.js";
import { processRotationQueue } from "@opensesame/app-core/lib/vault/rotation-relay.js";
import { type VaultItem, itemRotationMode, itemTypeId } from "@opensesame/vault-core";
import { useNavigate } from "react-router";
import { useComposition } from "../../bindings/capabilities.js";
import { promptConfigurePasswordReset } from "./rotation-password-reset-prompt.js";

export type PasswordResetGenerateResult =
  | "queued"
  | "prompted"
  | "ineligible"
  | "no-scope";

/** Same eligibility as the rotation panel: automatic rotation with an https site. */
export function isPasswordResetEligible(item: VaultItem): boolean {
  return (
    itemRotationMode(itemTypeId(item)) === "automatic" &&
    accountWebLoginOrigin(item) !== null
  );
}

/**
 * The one "generate a new password" handoff shared by the rotation panel and
 * the password control. Not configured (capability off or readiness not ok)
 * prompts through the bell tray; configured queues a manual rotation and
 * offers it to the relay. Never touches a secret.
 */
export function usePasswordResetGenerate(item: VaultItem, scope: string) {
  const navigate = useNavigate();
  const { plan } = useComposition();
  const eligible = isPasswordResetEligible(item);

  const generate = async (): Promise<PasswordResetGenerateResult> => {
    if (!eligible) return "ineligible";
    const approved = plan?.approvedCapabilities;
    if (approved?.includes("ai.password-reset") !== true) {
      promptConfigurePasswordReset(
        { ok: false, reason: "feature-off" },
        navigate,
      );
      return "prompted";
    }
    const readiness =
      await passwordResetVaultUiSeams.evaluateReadiness(approved);
    if (!readiness.ok) {
      promptConfigurePasswordReset(readiness, navigate);
      return "prompted";
    }
    if (!scope) return "no-scope";
    if (!enqueueManualRotation(item, scope)) return "ineligible";
    await processRotationQueue(scope);
    return "queued";
  };

  return { eligible, generate };
}
