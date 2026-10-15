import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceIdentitySeams } from "./device-identity.js";
import { federationSeams } from "./federation.js";
import {
  type IdentityLdapForm,
  identityEnterpriseClient,
} from "./identity-enterprise.js";
import type { OrgSignInOrganization } from "./org-signin.js";

const organization: OrgSignInOrganization = {
  id: "org:acme",
  slug: "acme",
  displayName: "Acme",
  role: "owner",
  owner: true,
  secretStored: true,
  upstream: {
    ssoIssuer: "",
    ssoClientId: "",
    ssoClientSecret: "",
    samlIssuer: "",
    samlMetadataUrl: "",
  },
};
const ldap: IdentityLdapForm = {
  url: "ldaps://directory.example",
  bindMode: "search_bind",
  bindTemplate: "",
  searchBaseDn: "ou=people,dc=example",
  searchFilter: "(uid={username})",
  serviceBindDn: "cn=service,dc=example",
  serviceBindSecret: "",
  subjectAttribute: "entryUUID",
  emailAttribute: "mail",
  nameAttribute: "cn",
};

function transport(body: BoundaryValue, status = 200) {
  const fetch = vi.fn(
    async (_path: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
  return {
    fetch,
    client: identityEnterpriseClient({
      fetch,
      base: () => "https://identity.example",
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("enterprise identity client", () => {
  it("saves SAML metadata without clearing existing OIDC configuration", async () => {
    const { client, fetch } = transport({ id: organization.id });
    await client.saveSaml(organization, {
      entityId: "https://saml.example/entity",
      metadataUrl: "https://saml.example/metadata",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/v1/organizations/org%3Aacme",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      samlIssuer: "https://saml.example/entity",
      samlMetadataUrl: "https://saml.example/metadata",
      samlMetadataXml: null,
    });
  });

  it("switches inline SAML metadata atomically", async () => {
    const { client, fetch } = transport({ id: organization.id });
    await client.saveSaml(organization, {
      entityId: "https://saml.example",
      metadataUrl: "https://old.example",
      metadataXml: "<EntityDescriptor />",
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      samlIssuer: "https://saml.example",
      samlMetadataUrl: null,
      samlMetadataXml: "<EntityDescriptor />",
    });
  });

  it("leaves write-only OIDC credentials untouched when no secret was supplied", async () => {
    const { client, fetch } = transport({ id: organization.id });
    await client.saveOidc(organization, {
      issuer: "https://oidc.example",
      clientId: "registered-client",
      clientSecret: "",
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      ssoIssuer: "https://oidc.example",
      ssoClientId: "registered-client",
    });
  });

  it("retains LDAP groups and never seeds returned secret values", async () => {
    const { client, fetch } = transport({
      ...ldap,
      attributeMap: { email: "mail", name: "cn" },
      groupRoleMap: { engineers: "member" },
      serviceBindConfigured: true,
      serviceBindSecret: "must-not-reach-form",
    });
    const saved = await client.saveLdap(organization, {
      ...ldap,
      groupRoleMap: { engineers: "member" },
    });
    expect(saved.form.serviceBindSecret).toBe("");
    expect(saved.serviceBindConfigured).toBe(true);
    expect(saved.form.groupRoleMap).toEqual({ engineers: "member" });
    const submitted = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(submitted).not.toHaveProperty("serviceBindSecret");
    expect(submitted.attributeMap).toEqual({ email: "mail", name: "cn" });
  });

  it("preserves existing LDAP role mappings when a simpler partner form omits them", async () => {
    const { client, fetch } = transport({
      ...ldap,
      attributeMap: { email: "mail", name: "cn" },
      groupRoleMap: { engineers: "member" },
      serviceBindConfigured: true,
    });
    await client.saveLdap(organization, ldap);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
    const submitted = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(submitted.groupRoleMap).toEqual({ engineers: "member" });
  });

  it("refuses members before making any configuration requests", async () => {
    const { client, fetch } = transport({});
    const member = { ...organization, owner: false, role: "member" };
    await expect(
      client.saveSaml(member, {
        entityId: "https://saml.example",
        metadataUrl: "https://saml.example/metadata",
      }),
    ).rejects.toThrow(/Only an owner/);
    await expect(client.saveLdap(member, ldap)).rejects.toThrow(
      /Only an owner/,
    );
    await expect(client.readLdap(member)).rejects.toThrow(/Only an owner/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports authorization, network and malformed configuration failures", async () => {
    await expect(
      transport({ error: "unauthorized" }, 401).client.readLdap(organization),
    ).rejects.toThrow(/Sign in again/);
    await expect(
      transport({}, 200).client.readLdap(organization),
    ).rejects.toThrow(/shape/);
    expect(
      await transport({ error: "not_found" }, 404).client.readLdap(
        organization,
      ),
    ).toBeNull();
    const { client, fetch } = transport({});
    fetch.mockRejectedValueOnce(new Error("network"));
    await expect(client.saveLdap(organization, ldap)).rejects.toThrow(
      /could not be reached/,
    );
  });

  it("checks the saved service configuration and distinguishes it from authentication", async () => {
    const { client } = transport({ samlMetadataConfigured: true });
    expect(await client.check(organization, "saml")).toContain(
      "Complete sign-in",
    );
    await expect(
      transport({}).client.check(organization, "saml"),
    ).rejects.toThrow(/Save/);
  });

  it.each(["saml", "ldap", "oidc"] as const)(
    "starts %s through the hosted organization login and canonical session return",
    async (protocol) => {
      vi.spyOn(deviceIdentitySeams, "remoteIdentityApi").mockReturnValue(
        "https://identity.example",
      );
      const begin = vi
        .spyOn(federationSeams, "beginSignIn")
        .mockResolvedValue();
      await transport({}).client.startSignIn(organization, {
        protocol,
        returnTo: "/settings/integrations",
      });
      expect(begin).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "broker:org:acme",
          issuer: "https://identity.example",
        }),
        {
          providerHint: "org:acme",
          returnTo: "/settings/integrations",
          prompt: "login",
        },
      );
      // Broker-issued subjects are pairwise. A direct organization join would
      // confuse that subject with the upstream user's canonical identity.
      expect(begin.mock.calls[0]?.[1]).not.toHaveProperty("orgMethod");
    },
  );
});
