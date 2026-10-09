import { isString, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { emailIdentityIssuer } from "../services/better-auth-bridge.js";
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
 * SCIM acts on this tenant's members and nobody else's.
 *
 * A directory push names a subject; the subject resolves through an issuer
 * string the organization's owner typed. If that string is one other tenants'
 * people also sign in with — at worst the deployment's own issuer, which every
 * email sign-in carries — a deprovisioning push must still stop at the
 * organization's own membership list.
 */

const DEPLOYMENT_ISSUER = "http://127.0.0.1:8788";

function plane() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: DEPLOYMENT_ISSUER,
      issuer: DEPLOYMENT_ISSUER,
      trustedUpstreamIssuers: ["https://unrelated.example"],
    },
  });
}

async function createOrg(app: App, ownerToken: string, slug: string) {
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ slug, displayName: `Org ${slug}` }),
  });
  expect(created.status).toBe(201);
  const id = overlapCast(await created.json()).id;
  if (!isString(id)) throw new Error("org.id missing");
  const enabled = await app.request(`/v1/organizations/${id}`, {
    method: "PATCH",
    headers: json(ownerToken),
    body: JSON.stringify({ provisioningEnabled: true }),
  });
  expect(enabled.status).toBe(200);
  return id;
}

async function emailSignedIn(
  app: App,
  ctx: ReturnType<typeof plane>["ctx"],
  email: string,
) {
  const session = await provisional(app);
  const token = String(session.accessToken);
  const attached = await attachVerifiedExternalIdentity(
    ctx,
    String(session.principalId),
    {
      kind: "email",
      issuer: emailIdentityIssuer(ctx),
      subject: email,
      correlationId: `test-${email}`,
      emailNormalized: email,
      emailVerified: true,
    },
  );
  expect(attached.ok).toBe(true);
  return { token, principalId: String(session.principalId) };
}

function stillSignedIn(app: App, token: string) {
  return app
    .request("/v1/organizations", { headers: auth(token) })
    .then((res) => res.status);
}

describe("SCIM tenant scope", () => {
  it.each([
    [DEPLOYMENT_ISSUER],
    [`${DEPLOYMENT_ISSUER}/`],
    ["HTTP://127.0.0.1:8788"],
  ])(
    "refuses an organization claiming the deployment issuer %s",
    async (issuer) => {
      const { app } = plane();
      const owner = await verified(app, "self-issuer-owner");
      const orgId = await createOrg(
        app,
        String(owner.accessToken),
        "self-issuer",
      );
      for (const field of ["ssoIssuer", "samlIssuer"]) {
        const res = await app.request(`/v1/organizations/${orgId}`, {
          method: "PATCH",
          headers: json(String(owner.accessToken)),
          body: JSON.stringify({ [field]: issuer }),
        });
        expect(res.status).toBe(400);
        expect(overlapCast(await res.json()).error).toBe("unsafe_issuer");
      }
    },
  );

  it("deprovisioning never reaches a principal outside the organization", async () => {
    const { app, ctx } = plane();
    const owner = await verified(app, "scope-owner");
    const orgId = await createOrg(app, String(owner.accessToken), "scope-org");
    // The route refuses this now; a record written before the fence (or by
    // any other path) must still not be able to reach strangers.
    const org = await ctx.stores.organizations.get(orgId);
    if (!org) throw new Error("org missing");
    await ctx.stores.organizations.set(orgId, {
      ...org,
      ssoIssuer: DEPLOYMENT_ISSUER,
    });
    const { token } = await mintScimToken(
      app,
      orgId,
      String(owner.accessToken),
    );

    const stranger = await emailSignedIn(app, ctx, "stranger@else.example");
    const member = await emailSignedIn(app, ctx, "member@scope.example");
    const now = ctx.clock();
    await ctx.stores.organizationMemberships.upsert({
      organizationId: orgId,
      principalId: member.principalId,
      role: "member",
      createdAt: now,
      updatedAt: now,
    });

    for (const email of ["stranger@else.example", "member@scope.example"]) {
      const created = await provisionUser(app, orgId, token, {
        userName: email,
      });
      expect(created.status).toBe(201);
      const deactivated = await patchScim(
        app,
        usersPath(orgId, `/${String(created.body.id)}`),
        token,
        [{ op: "replace", path: "active", value: false }],
      );
      expect(deactivated.status).toBe(200);
    }

    // The stranger is untouched; the member is gone, session and all.
    expect(await stillSignedIn(app, stranger.token)).toBe(200);
    expect(await stillSignedIn(app, member.token)).toBe(401);
    expect(
      await ctx.stores.organizationMemberships.find(orgId, member.principalId),
    ).toBeUndefined();
  });
});
