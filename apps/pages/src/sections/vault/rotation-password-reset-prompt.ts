import { pushNotice } from "@opensesame/app-core/lib/notices.js";
import type { PasswordResetReadinessSnapshot } from "@opensesame/app-core/lib/password-reset/vault-ui-seam.js";

export function promptConfigurePasswordReset(
  readiness: PasswordResetReadinessSnapshot,
  navigate: (path: string) => void,
): void {
  const reason = readiness.ok === false ? readiness.reason : "feature-off";
  const body =
    reason === "feature-off"
      ? "Turn on Password reset under Settings › Features, then connect a computer-use runtime under Integrations and choose a model under AI."
      : reason === "runtime"
        ? "Connect a computer-use runtime under Settings › Integrations › Password reset."
        : "Choose a model for password reset under Settings › Features › AI.";
  pushNotice({
    kind: "status",
    tone: "info",
    title: "Password reset",
    body,
    act: {
      label: "Settings",
      run: () => {
        if (reason === "runtime") {
          navigate("/settings/integrations#integration-password-reset");
          return;
        }
        if (reason === "model") {
          navigate("/settings/features#feature-ai");
          return;
        }
        navigate("/settings/features#feature-password-reset");
      },
    },
  });
}
