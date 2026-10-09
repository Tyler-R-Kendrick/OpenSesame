import { randomBytes } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { orgAssertionSeams } from "../routes/org-assertion.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";

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

describe("verified email retarget on tenant join", () => {
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

  it("does not grant the caller a membership when verified email retargets the identity", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const org = await seedOrg(app);
    await ctx.stores.orgFederation.emailDomains.claim({
      organizationId: String(org.id),
      domain: "acme.test",
      verificationToken: "tok-acme",
    });
    await ctx.stores.orgFederation.emailDomains.markVerified(
      "acme.test",
      ctx.clock(),
    );

    const victim = await provisional(app);
    const attachedVictim = await attachVerifiedExternalIdentity(
      ctx,
      String(victim.principalId),
      {
        kind: "oidc",
        issuer: "https://accounts.example.test",
        subject: "google-alice",
        correlationId: "seed-victim",
        emailNormalized: "alice@acme.test",
        emailVerified: true,
      },
    );
    expect(attachedVictim.ok).toBe(true);

    const now = ctx.clock();
    await ctx.stores.scim.users.create({
      id: `scim_${randomBytes(8).toString("hex")}`,
      organizationId: String(org.id),
      externalId: "idp-alice",
      userName: "alice@acme.test",
      active: true,
      raw: { "urn:opensesame:params:scim:2.0:role": "owner" },
      createdAt: now,
      updatedAt: now,
    });

    orgAssertionSeams.verifyOrgIdToken = vi.fn(async () => ({
      sub: "idp-alice",
      email: "alice@acme.test",
      emailVerified: true,
    }));
    const caller = await provisional(app);
    const joined = await app.request("/v1/organizations/tenants/acme/join", {
      method: "POST",
      headers: {
        ...auth(String(caller.accessToken)),
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "sso", idToken: "verified-id-token" }),
    });
    expect(joined.status).toBe(409);
    const body = overlapCast(await joined.json());
    expect(body.error).toBe("identity_collision");
    expect(JSON.stringify(body)).not.toContain(String(victim.principalId));

    expect(
      await ctx.stores.organizationMemberships.find(
        String(org.id),
        String(caller.principalId),
      ),
    ).toBeUndefined();
    expect(
      await ctx.stores.organizationMemberships.find(
        String(org.id),
        String(victim.principalId),
      ),
    ).toMatchObject({ role: "owner" });

    const listed = await app.request("/v1/organizations", {
      headers: auth(String(caller.accessToken)),
    });
    const organizations = overlapCast(await listed.json()).organizations;
    expect(Array.isArray(organizations)).toBe(true);
    expect(
      organizations.some((org: { slug?: string }) => org.slug === "acme"),
    ).toBe(false);
  });
});
