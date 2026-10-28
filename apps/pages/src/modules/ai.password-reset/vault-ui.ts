import { browserInference } from "@opensesame/app-core/lib/browser-inference.js";
import {
  loadModelProvider,
  resolveModelPlane,
} from "@opensesame/app-core/lib/model-provider.js";
import { evaluatePasswordResetReadiness } from "@opensesame/app-core/lib/password-reset/readiness.js";
import {
  subscribeVaultResetRuns,
  vaultResetRunFor,
} from "@opensesame/app-core/lib/password-reset/vault-run-tracker.js";
import {
  type PasswordResetVaultUiSeams,
  installPasswordResetVaultUi,
} from "@opensesame/app-core/lib/password-reset/vault-ui-seam.js";

const implementation: PasswordResetVaultUiSeams = {
  subscribeRuns: subscribeVaultResetRuns,
  runPhaseFor: (scope, itemId) =>
    vaultResetRunFor(scope, itemId)?.phase ?? null,
  evaluateReadiness: async (approved) => {
    const verdict = await browserInference();
    const plane = resolveModelPlane(loadModelProvider(), verdict);
    const readiness = await evaluatePasswordResetReadiness(approved, plane);
    if (readiness.ok) return { ok: true };
    return { ok: false, reason: readiness.reason };
  },
};

export function installPasswordResetVaultUiSeams(): () => void {
  return installPasswordResetVaultUi(implementation);
}
