/**
 * `GET /v1/organizations/by-domain/:domain` — the JSON twin of the login
 * page's realm router (routes/interactions-realm.ts).
 *
 * The load-bearing property is anti-enumeration: malformed input, an unknown
 * domain, a claimed-but-unverified domain, and a suspended organization must
 * be byte-identical on the wire. A response that differed for any of them
 * would tell a stranger which companies use this deployment and which are
 * mid-onboarding.
 */

import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

type Plane = ReturnType<typeof createControlPlane>;

async function verifiedOwner(plane: Plane) {
  const created = await plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(created.status).toBe(201);
  const owner = overlapCast(await created.json());
  const linked = await plane.app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject: "by-domain-owner",
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return owner;
}

type SeedOptions = { verify: boolean };

async function seedOrgWithDomain(
  plane: Plane,
  options: SeedOptions = { verify: true },
) {
  const owner = await verifiedOwner(plane);
  const created = await plane.app.request("/v1/organizations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      slug: "acme-corp",
      displayName: "Acme Corp",
      ssoIssuer: "http://127.0.0.1:9090",
    }),
  });
  expect(created.status).toBe(201);
  const org = overlapCast(await created.json());
  await plane.ctx.stores.orgFederation.emailDomains.claim({
    organizationId: String(org.id),
    domain: "acme.com",
    verificationToken: "tok-by-domain",
  });
  if (options.verify) {
    await plane.ctx.stores.orgFederation.emailDomains.markVerified(
      "acme.com",
      plane.ctx.clock(),
    );
  }
  return org;
}

async function lookup(plane: Plane, domain: string) {
  const res = await plane.app.request(
    `/v1/organizations/by-domain/${encodeURIComponent(domain)}`,
  );
  return { status: res.status, body: await res.text() };
}

describe("organization discovery by email domain", () => {
  it("routes a verified domain to the same body the slug lookup serves", async () => {
    const plane = createControlPlane({ config: testConfig() });
    await seedOrgWithDomain(plane);

    const byDomain = await plane.app.request(
      "/v1/organizations/by-domain/acme.com",
    );
    expect(byDomain.status).toBe(200);
    const bySlug = await plane.app.request(
      "/v1/organizations/tenants/acme-corp",
    );
    expect(bySlug.status).toBe(200);

    expect(await byDomain.json()).toEqual(await bySlug.json());
  });

  it("normalizes case and trailing dots before routing", async () => {
    const plane = createControlPlane({ config: testConfig() });
    await seedOrgWithDomain(plane);

    const res = await lookup(plane, "ACME.COM.");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).slug).toBe("acme-corp");
  });

  it("answers one identical 404 for unknown, unverified, and malformed domains", async () => {
    const plane = createControlPlane({ config: testConfig() });
    // A claimed-but-unverified domain must look exactly like an unknown one.
    await seedOrgWithDomain(plane, { verify: false });

    const unknown = await lookup(plane, "nobody.example");
    const unverified = await lookup(plane, "acme.com");
    const malformed = await lookup(plane, "not a domain");
    const singleLabel = await lookup(plane, "localhost");

    for (const res of [unknown, unverified, malformed, singleLabel]) {
      expect(res.status).toBe(404);
      expect(res.body).toBe(unknown.body);
    }
  });

  it("serves a suspended organization the same 404 as an unknown domain", async () => {
    const plane = createControlPlane({ config: testConfig() });
    const org = await seedOrgWithDomain(plane);
    const stored = await plane.ctx.stores.organizations.get(String(org.id));
    if (!stored) throw new Error("seeded org missing");
    await plane.ctx.stores.organizations.set(String(org.id), {
      ...stored,
      state: "suspended",
    });

    const suspended = await lookup(plane, "acme.com");
    const unknown = await lookup(plane, "nobody.example");

    expect(suspended.status).toBe(404);
    expect(suspended.body).toBe(unknown.body);
  });
});
