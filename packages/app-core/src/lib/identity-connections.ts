/** One configurable identity road, composed by partner presets and the BYO surface. */
import {
  beginSavedNativeOidc,
  captureOidcConfiguration,
  saveConfiguredNativeOidc,
} from "../browser/identity-oidc-dispatch.js";
import {
  beginSavedNativeSaml,
  captureSamlConfiguration,
  saveConfiguredNativeSaml,
} from "../browser/identity-saml-dispatch.js";
import { env } from "../host.js";
import { pageOrigin } from "../ports.js";
import type { Connection } from "./connections.js";
import { deviceConnection } from "./device-connectors.js";
import { remoteIdentityApi } from "./device-identity.js";
import { assertSafeReturnTo } from "./federation-callback.js";
import {
  beginSignIn,
  clearSession,
  loadSession,
  operatorUpstream,
} from "./federation.js";
import {
  admitConfiguredIdentitySession,
  captureConfiguredIdentitySessionOwner,
} from "./identity-connections-admission.js";
import { testIdentityOidc } from "./identity-connections-oidc.js";
import {
  type IdentityConnectionCredentials,
  type IdentityConnectionDraft,
  type IdentityConnectionTest,
  identityConnectionUsesBroker,
  normalizeIdentityConnectionDraft,
} from "./identity-connections-schema.js";
import { identityConnectionDeviceSeams } from "./identity-connections-seam.js";
import {
  logoutIdentitySession,
  signInIdentitySession,
  testIdentitySession,
} from "./identity-connections-session.js";
import {
  assertIdentityConnectionUnchanged,
  deleteIdentityConnection,
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
  readIdentityConnection,
  resolveIdentityConnectionSecrets,
  writeIdentityConnection,
} from "./identity-connections-store.js";
import {
  assertIdentityTrustAvailable,
  captureLegacyIdentityMigration,
  projectIdentityTrust,
} from "./identity-connections-trust.js";
import { requireValidIdentityConnection } from "./identity-connections-validation.js";
import { isNativeOidcConfiguration } from "./identity-oidc-config.js";
import type { OrgSignInOrganization } from "./org-signin.js";
import { type OperatorIdp, signInMethods } from "./settings.js";
export { readInitialIdentityDraft } from "./identity-connections-trust.js";

export {
  IDENTITY_CONNECTION_PRESETS,
  identityConnectionDraft,
  identityConnectionPreset,
} from "./identity-connections-presets.js";
export type { IdentityConnectionPreset } from "./identity-connections-presets.js";
export type {
  IdentityConnectionCredentials,
  IdentityConnectionDraft,
  IdentityConnectionTest,
  IdentityProtocol,
} from "./identity-connections-schema.js";
export { identityConnectionProblems } from "./identity-connections-validation.js";
export {
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
  listIdentityConnections,
  readIdentityConnection,
} from "./identity-connections-store.js";

function assertBroker(brokerUrl?: string): void {
  if (
    !remoteIdentityApi() ||
    (brokerUrl && brokerUrl.replace(/\/+$/, "") !== remoteIdentityApi())
  ) {
    throw new Error(
      "Connect this organization sign-in service in Settings first",
    );
  }
}
export async function listIdentityConnectionOrganizations(
  brokerUrl?: string,
): Promise<OrgSignInOrganization[]> {
  assertBroker(brokerUrl);
  const { identityEnterpriseClient } = await import("./identity-enterprise.js");
  return (await identityEnterpriseClient().listOrganizations()).filter(
    (org) => org.owner,
  );
}
async function organization(
  draft: IdentityConnectionDraft,
): Promise<OrgSignInOrganization> {
  const orgs = await listIdentityConnectionOrganizations(draft.brokerUrl);
  const found = orgs.find((org) => org.id === draft.organizationId);
  if (!found)
    throw new Error(
      "Sign in as an owner of this organization to configure identity",
    );
  return found;
}
async function configureBroker(draft: IdentityConnectionDraft): Promise<void> {
  const org = await organization(draft);
  const { identityEnterpriseClient } = await import("./identity-enterprise.js");
  const client = identityEnterpriseClient();
  draft.organizationSlug = org.slug;
  if (draft.protocol === "oidc") {
    await client.saveOidc(org, {
      issuer: draft.issuer,
      clientId: draft.clientId,
      clientSecret: draft.clientSecret,
    });
  } else if (draft.protocol === "ldap") {
    await client.saveLdap(org, {
      url: draft.ldapUrl,
      bindMode:
        draft.ldapBindMode === "search_then_bind"
          ? "search_bind"
          : "bind_template",
      bindTemplate: draft.ldapBindTemplate,
      searchBaseDn: draft.ldapBaseDn,
      searchFilter: draft.ldapSearchFilter,
      serviceBindDn: draft.ldapBindDn,
      serviceBindSecret: draft.ldapBindPassword,
      subjectAttribute: draft.ldapSubjectAttribute,
      emailAttribute: draft.ldapEmailAttribute,
      nameAttribute: draft.ldapNameAttribute,
    });
  }
}

