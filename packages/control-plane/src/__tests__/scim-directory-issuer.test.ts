import { isString, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { ldapIssuer } from "../interactions/ldap.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import {
  type App,
  auth,
  json,
  mintScimToken,
  patchScim,
  provisionUser,
  provisional,
  usersPath,
  verified,
} from "./scim-test-helpers.js";

/**
 * SCIM deprovision must see identities admitted by this organization's
 * directory, not only those stored under ssoIssuer or samlIssuer.
 */

const SAML_ENTITY = "https://idp.example/metadata";
const SAML_METADATA = `<EntityDescriptor entityID="${SAML_ENTITY}"><IDPSSODescriptor><KeyDescriptor use="signing"><KeyInfo><X509Data><X509Certificate>MIIB</X509Certificate></X509Data></KeyInfo></KeyDescriptor></IDPSSODescriptor></EntityDescriptor>`;

function plane() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  });
}

async function createOrg(app: App, ownerToken: string) {
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({
      slug: "dir-org",
      displayName: "Directory org",
      ssoIssuer: "https://idp.example",
    }),
  });
  expect(created.status).toBe(201);
  const id = overlapCast(await created.json()).id;
  if (!isString(id)) throw new Error("org.id missing");
  return id;
}

describe("SCIM directory issuers", () => {
  it("revokes a member admitted by the organization LDAP directory", async () => {
    const { app, ctx } = plane();
    const owner = await verified(app, "dir-owner");
    const orgId = await createOrg(app, String(owner.accessToken));
    const directoryUrl = "ldaps://dir.acme.example:636/dc=acme?x=1";
    await ctx.stores.orgFederation.ldapConfigs.put({
      organizationId: orgId,
      url: directoryUrl,
      bindMode: "bind_template",
      bindTemplate: "uid={username},ou=people,dc=acme,dc=example",
      subjectAttribute: "entryUUID",
      attributeMap: {},
      groupRoleMap: {},
    });
    const issuer = ldapIssuer({
      organizationId: orgId,
      url: directoryUrl,
      bindMode: "bind_template",
      subjectAttribute: "entryUUID",
      attributeMap: {},
      groupRoleMap: {},
    });
    expect(issuer).toBe("ldaps://dir.acme.example:636");

    const member = await provisional(app);
    const linked = await attachVerifiedExternalIdentity(
      ctx,
      String(member.principalId),
      {
        kind: "ldap",
        issuer,
        subject: "carol",
        correlationId: "seed-carol",
      },
    );
    expect(linked.ok).toBe(true);
    const now = ctx.clock();
    await ctx.stores.organizationMemberships.upsert({
      organizationId: orgId,
      principalId: String(member.principalId),
      role: "member",
      createdAt: now,
      updatedAt: now,
    });

    const { token } = await mintScimToken(
      app,
      orgId,
      String(owner.accessToken),
    );
    const created = await provisionUser(app, orgId, token, {
      externalId: "carol",
      userName: "carol@acme.example",
    });
    expect(created.status).toBe(201);
    const deactivated = await patchScim(
      app,
      usersPath(orgId, `/${String(created.body.id)}`),
      token,
      [{ op: "replace", path: "active", value: false }],
    );
    expect(deactivated.status).toBe(200);
    expect(
      await ctx.stores.organizationMemberships.find(
        orgId,
        String(member.principalId),
      ),
    ).toBeUndefined();
    const still = await app.request("/v1/organizations", {
      headers: auth(String(member.accessToken)),
    });
    expect(still.status).toBe(401);
  });

  it("revokes a native SAML member stored under the metadata entityID", async () => {
    const { app, ctx } = plane();
    const owner = await verified(app, "saml-owner");
    const orgId = await createOrg(app, String(owner.accessToken));
    const org = await ctx.stores.organizations.get(orgId);
    if (!org) throw new Error("org missing");
    await ctx.stores.organizations.set(orgId, {
      ...org,
      samlIssuer: undefined,
      samlMetadataXml: SAML_METADATA,
    });

    const member = await provisional(app);
    const linked = await attachVerifiedExternalIdentity(
      ctx,
      String(member.principalId),
      {
        kind: "saml",
        issuer: SAML_ENTITY,
        subject: "bea",
        correlationId: "seed-bea",
      },
    );
    expect(linked.ok).toBe(true);
    const now = ctx.clock();
    await ctx.stores.organizationMemberships.upsert({
      organizationId: orgId,
      principalId: String(member.principalId),
      role: "member",
      createdAt: now,
      updatedAt: now,
    });

    const { token } = await mintScimToken(
      app,
      orgId,
      String(owner.accessToken),
    );
    const created = await provisionUser(app, orgId, token, {
      externalId: "bea",
      userName: "bea@acme.example",
    });
    expect(created.status).toBe(201);
    const deactivated = await patchScim(
      app,
      usersPath(orgId, `/${String(created.body.id)}`),
      token,
      [{ op: "replace", path: "active", value: false }],
    );
    expect(deactivated.status).toBe(200);
    expect(
      await ctx.stores.organizationMemberships.find(
        orgId,
        String(member.principalId),
      ),
    ).toBeUndefined();
  });
});
