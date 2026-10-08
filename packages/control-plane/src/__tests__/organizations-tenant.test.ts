import type { UpdateOrganizationRequest } from "@opensesame/contracts";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  OrgAssertionError,
  orgAssertionSeams,
} from "../routes/org-assertion.js";

type App = ReturnType<typeof createControlPlane>["app"];

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

async function verified(app: App, subject: string) {
  const created = await provisional(app);
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return created;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("organization tenant discovery and join", () => {
  const originalVerify = orgAssertionSeams.verifyOrgIdToken;

  afterEach(() => {
    vi.restoreAllMocks();
    orgAssertionSeams.verifyOrgIdToken = originalVerify;
  });

  async function seedOrg(app: App) {
    const owner = await verified(app, "tenant-owner");
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: "acme",
        displayName: "Acme",
        ssoIssuer: "http://127.0.0.1:9090",
        samlIssuer: "http://127.0.0.1:8080/realms/acme",
      }),
    });
    expect(created.status).toBe(201);
    return overlapCast(await created.json());
  }

  it("advertises SSO and SAML methods without authentication", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    await seedOrg(app);

    const res = await app.request("/v1/organizations/tenants/acme");
    expect(res.status).toBe(200);
    expect(overlapCast(await res.json())).toEqual({
      slug: "acme",
      displayName: "Acme",
      state: "active",
      authMethods: [
        {
          kind: "sso",
          label: "SSO",
          issuer: "http://127.0.0.1:9090",
        },
        {
          kind: "saml",
          label: "SAML",
          issuer: "http://127.0.0.1:8080/realms/acme",
        },
      ],
    });
  });

  it("hides missing and suspended tenants", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const org = await seedOrg(app);
    expect(
      (await app.request("/v1/organizations/tenants/missing")).status,
    ).toBe(404);

    const stored = await ctx.stores.organizations.get(org.id);
    if (!stored) throw new Error("org missing");
    await ctx.stores.organizations.set(org.id, {
      ...stored,
      state: "suspended",
    });
    expect((await app.request("/v1/organizations/tenants/acme")).status).toBe(
      404,
    );
  });

  it("lets a provisional guest join after a verified org assertion", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    await seedOrg(app);
    orgAssertionSeams.verifyOrgIdToken = vi.fn(async () => ({ sub: "user-1" }));

    const guest = await provisional(app);
    const joined = await app.request("/v1/organizations/tenants/acme/join", {
      method: "POST",
      headers: {
        ...auth(guest.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "sso", idToken: "id-token" }),
    });
    expect(joined.status).toBe(201);
    const body = overlapCast(await joined.json());
    expect(body.slug).toBe("acme");
    expect(body.role).toBe("member");

    const listed = await app.request("/v1/organizations", {
      headers: auth(guest.accessToken),
    });
    expect(overlapCast(await listed.json()).organizations).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "acme" })]),
    );
  });

  it("is idempotent when the guest is already a member", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    await seedOrg(app);
    orgAssertionSeams.verifyOrgIdToken = vi.fn(async () => ({ sub: "user-1" }));
    const guest = await provisional(app);
    const first = await app.request("/v1/organizations/tenants/acme/join", {
      method: "POST",
      headers: {
        ...auth(guest.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "saml", idToken: "id-token" }),
    });
    expect(first.status).toBe(201);
    const again = await app.request("/v1/organizations/tenants/acme/join", {
      method: "POST",
      headers: {
        ...auth(guest.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "saml", idToken: "id-token" }),
    });
    expect(again.status).toBe(200);
    expect(overlapCast(await again.json()).role).toBe("member");
  });

  it("refuses an unconfigured method and a bad assertion", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "no-saml-owner");
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: "solo",
        displayName: "Solo",
        ssoIssuer: "http://127.0.0.1:9090",
      }),
    });
    expect(created.status).toBe(201);

    const guest = await provisional(app);
    const missing = await app.request("/v1/organizations/tenants/solo/join", {
      method: "POST",
      headers: {
        ...auth(guest.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "saml", idToken: "id-token" }),
    });
    expect(missing.status).toBe(409);

    orgAssertionSeams.verifyOrgIdToken = vi.fn(async () => {
      throw new OrgAssertionError("invalid_token", "nope");
    });
    const bad = await app.request("/v1/organizations/tenants/solo/join", {
      method: "POST",
      headers: {
        ...auth(guest.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "sso", idToken: "id-token" }),
    });
    expect(bad.status).toBe(401);
  });

  it("lets an owner set and clear tenant issuers", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "patch-owner");
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "patchy", displayName: "Patchy" }),
    });
    const org = overlapCast(await created.json());

    const patched = await app.request(`/v1/organizations/${org.id}`, {
      method: "PATCH",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ssoIssuer: "https://idp.example" }),
    });
    expect(patched.status).toBe(200);
    expect(overlapCast(await patched.json()).ssoIssuer).toBe(
      "https://idp.example",
    );

    const tenant = await app.request("/v1/organizations/tenants/patchy");
    expect(overlapCast(await tenant.json()).authMethods).toEqual([
      { kind: "sso", label: "SSO", issuer: "https://idp.example" },
    ]);

    const cleared = await app.request(`/v1/organizations/${org.id}`, {
      method: "PATCH",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ssoIssuer: null }),
    });
    expect(overlapCast(await cleared.json()).ssoIssuer).toBeUndefined();
  });

  it("distinguishes native SAML from a brokering Keycloak, and advertises LDAP", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const org = await seedOrg(app);

    // Metadata configured: the method becomes native SAML, runs server-side,
    // and stops offering the browser an issuer to redirect to.
    const stored = await ctx.stores.organizations.get(org.id);
    if (!stored) throw new Error("org missing");
    await ctx.stores.organizations.set(org.id, {
      ...stored,
      samlMetadataUrl: "https://idp.example/metadata",
    });
    await ctx.stores.orgFederation.ldapConfigs.put({
      organizationId: org.id,
      url: "ldaps://dir.example",
      bindMode: "bind_template",
      bindTemplate: "uid={username},ou=people,dc=example,dc=com",
      subjectAttribute: "entryUUID",
      attributeMap: { email: "mail" },
      groupRoleMap: {},
    });

    const tenant = await app.request("/v1/organizations/tenants/acme");
    expect(overlapCast(await tenant.json()).authMethods).toEqual([
      { kind: "sso", label: "SSO", issuer: "http://127.0.0.1:9090" },
      { kind: "saml", label: "SAML", native: true },
      { kind: "ldap", label: "Directory" },
    ]);
  });

  it("refuses an issuer this deployment must not dereference", async () => {
    // Dev defaults keep loopback reachable for the local IdP; with them off,
    // the org surface must not become an SSRF gadget (T21).
    const { app, ctx } = createControlPlane({
      config: { ...testConfig(), allowDevDefaults: false },
    });
    // With dev defaults off, self-asserted identity links are refused, so the
    // owner is promoted through the principal repository directly.
    const owner = await provisional(app);
    const minted = await ctx.repos.principals.getById(owner.principalId);
    if (!minted) throw new Error("principal missing");
    const now = ctx.clock();
    await ctx.repos.principals.update(
      owner.principalId,
      {
        state: "active",
        assurance: "verified",
        verifiedAt: now,
        updatedAt: now,
      },
      minted.version,
    );
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "fenced", displayName: "Fenced" }),
    });
    expect(created.status).toBe(201);
    const org = overlapCast(await created.json());

    for (const patch of [
      { ssoIssuer: "http://169.254.169.254/latest/meta-data" },
      { samlIssuer: "http://127.0.0.1:9090" },
      { samlMetadataUrl: "http://metadata.google.internal/computeMetadata" },
    ]) {
      const res = await app.request(`/v1/organizations/${org.id}`, {
        method: "PATCH",
        headers: {
          ...auth(owner.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(400);
      expect(overlapCast(await res.json()).error).toBe("unsafe_issuer");
    }

    // A public issuer still lands.
    const allowed = await app.request(`/v1/organizations/${org.id}`, {
      method: "PATCH",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ssoIssuer: "https://idp.example" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("refuses two SAML metadata sources at once and stores the surviving one", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "metadata-owner");
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "metadata", displayName: "Metadata" }),
    });
    const org = overlapCast(await created.json());
    const patch = (body: UpdateOrganizationRequest) =>
      app.request(`/v1/organizations/${org.id}`, {
        method: "PATCH",
        headers: {
          ...auth(owner.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const both = await patch({
      samlMetadataUrl: "https://idp.example/metadata",
      samlMetadataXml: `<EntityDescriptor>${"x".repeat(64)}</EntityDescriptor>`,
    });
    expect(both.status).toBe(400);

    expect(
      (await patch({ samlMetadataUrl: "https://idp.example/metadata" })).status,
    ).toBe(200);
    // Swapping to inline XML must clear the URL, or a later fetch has two
    // answers to "which document describes this IdP".
    const swapped = await patch({
      samlMetadataUrl: null,
      samlMetadataXml: `<EntityDescriptor>${"x".repeat(64)}</EntityDescriptor>`,
    });
    expect(swapped.status).toBe(200);
    const body = overlapCast(await swapped.json());
    expect(body.samlMetadataUrl).toBeUndefined();
    expect(body.samlMetadataConfigured).toBe(true);

    const enabled = await patch({ provisioningEnabled: true });
    expect(overlapCast(await enabled.json()).provisioningEnabled).toBe(true);
  });

  it("rejects issuer URLs with credentials", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "bad-issuer");
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: "nope",
        displayName: "Nope",
        ssoIssuer: "https://user:pass@idp.example",
      }),
    });
    expect(created.status).toBe(400);
  });
});
