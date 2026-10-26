/** Public sign-in projection, including explicit migration of the old provider settings form. */
import { originClientId } from "./federation.js";
import { identityConnectionDraft } from "./identity-connections-presets.js";
import {
  type IdentityConnectionDraft,
  identityConnectionUsesBroker,
} from "./identity-connections-schema.js";
import {
  identitySessionAudience,
  identitySessionIssuer,
  identitySessionJwksUri,
} from "./identity-connections-session.js";
import { readIdentityConnection } from "./identity-connections-store.js";
import { isNativeOidcConfiguration } from "./identity-oidc-config.js";
import { readOperatorIdp } from "./operator-idp-config.js";
import {
  type OperatorIdp,
  loadSettings,
  saveSettingsDurable,
  signInMethods,
} from "./settings.js";

function legacyProviders(providerId: string): OperatorIdp[] {
  return signInMethods().providers.filter(
    (idp) =>
      idp.providerId === providerId &&
      !idp.connectionId &&
      !idp.providerHint &&
      (!idp.protocol || idp.protocol === "oidc"),
  );
}

/** Legacy public OIDC configuration remains editable; reading does not migrate or mint trust. */
export function readInitialIdentityDraft(
  providerId: string,
  existingId?: string,
): IdentityConnectionDraft {
  const saved = existingId ? readIdentityConnection(existingId) : null;
  if (saved?.providerId === providerId) return saved;
  const draft = identityConnectionDraft(providerId);
  if (draft.protocol !== "oidc") return draft;
  const candidates = legacyProviders(providerId);
  const legacy = candidates.length === 1 ? candidates[0] : null;
  if (!legacy) return draft;
  return {
    ...draft,
    name: legacy.label,
    issuer: legacy.issuer,
    clientId: legacy.clientId,
    scope: legacy.scope ?? draft.scope,
  };
}

/** Only this provider's unique old direct OIDC entry may be replaced by its configured connection. */
export function captureLegacyIdentityMigration(
  draft: IdentityConnectionDraft,
  existingId?: string,
): OperatorIdp | null {
  if (
    existingId ||
    draft.protocol !== "oidc" ||
    identityConnectionUsesBroker(draft)
  )
    return null;
  const candidates = legacyProviders(draft.providerId);
  if (candidates.length > 1)
    throw new Error(
      "Multiple legacy identity methods exist; select one in sign-in settings first",
    );
  return candidates[0] ?? null;
}

function providerProjection(
  draft: IdentityConnectionDraft,
  connectionId: string,
): OperatorIdp {
  if (draft.protocol === "saml")
    return {
      providerId: draft.providerId,
      label: draft.name,
      connectionId,
      protocol: "saml",
      issuer: draft.samlEntityId,
      clientId: draft.clientId,
    };
  if (isNativeOidcConfiguration(draft))
    return {
      providerId: draft.providerId,
      issuer: draft.issuer,
      clientId: draft.clientId,
      label: draft.name,
      connectionId,
      protocol: "oidc",
      nativeIdentity: true,
      scope: draft.scope,
    };
  if (identityConnectionUsesBroker(draft))
    return {
      providerId: draft.providerId,
      label: draft.name,
      connectionId,
      protocol: "oidc",
      issuer: draft.brokerUrl,
      clientId: originClientId(),
      scope: "openid",
      providerHint: `org:${draft.organizationSlug}`,
    };
  const native =
    draft.protocol === "better-auth" || draft.protocol === "supabase";
  const projection: OperatorIdp = {
    providerId: draft.providerId,
    label: draft.name,
    connectionId,
    protocol:
      draft.protocol === "better-auth" || draft.protocol === "supabase"
        ? draft.protocol
        : "oidc",
    issuer: native ? identitySessionIssuer(draft) : draft.issuer,
    clientId: native ? identitySessionAudience(draft) : draft.clientId,
    scope: draft.scope,
  };
  if (native) projection.jwksUri = identitySessionJwksUri(draft);
  return projection;
}

function remainingProviders(
  providers: OperatorIdp[],
  connectionId: string,
  legacy: OperatorIdp | null,
): OperatorIdp[] {
  const sameLegacy = (idp: OperatorIdp) =>
    Boolean(legacy && JSON.stringify(idp) === JSON.stringify(legacy));
  if (legacy && !providers.some(sameLegacy))
    throw new Error(
      "Legacy identity configuration changed; reload before saving",
    );
  return providers.filter(
    (idp) => idp.connectionId !== connectionId && !sameLegacy(idp),
  );
}

function assertNoIssuerConflict(
  draft: IdentityConnectionDraft,
  next: OperatorIdp,
  providers: OperatorIdp[],
): void {
  if (
    !identityConnectionUsesBroker(draft) &&
    providers.some(
      (idp) =>
        !idp.providerHint &&
        !(idp.nativeIdentity === true && next.nativeIdentity === true) &&
        (idp.protocol === "saml" || next.protocol === "saml"
          ? idp.issuer === next.issuer
          : idp.issuer.replace(/\/+$/, "") === next.issuer.replace(/\/+$/, "")),
    )
  )
    throw new Error(
      "This identity issuer is already configured as a sign-in method",
    );
}

export function assertIdentityTrustAvailable(
  draft: IdentityConnectionDraft,
  connectionId: string,
  legacy: OperatorIdp | null,
): void {
  const providers = remainingProviders(
    signInMethods().providers,
    connectionId,
    legacy,
  );
  assertNoIssuerConflict(
    draft,
    providerProjection(draft, connectionId),
    providers,
  );
}

export async function projectIdentityTrust(
  draft: IdentityConnectionDraft | null,
  connectionId: string,
  legacy: OperatorIdp | null = null,
  beforeCommit?: () => void,
): Promise<void> {
  beforeCommit?.();
  const current = loadSettings();
  const methods = signInMethods(current);
  const providers = remainingProviders(methods.providers, connectionId, legacy);
  if (draft) {
    const next = providerProjection(draft, connectionId);
    assertNoIssuerConflict(draft, next, providers);
    providers.push(next);
  }
  await saveSettingsDurable(
    { ...current, signIn: { ...methods, providers } },
    beforeCommit,
  );
}

/** Match the same strict public projection parser used by Settings reads. */
export function identityTrustProjection(
  draft: IdentityConnectionDraft,
  connectionId: string,
): OperatorIdp {
  const parsed = readOperatorIdp(
    JSON.parse(JSON.stringify(providerProjection(draft, connectionId))),
  );
  if (!parsed) throw new Error("Configured identity public trust is invalid");
  return parsed;
}
