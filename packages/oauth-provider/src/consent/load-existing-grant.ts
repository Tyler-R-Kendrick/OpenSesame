import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";

export type StoredConsent = { scopes: string[]; claims: string[] };

export type FindStoredConsent = (
  accountId: string,
  clientId: string,
) => Promise<StoredConsent | null>;

type GrantCtor = {
  find(id: string): Promise<BoundaryValue>;
  new (args: { accountId: string; clientId: string }): {
    addOIDCScope(scope: string): void;
    addOIDCClaims(claims: string[]): void;
    save(): Promise<string>;
  };
};

/** Structural subset of panva's KoaContextWithOIDC used by grant reuse. */
type GrantContext = {
  oidc: {
    session?: {
      accountId?: string;
      grantIdFor?: (clientId: string) => string | undefined;
    };
    client?: { clientId?: string };
    params?: { scope?: BoundaryValue };
    prompts?: { has(name: string): boolean };
    result?: { consent?: { grantId?: string } };
    provider: { Grant: GrantCtor };
  };
};

function nonemptyString(value: BoundaryValue | undefined): string | undefined {
  return isString(value) && value ? value : undefined;
}

function sessionGrantId(oidc: GrantContext["oidc"]): string | undefined {
  const fromResult = nonemptyString(oidc.result?.consent?.grantId);
  if (fromResult) return fromResult;
  const clientId = nonemptyString(oidc.client?.clientId);
  if (!clientId) return undefined;
  return nonemptyString(oidc.session?.grantIdFor?.(clientId));
}

function requestedScopes(scope: BoundaryValue | undefined): string[] {
  if (!isString(scope)) return [];
  return scope.split(" ").filter(Boolean);
}

function coversRequested(stored: StoredConsent, requested: string[]): boolean {
  if (requested.length === 0) return false;
  return requested.every((scope) => stored.scopes.includes(scope));
}

async function materialiseGrant(
  Grant: GrantCtor,
  accountId: string,
  clientId: string,
  stored: StoredConsent,
): Promise<BoundaryValue> {
  const grant = new Grant({ accountId, clientId });
  grant.addOIDCScope(stored.scopes.join(" "));
  if (stored.claims.length > 0) grant.addOIDCClaims(stored.claims);
  await grant.save();
  return overlapCast<unknown, BoundaryValue>(grant);
}

/**
 * Durable consent reuse (the control plane's `consents` rows, written on
 * every Continue). oidc-provider's default only reuses the SESSION's grant,
 * so a new browser session re-prompted for a decision already remembered.
 *
 * The skip is deliberately narrow: the session grant still wins when one
 * exists; an explicit `prompt=consent` always prompts; and a request asking
 * for any scope outside the stored set falls through to the consent page
 * rather than silently widening what was granted.
 */
export function createLoadExistingGrant(
  findStoredConsent: FindStoredConsent,
): (ctx: BoundaryValue) => Promise<BoundaryValue | undefined> {
  return async (ctx: BoundaryValue) => {
    const { oidc } = overlapCast<BoundaryValue, GrantContext>(ctx);
    const existing = sessionGrantId(oidc);
    if (existing) return oidc.provider.Grant.find(existing);
    const accountId = nonemptyString(oidc.session?.accountId);
    const clientId = nonemptyString(oidc.client?.clientId);
    if (!accountId || !clientId) return undefined;
    if (oidc.prompts?.has("consent")) return undefined;
    const stored = await findStoredConsent(accountId, clientId);
    if (!stored) return undefined;
    const requested = requestedScopes(oidc.params?.scope);
    if (!coversRequested(stored, requested)) return undefined;
    return materialiseGrant(oidc.provider.Grant, accountId, clientId, stored);
  };
}
