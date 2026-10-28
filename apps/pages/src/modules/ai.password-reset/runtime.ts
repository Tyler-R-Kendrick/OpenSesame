/**
 * `ai.password-reset` — the vault's reset mailboxes, and the check of the ones
 * a login names for a password-reset message, handed on to the existing
 * website password-reset ceremony. The panel and the scan load only after this
 * capability is approved. Login items read the mailbox items from the vault
 * and stay hidden until then.
 *
 * Egress: the one JMAP server a person named on a mailbox, through
 * `ctx.egress.fetch` under `PASSWORD_RESET_MAIL_PURPOSE`. The Host is asked
 * only for a rotation of an origin, never given a link or a message.
 * Side effects: none at import; the check starts as a background job under the
 * lease and stops with it.
 */

import { browserInference } from "@opensesame/app-core/lib/browser-inference.js";
import { PASSWORD_RESET_MAIL_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-optional-services.js";
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  loadModelProvider,
  resolveModelPlane,
} from "@opensesame/app-core/lib/model-provider.js";
import { evaluatePasswordResetReadiness } from "@opensesame/app-core/lib/password-reset/readiness.js";
import { createActivation } from "../activation.js";
import { PasswordResetMailPanel } from "./panel.js";
import {
  createHostResetRunNoticeBridge,
  installPasswordResetRotationRelay,
} from "./rotation-relay.js";
import { createPasswordResetScan } from "./scan.js";
import { installPasswordResetVaultUiSeams } from "./vault-ui.js";

export const CAPABILITY = "ai.password-reset";

/** Matches `sectionCategory("feature-password-reset")`. */
export const PASSWORD_RESET_PANEL_CATEGORY = "features.feature-password-reset";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    activation.register("settings-panel", {
      id: "password-reset-mail",
      label: "Password reset",
      category: PASSWORD_RESET_PANEL_CATEGORY,
      Panel: PasswordResetMailPanel,
      order: 10,
    });
    const scan = createPasswordResetScan({
      fetch: (url, init) =>
        ctx.egress.fetch(url, init, {
          capability: CAPABILITY,
          purpose: PASSWORD_RESET_MAIL_PURPOSE,
        }),
    });
    activation.register("background-job", {
      id: "password-reset-mail",
      start: scan.start,
    });
    activation.register("background-job", {
      id: "password-reset-run-notices",
      start: createHostResetRunNoticeBridge().start,
    });
    activation.onDispose(installPasswordResetVaultUiSeams());
    activation.onDispose(
      installPasswordResetRotationRelay({
        readiness: async () => {
          const verdict = await browserInference();
          const plane = resolveModelPlane(loadModelProvider(), verdict);
          return evaluatePasswordResetReadiness(["ai.password-reset"], plane);
        },
      }),
    );
    return activation.handle();
  },
};