/** Test is read-only: no saved account, configuration, tokens, or grants are minted. */
async function checkIdentityConfiguration(
  draft: IdentityConnectionDraft,
  saml: ReturnType<typeof captureSamlConfiguration> | null,
): Promise<void> {
  if (saml) {
    await saml.check(draft);
    saml.assertCurrent();
  } else if (identityConnectionUsesBroker(draft)) await configureBroker(draft);
  else if (draft.protocol === "oidc") await testIdentityOidc(draft.issuer);
  else await testIdentitySession(draft);
}

export async function testIdentityConnection(
  input: IdentityConnectionDraft,
  existingId?: string,
): Promise<IdentityConnectionTest> {
  const oidc =
    input.protocol === "oidc" ? captureOidcConfiguration(existingId) : null;
  const saml =
    input.protocol === "saml"
      ? captureSamlConfiguration(input.samlMetadataUrl, existingId)
      : null;
  try {
    const draft = resolveIdentityConnectionSecrets(
      normalizeIdentityConnectionDraft(input),
      existingId,
    );
    requireValidIdentityConnection(draft);
    if (oidc && isNativeOidcConfiguration(draft))
      return await oidc.check(draft);
    if (saml) {
      const result = await saml.check(draft);
      saml.assertCurrent();
      return result;
    }
    if (draft.protocol === "better-auth" || draft.protocol === "supabase")
      return testIdentitySession(draft);
    if (identityConnectionUsesBroker(draft)) {
      const org = await organization(draft);
      if (draft.protocol === "oidc") return testIdentityOidc(draft.issuer);
      const { identityEnterpriseClient } = await import(
        "./identity-enterprise.js"
      );
      return {
        message: await identityEnterpriseClient().check(org, draft.protocol),
      };
    }
    return testIdentityOidc(draft.issuer);
  } finally {
    await saml?.release();
    await oidc?.release();
  }
}

function clearSavedIdentitySession(
  id: string,
  legacy: OperatorIdp | null,
): void {
  const session = loadSession();
  if (
    session?.upstreamId === `identity:${id}` ||
    (legacy && session?.upstreamId === `operator:${legacy.issuer}`)
  )
    clearSession();
}

/** Configure a real adapter and persist it before adding its public sign-in method. */
export async function saveIdentityConnection(
  input: IdentityConnectionDraft,
  existingId?: string,
): Promise<Connection> {
  const oidc =
    input.protocol === "oidc" ? captureOidcConfiguration(existingId) : null;
  const saml =
    input.protocol === "saml"
      ? captureSamlConfiguration(input.samlMetadataUrl, existingId)
      : null;
  try {
    const draft = resolveIdentityConnectionSecrets(
      normalizeIdentityConnectionDraft(input),
      existingId,
    );
    requireValidIdentityConnection(draft);
    if (existingId && !readIdentityConnection(existingId))
      throw new Error("Saved identity connection not found");
    if (saml) return await saveConfiguredNativeSaml(draft, existingId, saml);
    if (oidc && isNativeOidcConfiguration(draft))
      return await saveConfiguredNativeOidc(draft, existingId, oidc);
    const legacy = captureLegacyIdentityMigration(draft, existingId);
    assertIdentityTrustAvailable(draft, existingId ?? "", legacy);
    const previous = existingId
      ? getIdentityConnectionRuntime(existingId)
      : null;
    // Configuration checks cannot masquerade as successful authentication.
    await checkIdentityConfiguration(draft, saml);
    const connection = await writeIdentityConnection(draft, existingId);
    try {
      await projectIdentityTrust(draft, connection.connectionId, legacy);
    } catch (error) {
      // Public trust and the sealed ledger are separate files. A failed trust
      // projection must not leave a new unusable connection behind.
      if (previous)
        await writeIdentityConnection(previous, connection.connectionId);
      else await deleteIdentityConnection(connection.connectionId);
      throw error;
    }
    clearSavedIdentitySession(connection.connectionId, legacy);
    return deviceConnection(connection.connectionId) ?? connection;
  } finally {
    await saml?.release();
    await oidc?.release();
  }
}

