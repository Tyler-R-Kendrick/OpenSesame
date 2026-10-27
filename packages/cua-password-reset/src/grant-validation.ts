import {
  type AuthorityGrant,
  authorityGrantPermitsResource,
} from "@opensesame/os-domain";
import type { ResetAction, ResetRun } from "./types.js";

export function resetAudience(runId: string): string {
  return `opensesame:password-reset:${runId}`;
}

export function resetResource(domain: string, itemId: string): string {
  return `password-reset:domain:${domain}:item:${itemId}`;
}

export function domainMetadataResource(domain: string): string {
  return `password-reset:domain:${domain}:metadata`;
}

type GrantRun = Pick<ResetRun, "id" | "domain" | "itemId" | "grantIds">;

export function assertResetConstraints(grant: AuthorityGrant): void {
  if (grant.constraints.rawCredentialExport)
    throw new Error("A reset grant cannot export raw credentials");
  if (grant.constraints.offlineUse !== "forbidden")
    throw new Error("A reset grant cannot be used offline");
}

export function assertResetBinding(
  grant: AuthorityGrant,
  run: GrantRun,
  action: ResetAction,
): void {
  if (grant.actions.length !== 1 || grant.actions[0] !== action)
    throw new Error("Reset action requires its own exact grant");
  if (run.grantIds[action] !== grant.id)
    throw new Error("Reset grant is not the grant approved for this run");
  if (
    grant.constraints.audiences.length !== 1 ||
    grant.constraints.audiences[0] !== resetAudience(run.id)
  )
    throw new Error("Reset grant belongs to another run or audience");
  if (!grant.actorInstanceId || !grant.proofKeyThumbprint)
    throw new Error("Reset grant must name one agent instance and proof key");
  if (
    grant.delegationDepth !== 0 ||
    grant.constraints.maximumDelegationDepth !== 0
  )
    throw new Error("Reset grant cannot be redelegated");
}

export function assertResetResource(
  grant: AuthorityGrant,
  run: GrantRun,
  action: ResetAction,
): void {
  const resource =
    action === "password_reset.domain_metadata.list"
      ? domainMetadataResource(run.domain)
      : resetResource(run.domain, run.itemId);
  if (grant.resources.length !== 1 || grant.resources[0] !== resource)
    throw new Error("Reset grant must name one exact resource");
  if (!authorityGrantPermitsResource(grant, resource))
    throw new Error("Reset domain or vault item is outside the grant");
}
