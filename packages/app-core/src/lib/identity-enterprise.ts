import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type BeginSignInOptions, beginSignIn } from "./federation.js";
import {
  OrgSignInError,
  type OrgSignInOrganization,
  type OrgSignInTransport,
  identityOrgSignInTransport,
  orgSignInClient,
} from "./org-signin.js";
import { brokeredOrgUpstream } from "./providers.js";

export type EnterpriseIdentityProtocol = "oidc" | "saml" | "ldap";
export type IdentitySamlForm = {
  entityId: string;
  metadataUrl: string;
  metadataXml?: string;
};
export type IdentityOidcForm = {
  issuer: string;
  clientId: string;
  clientSecret: string;
};
export type IdentityLdapForm = {
  url: string;
  bindMode: "bind_template" | "search_bind";
  bindTemplate: string;
  searchBaseDn: string;
  searchFilter: string;
  serviceBindDn: string;
  /** Write-only. Empty retains the existing secret on the service. */
  serviceBindSecret: string;
  subjectAttribute: string;
  emailAttribute: string;
  nameAttribute: string;
  groupRoleMap?: Record<string, "owner" | "admin" | "member">;
};
export type IdentityLdapConfiguration = {
  form: IdentityLdapForm;
  serviceBindConfigured: boolean;
};

const readText = (value: BoundaryValue): string =>
  isString(value) ? value : "";

function owner(org: OrgSignInOrganization): void {
  if (!org.owner) throw new OrgSignInError(403, "not_owner");
}

function path(org: OrgSignInOrganization, suffix = ""): string {
  return `/v1/organizations/${encodeURIComponent(org.id)}${suffix}`;
}

function ldapBody(form: IdentityLdapForm): JsonObject {
  const optional = (key: string, value: string): JsonObject =>
    value.trim() ? { [key]: value.trim() } : {};
  const body: JsonObject = {
    url: form.url.trim(),
    bindMode: form.bindMode,
    ...optional("bindTemplate", form.bindTemplate),
    ...optional("searchBaseDn", form.searchBaseDn),
    ...optional("searchFilter", form.searchFilter),
    ...optional("serviceBindDn", form.serviceBindDn),
    subjectAttribute: form.subjectAttribute.trim(),
    attributeMap: {
      ...optional("email", form.emailAttribute),
      ...optional("name", form.nameAttribute),
    },
    groupRoleMap: form.groupRoleMap ?? {},
  };
  // Passwords reach the directory verbatim; spaces can be significant.
  if (form.serviceBindSecret) body.serviceBindSecret = form.serviceBindSecret;
  return body;
}

function ldapConfiguration(body: BoundaryValue): IdentityLdapConfiguration {
  if (
    !isJsonObject(body) ||
    !isString(body.url) ||
    !isString(body.subjectAttribute) ||
    (body.bindMode !== "bind_template" && body.bindMode !== "search_bind")
  ) {
    throw new OrgSignInError(200, "malformed");
  }
  const attributes = isJsonObject(body.attributeMap) ? body.attributeMap : {};
  const roles: NonNullable<IdentityLdapForm["groupRoleMap"]> = {};
  if (isJsonObject(body.groupRoleMap)) {
    for (const [group, role] of Object.entries(body.groupRoleMap)) {
      if (role === "owner" || role === "admin" || role === "member") {
        roles[group] = role;
      }
    }
  }
  return {
    serviceBindConfigured: body.serviceBindConfigured === true,
    form: {
      url: body.url,
      bindMode: body.bindMode,
      bindTemplate: readText(body.bindTemplate),
      searchBaseDn: readText(body.searchBaseDn),
      searchFilter: readText(body.searchFilter),
      serviceBindDn: readText(body.serviceBindDn),
      serviceBindSecret: "",
      subjectAttribute: body.subjectAttribute,
      emailAttribute: readText(attributes.email),
      nameAttribute: readText(attributes.name),
      groupRoleMap: roles,
    },
  };
}

type EnterpriseCall = (
  route: string,
  method?: string,
  body?: JsonObject,
) => Promise<BoundaryValue>;

function caller(transport: OrgSignInTransport): EnterpriseCall {
  return async function call(
    route: string,
    method = "GET",
    body?: JsonObject,
  ): Promise<BoundaryValue> {
    let response: Response;
    try {
      const headers = new Headers({ accept: "application/json" });
      const init: RequestInit = { method, headers };
      if (body) {
        headers.set("content-type", "application/json");
        init.body = JSON.stringify(body);
      }
      response = await transport.fetch(route, init);
    } catch {
      throw new OrgSignInError(0, "unreachable");
    }
    const result: BoundaryValue = await response.json().catch(() => null);
    if (!response.ok) {
      const read = isJsonObject(result) ? result : {};
      throw new OrgSignInError(
        response.status,
        readText(read.error),
        readText(read.message) || null,
      );
    }
    return result;
  };
}