export type IdentityConnectionSignInOptions = {
  returnTo?: string;
  credentials?: IdentityConnectionCredentials;
};
function configuredIdentityReturnTo(
  options: IdentityConnectionSignInOptions,
): string | undefined {
  const returnTo = options.returnTo
    ? assertSafeReturnTo(options.returnTo, pageOrigin(), env().BASE_URL || "/")
    : undefined;
  if (options.returnTo && !returnTo)
    throw new Error("That return address is not part of this app.");
  return returnTo;
}
/** The saved configuration, never the current form draft, chooses the authentication target. */
export async function beginIdentityConnectionSignIn(
  connectionId: string,
  options: IdentityConnectionSignInOptions = {},
): Promise<void> {
  const returnTo = configuredIdentityReturnTo(options);
  if (
    signInMethods().providers.some(
      (provider) =>
        provider.connectionId === connectionId &&
        provider.protocol === "oidc" &&
        provider.nativeIdentity === true,
    )
  )
    return beginSavedNativeOidc(connectionId);
  if (
    signInMethods().providers.some(
      (provider) =>
        provider.connectionId === connectionId && provider.protocol === "saml",
    )
  )
    return beginSavedNativeSaml(connectionId);
  await hydrateIdentityConnections();
  const draft = getIdentityConnectionRuntime(connectionId);
  if (!draft) throw new Error("Saved identity connection not found");
  requireValidIdentityConnection(draft);
  if (isNativeOidcConfiguration(draft))
    throw new Error(
      "Re-save this identity connection to enable its native sign-in method",
    );
  if (identityConnectionUsesBroker(draft)) {
    assertBroker(draft.brokerUrl);
    if (!draft.organizationSlug)
      throw new Error("Saved organization identity has no organization slug");
    const provider = signInMethods().providers.find(
      (idp) => idp.connectionId === connectionId,
    );
    if (!provider)
      throw new Error("This identity connection is not enabled for sign-in");
    return beginSignIn(operatorUpstream(provider), {
      providerHint: `org:${draft.organizationSlug}`,
      prompt: "login",
      returnTo,
    });
  }
  if (draft.protocol === "better-auth" || draft.protocol === "supabase") {
    if (!options.credentials)
      throw new Error("Enter your account email and password to sign in");
    const owner = captureConfiguredIdentitySessionOwner(connectionId);
    try {
      const identity = await signInIdentitySession(draft, options.credentials);
      owner.assertCurrent();
      await assertIdentityConnectionUnchanged(connectionId, draft);
      identity.upstreamId = `identity:${connectionId}`;
      await admitConfiguredIdentitySession(identity, owner);
    } finally {
      owner.release();
    }
    return;
  }
  const provider = signInMethods().providers.find(
    (idp) => idp.connectionId === connectionId,
  );
  if (!provider)
    throw new Error("This identity connection is not enabled for sign-in");
  return beginSignIn(operatorUpstream(provider), {
    scope: draft.scope,
    returnTo,
  });
}

/** Revoke the upstream session and public trust before forgetting the sealed configuration. */
export async function removeIdentityConnection(
  connectionId: string,
): Promise<void> {
  const draft = getIdentityConnectionRuntime(connectionId);
  if (!draft) throw new Error("Saved identity connection not found");
  const session = loadSession();
  if (
    (draft.protocol === "better-auth" || draft.protocol === "supabase") &&
    session?.upstreamId === `identity:${connectionId}`
  ) {
    await logoutIdentitySession(draft, session.idToken);
  }
  await projectIdentityTrust(null, connectionId);
  if (session?.upstreamId === `identity:${connectionId}`) clearSession();
  if (!(await deleteIdentityConnection(connectionId)))
    throw new Error("Saved identity connection not found");
}

identityConnectionDeviceSeams.revoke = removeIdentityConnection;
identityConnectionDeviceSeams.authorization = (connectionId) => {
  const draft = readIdentityConnection(connectionId);
  if (!draft) return null;
  const session = loadSession();
  const active = session?.upstreamId === `identity:${connectionId}`;
  return {
    status: active ? "active" : "pending",
    statusDetail: active
      ? "Identity sign-in verified"
      : "Configured; sign in to verify identity",
    grantedScopes: [],
    accountLabel: active
      ? (session.name ?? session.email ?? session.pairwiseSub)
      : null,
    expiresAt: active ? new Date(session.expiresAt).toISOString() : null,
    refreshable: false,
  };
};
