import {
  type AuthorityGrant,
  assertAuthorityGrantActive,
} from "@opensesame/os-domain";
import {
  assertResetBinding,
  assertResetConstraints,
  assertResetResource,
} from "./grant-validation.js";
import { RESET_ACTIONS, type ResetAction, type ResetRun } from "./types.js";

export { RESET_ACTIONS };
export {
  domainMetadataResource,
  resetAudience,
  resetResource,
} from "./grant-validation.js";

export interface ResetGrantProvider {
  grant(action: ResetAction, run: ResetRun): AuthorityGrant;
}

export function fixedGrants(
  grants: Partial<Record<ResetAction, AuthorityGrant>>,
): ResetGrantProvider {
  return {
    grant(action) {
      const grant = grants[action];
      if (!grant)
        throw new Error(`Missing separately approved grant: ${action}`);
      return grant;
    },
  };
}

export function assertResetGrant(
  grant: AuthorityGrant,
  run: Pick<ResetRun, "id" | "domain" | "itemId" | "grantIds">,
  action: ResetAction,
  now = new Date(),
): void {
  if (!RESET_ACTIONS.includes(action))
    throw new Error("Unknown reset capability");
  assertAuthorityGrantActive(grant, now);
  assertResetConstraints(grant);
  assertResetBinding(grant, run, action);
  assertResetResource(grant, run, action);
}

export function actionForPrimitive(
  primitive: ResetRun["recipe"]["steps"][number]["primitive"],
): ResetAction {
  if (primitive === "await-email-link") return "password_reset.mailbox.read";
  if (
    [
      "enter-email-code",
      "enter-TOTP",
      "passkey-prompt",
      "await-human",
    ].includes(primitive)
  )
    return "password_reset.human.takeover";
  return "password_reset.browser.drive";
}