async function readLdap(
  call: EnterpriseCall,
  org: OrgSignInOrganization,
): Promise<IdentityLdapConfiguration | null> {
  owner(org);
  try {
    return ldapConfiguration(await call(path(org, "/ldap")));
  } catch (error) {
    if (error instanceof OrgSignInError && error.status === 404) return null;
    throw error;
  }
}

/** A configuration check. Authentication is verified by completing sign-in. */
async function checkConfiguration(
  call: EnterpriseCall,
  org: OrgSignInOrganization,
  protocol: EnterpriseIdentityProtocol,
) {
  owner(org);
  const route = path(org, protocol === "ldap" ? "/ldap" : "");
  const saved = await call(route);
  if (!isJsonObject(saved)) throw new OrgSignInError(200, "malformed");
  const configured =
    protocol === "ldap"
      ? Boolean(ldapConfiguration(saved).form.url)
      : protocol === "saml"
        ? Boolean(saved.samlMetadataUrl || saved.samlMetadataConfigured)
        : Boolean(saved.ssoIssuer && saved.ssoClientId);
  if (!configured) {
    throw new Error(
      `Save the ${protocol.toUpperCase()} configuration before checking it.`,
    );
  }
  return `${protocol.toUpperCase()} configuration is saved on the Identity service. Complete sign-in to verify authentication.`;
}

/** Owner configuration uses the authenticated Identity service, never local secrets. */
export function identityEnterpriseClient(
  transport: OrgSignInTransport = identityOrgSignInTransport,
) {
  const call = caller(transport);

  return {
    listOrganizations: orgSignInClient(transport).listOrganizations,
    samlServiceProvider: () => ({
      entityId: `${transport.base().replace(/\/$/, "")}/v1/saml/metadata`,
      assertionConsumerService: `${transport.base().replace(/\/$/, "")}/v1/saml/acs`,
    }),
    async saveOidc(org: OrgSignInOrganization, form: IdentityOidcForm) {
      owner(org);
      const body: JsonObject = {
        ssoIssuer: form.issuer.trim(),
        ssoClientId: form.clientId.trim(),
      };
      if (form.clientSecret) body.ssoClientSecret = form.clientSecret;
      await call(path(org), "PATCH", body);
      return "Organization OpenID Connect saved.";
    },
    async saveSaml(org: OrgSignInOrganization, form: IdentitySamlForm) {
      owner(org);
      const xml = form.metadataXml?.trim();
      await call(path(org), "PATCH", {
        samlIssuer: form.entityId.trim(),
        samlMetadataUrl: xml ? null : form.metadataUrl.trim() || null,
        samlMetadataXml: xml || null,
      });
      return "Organization SAML saved.";
    },
    readLdap: (org: OrgSignInOrganization) => readLdap(call, org),
    async saveLdap(org: OrgSignInOrganization, form: IdentityLdapForm) {
      owner(org);
      const roles =
        form.groupRoleMap ??
        (await readLdap(call, org))?.form.groupRoleMap ??
        {};
      return ldapConfiguration(
        await call(
          path(org, "/ldap"),
          "PUT",
          ldapBody({ ...form, groupRoleMap: roles }),
        ),
      );
    },
    check: (org: OrgSignInOrganization, protocol: EnterpriseIdentityProtocol) =>
      checkConfiguration(call, org, protocol),
    async syncLdap(org: OrgSignInOrganization) {
      owner(org);
      await call(path(org, "/ldap/sync"), "POST");
      return "Directory synchronized.";
    },
    async startSignIn(
      org: OrgSignInOrganization,
      options: { protocol: EnterpriseIdentityProtocol; returnTo?: string },
    ) {
      // The hosted page performs the SAML assertion, LDAP bind or confidential
      // OIDC exchange and JIT membership. The browser adopts its canonical session.
      const beginOptions: BeginSignInOptions = {
        providerHint: `org:${org.slug}`,
        prompt: "login",
      };
      if (options.returnTo) beginOptions.returnTo = options.returnTo;
      await beginSignIn(brokeredOrgUpstream(org), beginOptions);
    },
  };
}

export type IdentityEnterpriseClient = ReturnType<
  typeof identityEnterpriseClient
>;
