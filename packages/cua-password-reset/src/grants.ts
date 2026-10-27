import {
  type AuthorityGrant,
  assertAuthorityGrantActive,
  authorityGrantPermitsResource,
} from "@opensesame/os-domain";
import { RESET_ACTIONS, type ResetAction, type ResetRun } from "./types.js";

export { RESET_ACTIONS };

export function resetAudience(runId: string): string {
  return `opensesame:password-reset:${runId}`;
}

export function resetResource(domain: string, itemId: string): string {
  return `password-reset:domain:${domain}:item:${itemId}`;
}

export function domainMetadataResource(domain: string): string {
  return `password-reset:domain:${domain}:metadata`;
}

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
  if (grant.constraints.rawCredentialExport)
    throw new Error("A reset grant cannot export raw credentials");
  if (grant.constraints.offlineUse !== "forbidden")
    throw new Error("A reset grant cannot be used offline");
  if (grant.actions.length !== 1 || grant.actions[0] !== action)
    throw new Error("Reset action requires its own exact grant");
  if (run.grantIds[action] !== grant.id)
    throw new Error("Reset grant is not the grant approved for this run");
  if (grant.constraints.audiences.length !== 1 ||
      grant.constraints.audiences[0] !== resetAudience(run.id))
    throw new Error("Reset grant belongs to another run or audience");
  if (!grant.actorInstanceId || !grant.proofKeyThumbprint)
    throw new Error("Reset grant must name one agent instance and proof key");
  if (grant.delegationDepth !== 0 || grant.constraints.maximumDelegationDepth !== 0)
    throw new Error("Reset grant cannot be redelegated");
  const resource =
    action === "password_reset.domain_metadata.list"
      ? domainMetadataResource(run.domain)
      : resetResource(run.domain, run.itemId);
  if (grant.resources.length !== 1 || grant.resources[0] !== resource)
    throw new Error("Reset grant must name one exact resource");
  if (!authorityGrantPermitsResource(grant, resource))
    throw new Error("Reset domain or vault item is outside the grant");
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
