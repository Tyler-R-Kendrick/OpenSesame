import type { AccountLookup } from "@opensesame/oauth-provider";
import type { ControlPlaneRepositories } from "./context.js";
import type { AppStores } from "./state.js";

/** Late-bound so the provider can be constructed before stores exist. */
export type AccountLookupSlot = {
  repos?: ControlPlaneRepositories;
  stores?: AppStores;
};

/**
 * Hosted findAccount lookup. Missing/suspended principals yield no account.
 * Claim mapping is the per-client record, never inferred from the principal.
 */
export async function lookupHostedAccount(
  slot: AccountLookupSlot,
  id: string,
  clientId?: string,
): Promise<AccountLookup | null> {
  const repos = slot.repos;
  if (!repos) return null;
  const principal = await repos.principals.getById(id);
  if (!principal) return null;
  if (principal.state === "suspended" || principal.state === "closed") {
    return { principal: { status: "suspended" } };
  }
  const identities = await repos.externalIdentities.listByPrincipal(id);
  const verified = identities.find(
    (row) => row.emailVerified === true && Boolean(row.emailNormalized),
  );
  const named = identities.find((row) => Boolean(row.displayHint));
  const mapping = clientId
    ? await slot.stores?.claimMappings.get(clientId)
    : undefined;
  return {
    principal: {
      status: "active",
      ...(named?.displayHint ? { name: named.displayHint } : undefined),
      ...(verified?.emailNormalized
        ? {
            email: verified.emailNormalized,
            emailVerified: true,
            emailAuthoritative: true,
          }
        : undefined),
    },
    ...(mapping ? { mapping } : undefined),
  };
}
