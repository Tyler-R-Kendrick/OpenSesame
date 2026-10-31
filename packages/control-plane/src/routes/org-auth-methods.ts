import type { OrganizationAuthMethod } from "@opensesame/contracts";
import type { Organization } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/** True when the tenant configured a real SAML IdP rather than a broker. */
export function usesNativeSaml(org: Organization): boolean {
  return Boolean(org.samlMetadataUrl || org.samlMetadataXml);
}

/**
 * The sign-in methods a tenant offers, as the public tenant endpoint and the
 * hosted login page both render them.
 *
 * The two SAML shapes are deliberately distinguishable (ADR 0056): with
 * metadata configured the method is native SAML and runs entirely server-side
 * through the hosted login page, so no browser-side issuer is offered at all.
 * Without metadata `samlIssuer` keeps its ADR 0016 meaning — the OIDC issuer
 * of a SAML-brokering Keycloak — and stays a normal brokered redirect.
 */
export async function tenantAuthMethods(
  ctx: AppContext,
  org: Organization,
): Promise<OrganizationAuthMethod[]> {
  const methods: OrganizationAuthMethod[] = [];
  if (org.ssoIssuer) {
    methods.push({ kind: "sso", label: "SSO", issuer: org.ssoIssuer });
  }
  if (usesNativeSaml(org)) {
    methods.push({ kind: "saml", label: "SAML", native: true });
  } else if (org.samlIssuer) {
    methods.push({ kind: "saml", label: "SAML", issuer: org.samlIssuer });
  }
  // The LDAP leg itself belongs to the login page (a first-party username and
  // password form); this is the advertisement that the tenant has one.
  const ldap = await ctx.stores.orgFederation.ldapConfigs.get(org.id);
  if (ldap) methods.push({ kind: "ldap", label: "Directory" });
  return methods;
}

/**
 * The OIDC issuer an id_token join may be asserted against.
 *
 * Native SAML has none — its assertions arrive at the ACS as signed XML, not
 * as a bearer id_token — and neither does LDAP, so both answer `undefined` and
 * the route refuses the method rather than verifying against an entityID.
 */
export function issuerForMethod(
  org: Organization,
  method: "sso" | "saml" | "ldap",
): string | undefined {
  if (method === "sso") return org.ssoIssuer;
  if (method === "ldap") return undefined;
  return usesNativeSaml(org) ? undefined : org.samlIssuer;
}
