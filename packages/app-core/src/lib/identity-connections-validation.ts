import { remoteIdentityApi } from "./device-identity.js";
import { identityConnectionPreset } from "./identity-connections-presets.js";
import {
  type IdentityConnectionDraft,
  IdentityConnectionDraftSchema,
  identityConnectionUsesBroker,
  identityEndpoint,
} from "./identity-connections-schema.js";

function oidcProblems(draft: IdentityConnectionDraft): string[] {
  const problems: string[] = [];
  if (!identityEndpoint(draft.issuer))
    problems.push("Enter an HTTPS OIDC issuer URL");
  if (!draft.clientId.trim())
    problems.push("Enter your registered OIDC client ID");
  if (!draft.scope.split(/\s+/).includes("openid"))
    problems.push("OIDC scopes must include openid");
  return problems;
}
function nativeProblems(draft: IdentityConnectionDraft): string[] {
  const problems: string[] = [];
  if (!identityEndpoint(draft.baseUrl))
    problems.push("Enter an HTTPS identity API base URL");
  if (draft.issuer && !identityEndpoint(draft.issuer))
    problems.push("JWT issuer must be an HTTPS URL");
  if (draft.jwksUri && !identityEndpoint(draft.jwksUri))
    problems.push("JWT signing keys must use an HTTPS URL");
  if (draft.protocol === "supabase" && !draft.publicKey.trim())
    problems.push("Enter the Supabase publishable or anon key");
  if (draft.clientSecret)
    problems.push(
      "A native identity session does not use an OAuth client secret",
    );
  return problems;
}
function brokerProblems(draft: IdentityConnectionDraft): string[] {
  const problems: string[] = [];
  if (!identityEndpoint(draft.brokerUrl))
    problems.push("Enter your organization sign-in service URL");
  else if (draft.brokerUrl.replace(/\/+$/, "") !== remoteIdentityApi())
    problems.push(
      "Connect this sign-in service in Settings before configuring organization identity",
    );
  if (!draft.organizationId.trim())
    problems.push("Select an organization you own");
  return problems;
}
function samlProblems(draft: IdentityConnectionDraft): string[] {
  const problems: string[] = [];
  if (!draft.samlEntityId.trim())
    problems.push("Enter the SAML identity provider entity ID");
  if (!draft.samlMetadataXml && !identityEndpoint(draft.samlMetadataUrl))
    problems.push("Enter an HTTPS SAML metadata URL or metadata XML");
  if (draft.samlMetadataXml && draft.samlMetadataUrl)
    problems.push("Choose metadata URL or XML, not both");
  return problems;
}
function ldapUrlProblem(value: string): string[] {
  try {
    const url = new URL(value);
    if (
      url.protocol === "ldaps:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      return [];
  } catch {
    /* invalid URL */
  }
  return ["Enter a directory URL using ldaps://"];
}
function ldapProblems(draft: IdentityConnectionDraft): string[] {
  const problems = ldapUrlProblem(draft.ldapUrl);
  if (
    draft.ldapBindMode === "bind_template" &&
    !draft.ldapBindTemplate.includes("{username}")
  )
    problems.push("The LDAP bind template must include {username}");
  if (draft.ldapBindMode === "search_then_bind") {
    if (!draft.ldapBaseDn.trim())
      problems.push("Enter the LDAP search base DN");
    if (!draft.ldapSearchFilter.includes("{username}"))
      problems.push("The LDAP search filter must include {username}");
    if (!draft.ldapBindDn.trim())
      problems.push("Enter the LDAP service bind DN");
  }
  if (!draft.ldapSubjectAttribute.trim())
    problems.push("Enter the LDAP stable subject attribute");
  return problems;
}
const protocolProblems = {
  oidc: oidcProblems,
  saml: samlProblems,
  ldap: ldapProblems,
  "better-auth": nativeProblems,
  supabase: nativeProblems,
};
/** User-facing validation is shared by BYO and all provider presets. */
export function identityConnectionProblems(
  draft: IdentityConnectionDraft,
): string[] {
  if (!IdentityConnectionDraftSchema.safeParse(draft).success)
    return ["Invalid identity configuration"];
  const problems: string[] = [];
  if (
    !identityConnectionPreset(draft.providerId)?.protocols.includes(
      draft.protocol,
    )
  )
    problems.push("Select a supported identity protocol");
  if (!draft.name.trim()) problems.push("Enter a connection name");
  problems.push(...protocolProblems[draft.protocol](draft));
  if (identityConnectionUsesBroker(draft))
    problems.push(...brokerProblems(draft));
  return problems;
}
export function requireValidIdentityConnection(
  draft: IdentityConnectionDraft,
): void {
  const problems = identityConnectionProblems(draft);
  if (problems.length) throw new Error(problems.join(". "));
}
