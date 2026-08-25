import { createHash, randomBytes } from "node:crypto";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  SCIM_TOKEN_PREFIX,
  provisionedRoleForSubject,
  roleForGroupName,
} from "../routes/scim.js";

/**
 * SCIM 2.0 provisioning, end to end (C15, D11).
 *
 * The counterparty for the sign-in half is the reference IdP: the subject a
 * directory provisions has to be the subject an assertion actually carries, and
 * the only way to prove those are the same string is to mint the assertion from
 * a real IdP over a real socket. Nothing here stubs a protocol.
 */

type App = ReturnType<typeof createControlPlane>["app"];

function testConfig(issuer: string) {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
    trustedUpstreamIssuers: [issuer],
  } as const;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function json(token: string) {
  return { ...auth(token), "content-type": "application/json" };
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
    headers: json(created.accessToken),
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

/** The browser leg Pages runs, against the real IdP — see org-signin-flow. */
async function mintOrgIdToken(idp: ReferenceIdp, origin: string) {
  const clientId = `origin:${origin}`;
  const redirectUri = `${origin}/opensesame/callback`;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${idp.issuer}/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorize.searchParams.set("code_challenge_method", "S256");
  const redirected = await fetch(authorize, { redirect: "manual" });
  expect(redirected.status).toBe(302);
  const code =
    new URL(redirected.headers.get("location") ?? "").searchParams.get(
      "code",
    ) ?? "";
  const tokens = await fetch(`${idp.issuer}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  expect(tokens.status).toBe(200);
  const idToken = overlapCast(await tokens.json()).id_token;
  if (!isString(idToken)) throw new Error("no id_token minted");
  const [, payload] = idToken.split(".");
  const claims = overlapCast(
    JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")),
  );
  const subject = claims.pairwise_sub ?? claims.sub;
  if (!isString(subject)) throw new Error("no subject in id_token");
  return { idToken, subject };
}

const PAGES_ORIGIN = "http://localhost:5180";
/** The reference IdP's seeded user, restored after a case varies it. */
const DEFAULT_IDP_SUBJECT = "mock-user-1";

let idp: ReferenceIdp;

beforeAll(async () => {
  idp = await startReferenceIdp();
}, 30_000);

afterAll(async () => {
  await idp.close();
});

async function seedTenant(app: App, slug: string) {
  const owner = await verified(app, `${slug}-owner`);
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: json(owner.accessToken),
    body: JSON.stringify({
      slug,
      displayName: `Org ${slug}`,
      ssoIssuer: idp.issuer,
    }),
  });
  expect(created.status).toBe(201);
  const org = overlapCast(await created.json());
  const enabled = await app.request(`/v1/organizations/${org.id}`, {
    method: "PATCH",
    headers: json(owner.accessToken),
    body: JSON.stringify({ provisioningEnabled: true }),
  });
  expect(enabled.status).toBe(200);
  return { owner, org };
}

async function mintScimToken(app: App, orgId: string, ownerToken: string) {
  const res = await app.request(`/v1/organizations/${orgId}/scim/tokens`, {
    method: "POST",
    headers: json(ownerToken),
  });
  expect(res.status).toBe(201);
  const body = overlapCast(await res.json());
  if (!isString(body.token)) throw new Error("no provisioning token minted");
  return { token: body.token, id: String(body.id) };
}

function scimHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function usersPath(orgId: string, suffix = ""): string {
  return `/v1/organizations/${orgId}/scim/v2/Users${suffix}`;
}

async function provisionUser(
  app: App,
  orgId: string,
  token: string,
  body: JsonObject,
) {
  const res = await app.request(usersPath(orgId), {
    method: "POST",
    headers: scimHeaders(token),
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      ...body,
    }),
  });
  return { status: res.status, body: overlapCast(await res.json()), res };
}

function joinTenant(app: App, slug: string, bearer: string, idToken: string) {
  return app.request(`/v1/organizations/tenants/${slug}/join`, {
    method: "POST",
    headers: json(bearer),
    body: JSON.stringify({ method: "sso", idToken }),
  });
}

describe("SCIM provisioning lifecycle", () => {
  it("admits a provisioned subject and refuses it once deactivated", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "acme");
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    const { idToken, subject } = await mintOrgIdToken(idp, PAGES_ORIGIN);

    // The directory pushes the joiner. No principal exists for them yet — and
    // none is created here.
    const created = await provisionUser(app, org.id, token, {
      userName: "ada@acme.example",
      externalId: subject,
      displayName: "Ada Lovelace",
    });
    expect(created.status).toBe(201);
    expect(created.body.active).toBe(true);
    // No principal, and no identity, exists for that subject yet: provisioning
    // records permission to join, it does not create anybody (D11).
    expect(
      await ctx.repos.externalIdentities.findByTuple({
        kind: "oidc",
        issuer: idp.issuer,
        subject,
      }),
    ).toBeNull();

    const guest = await provisional(app);
    const joined = await joinTenant(app, "acme", guest.accessToken, idToken);
    expect(joined.status).toBe(201);
    expect(
      await ctx.stores.organizationMemberships.find(org.id, guest.principalId),
    ).toBeTruthy();

    // The leaver signal.
    const deactivated = await app.request(
      usersPath(org.id, `/${created.body.id}`),
      {
        method: "PATCH",
        headers: scimHeaders(token),
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        }),
      },
    );
    expect(deactivated.status).toBe(200);
    expect(overlapCast(await deactivated.json()).active).toBe(false);

    // Membership gone, and the session it authorised with it.
    expect(
      await ctx.stores.organizationMemberships.find(org.id, guest.principalId),
    ).toBeUndefined();
    const stillSignedIn = await app.request("/v1/organizations", {
      headers: auth(guest.accessToken),
    });
    expect(stillSignedIn.status).toBe(401);
  }, 30_000);

  it("refuses a subject the directory deactivated before it ever signed in", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "leaver-org");
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    idp.setSubject("leaver");
    const { idToken, subject } = await mintOrgIdToken(idp, PAGES_ORIGIN);
    idp.setSubject(DEFAULT_IDP_SUBJECT);

    const created = await provisionUser(app, org.id, token, {
      userName: "leaver@acme.example",
      externalId: subject,
    });
    expect(created.status).toBe(201);
    const deactivated = await app.request(
      usersPath(org.id, `/${created.body.id}`),
      { method: "DELETE", headers: scimHeaders(token) },
    );
    expect(deactivated.status).toBe(204);

    // The assertion verifies and the subject binds to the caller — and the
    // tenant still refuses, because its directory says this person is gone.
    const guest = await provisional(app);
    const refused = await joinTenant(
      app,
      "leaver-org",
      guest.accessToken,
      idToken,
    );
    expect(refused.status).toBe(403);
    expect(overlapCast(await refused.json()).error).toBe("not_provisioned");
    expect(
      await ctx.stores.organizationMemberships.find(org.id, guest.principalId),
    ).toBeUndefined();
  }, 30_000);

  it("treats DELETE as deactivation, keeping the refusal durable", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "delete-org");
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    const created = await provisionUser(app, org.id, token, {
      userName: "grace@acme.example",
    });
    expect(created.status).toBe(201);

    const removed = await app.request(
      usersPath(org.id, `/${created.body.id}`),
      {
        method: "DELETE",
        headers: scimHeaders(token),
      },
    );
    expect(removed.status).toBe(204);

    // The row survives: it is the record that this subject must NOT be
    // admitted. Deleting it would silently re-open JIT-join.
    const stored = await ctx.stores.scim.users.getById(
      org.id,
      String(created.body.id),
    );
    expect(stored?.active).toBe(false);
    expect(
      await provisionedRoleForSubject(ctx, org.id, "grace@acme.example"),
    ).toBeUndefined();
  });
});

describe("SCIM provisioning-token custody", () => {
  it("shows the plaintext once and stores only its hash", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "custody");
    const { token, id } = await mintScimToken(app, org.id, owner.accessToken);

    expect(token.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);

    // The store answers to the digest, and only the digest.
    const digest = createHash("sha256").update(token).digest("hex");
    expect(await ctx.stores.scim.tokens.verify(org.id, digest)).toBe(true);
    expect(await ctx.stores.scim.tokens.verify(org.id, token)).toBe(false);

    // Nothing that lists tokens ever shows one again.
    const listed = await app.request(
      `/v1/organizations/${org.id}/scim/tokens`,
      {
        headers: auth(owner.accessToken),
      },
    );
    expect(listed.status).toBe(200);
    const listedBody = JSON.stringify(await listed.json());
    expect(listedBody).toContain(id);
    expect(listedBody).not.toContain(token);
    expect(
      JSON.stringify(await ctx.stores.scim.tokens.list(org.id)),
    ).not.toContain(token);

    // Neither does the audit trail — not the token, not a prefix of it.
    await provisionUser(app, org.id, token, {
      userName: "ada@custody.example",
    });
    const trail = JSON.stringify(
      await ctx.repos.auditEvents.list({ limit: 200 }),
    );
    expect(trail).toContain("organization.scim_token_minted");
    expect(trail).not.toContain(token);
    expect(trail).not.toContain(token.slice(SCIM_TOKEN_PREFIX.length, 24));
  });

  it("refuses a revoked token, and a token belonging to another tenant", async () => {
    const { app } = createControlPlane({ config: testConfig(idp.issuer) });
    const first = await seedTenant(app, "tenant-one");
    const second = await seedTenant(app, "tenant-two");
    const firstToken = await mintScimToken(
      app,
      first.org.id,
      first.owner.accessToken,
    );
    const secondToken = await mintScimToken(
      app,
      second.org.id,
      second.owner.accessToken,
    );

    // One tenant's token is not the other's, even though both are live.
    const crossed = await app.request(usersPath(second.org.id), {
      method: "POST",
      headers: scimHeaders(firstToken.token),
      body: JSON.stringify({ userName: "x@tenant-two.example" }),
    });
    expect(crossed.status).toBe(401);
    expect(overlapCast(await crossed.json()).schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);

    const revoked = await app.request(
      `/v1/organizations/${second.org.id}/scim/tokens/${secondToken.id}`,
      { method: "DELETE", headers: auth(second.owner.accessToken) },
    );
    expect(revoked.status).toBe(204);
    const afterRevocation = await app.request(usersPath(second.org.id), {
      headers: scimHeaders(secondToken.token),
    });
    expect(afterRevocation.status).toBe(401);
  });

  it("fences token management to the organization owner", async () => {
    const { app } = createControlPlane({ config: testConfig(idp.issuer) });
    const { org } = await seedTenant(app, "owner-only");
    const stranger = await verified(app, "stranger");

    const refused = await app.request(
      `/v1/organizations/${org.id}/scim/tokens`,
      { method: "POST", headers: json(stranger.accessToken) },
    );
    // 404, not 403: a stranger learns nothing about which tenants exist.
    expect(refused.status).toBe(404);

    const anonymous = await app.request(
      `/v1/organizations/${org.id}/scim/tokens`,
      { method: "POST" },
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("SCIM Users surface", () => {
  it("answers SCIM-shaped errors and the userName filter", async () => {
    const { app } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "users-org");
    const { token } = await mintScimToken(app, org.id, owner.accessToken);

    const unauthenticated = await app.request(usersPath(org.id), {
      headers: { "content-type": "application/json" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("content-type")).toContain(
      "application/scim+json",
    );
    expect(unauthenticated.headers.get("WWW-Authenticate")).toBe("Bearer");

    const created = await provisionUser(app, org.id, token, {
      userName: "ada@users.example",
      externalId: "ext-ada",
      // A real SCIM attribute and a real credential: it must not survive.
      password: "correct horse battery staple",
    });
    expect(created.status).toBe(201);
    expect(created.res.headers.get("location")).toContain(
      `/scim/v2/Users/${created.body.id}`,
    );
    expect(created.body.schemas).toEqual([
      "urn:ietf:params:scim:schemas:core:2.0:User",
    ]);
    expect(JSON.stringify(created.body)).not.toContain("correct horse");

    const duplicate = await provisionUser(app, org.id, token, {
      userName: "ada@users.example",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.scimType).toBe("uniqueness");

    const filtered = await app.request(
      `${usersPath(org.id)}?filter=${encodeURIComponent(
        'userName eq "ada@users.example"',
      )}`,
      { headers: scimHeaders(token) },
    );
    expect(filtered.status).toBe(200);
    const list = overlapCast(await filtered.json());
    expect(list.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:ListResponse",
    ]);
    expect(list.totalResults).toBe(1);

    const missing = await app.request(
      `${usersPath(org.id)}?filter=${encodeURIComponent(
        'userName eq "nobody@users.example"',
      )}`,
      { headers: scimHeaders(token) },
    );
    expect(overlapCast(await missing.json()).totalResults).toBe(0);

    const unsupported = await app.request(
      `${usersPath(org.id)}?filter=${encodeURIComponent('emails.value co "@"')}`,
      { headers: scimHeaders(token) },
    );
    expect(unsupported.status).toBe(400);
    expect(overlapCast(await unsupported.json()).scimType).toBe(
      "invalidFilter",
    );

    const byId = await app.request(usersPath(org.id, `/${created.body.id}`), {
      headers: scimHeaders(token),
    });
    expect(byId.status).toBe(200);
    expect(overlapCast(await byId.json()).userName).toBe("ada@users.example");

    const unknown = await app.request(usersPath(org.id, "/no-such-user"), {
      headers: scimHeaders(token),
    });
    expect(unknown.status).toBe(404);
  });

  it("reads Entra's stringly-typed active flag", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "entra-org");
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    const created = await provisionUser(app, org.id, token, {
      userName: "alan@entra.example",
    });

    const patched = await app.request(
      usersPath(org.id, `/${created.body.id}`),
      {
        method: "PATCH",
        headers: scimHeaders(token),
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "Replace", value: { active: "False" } }],
        }),
      },
    );
    expect(patched.status).toBe(200);
    expect(
      (await ctx.stores.scim.users.getById(org.id, String(created.body.id)))
        ?.active,
    ).toBe(false);
  });
});

describe("SCIM Groups role mapping", () => {
  it("maps a group name to an org role", () => {
    expect(roleForGroupName("Owners")).toBe("owner");
    expect(roleForGroupName("acme-admins")).toBe("admin");
    expect(roleForGroupName("OpenSesame Members")).toBe("member");
    expect(roleForGroupName("Engineering")).toBeUndefined();
  });

  it("moves an existing member to the mapped role, and back on removal", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "groups-org");
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    const { idToken, subject } = await mintOrgIdToken(idp, PAGES_ORIGIN);
    const created = await provisionUser(app, org.id, token, {
      userName: "ada@groups.example",
      externalId: subject,
    });

    const guest = await provisional(app);
    expect(
      (await joinTenant(app, "groups-org", guest.accessToken, idToken)).status,
    ).toBe(201);
    expect(
      (await ctx.stores.organizationMemberships.find(org.id, guest.principalId))
        ?.role,
    ).toBe("member");

    const promoted = await app.request(
      `/v1/organizations/${org.id}/scim/v2/Groups/${encodeURIComponent(
        "acme-owners",
      )}`,
      {
        method: "PATCH",
        headers: scimHeaders(token),
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [
            {
              op: "add",
              path: "members",
              value: [{ value: created.body.id }],
            },
          ],
        }),
      },
    );
    expect(promoted.status).toBe(200);
    expect(
      (await ctx.stores.organizationMemberships.find(org.id, guest.principalId))
        ?.role,
    ).toBe("owner");
    // Recorded on the row too, so a later sign-in can join at the same role.
    expect(await provisionedRoleForSubject(ctx, org.id, subject)).toBe("owner");

    const demoted = await app.request(
      `/v1/organizations/${org.id}/scim/v2/Groups/${encodeURIComponent(
        "acme-owners",
      )}`,
      {
        method: "PATCH",
        headers: scimHeaders(token),
        body: JSON.stringify({
          Operations: [
            {
              op: "remove",
              path: "members",
              value: [{ value: created.body.id }],
            },
          ],
        }),
      },
    );
    expect(demoted.status).toBe(200);
    expect(
      (await ctx.stores.organizationMemberships.find(org.id, guest.principalId))
        ?.role,
    ).toBe("member");
  }, 30_000);

  it("accepts and ignores a group that maps to nothing", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig(idp.issuer) });
    const { owner, org } = await seedTenant(app, "ignored-org");
    const { token } = await mintScimToken(app, org.id, owner.accessToken);
    const created = await provisionUser(app, org.id, token, {
      userName: "ada@ignored.example",
    });

    const res = await app.request(
      `/v1/organizations/${org.id}/scim/v2/Groups/engineering`,
      {
        method: "PATCH",
        headers: scimHeaders(token),
        body: JSON.stringify({
          Operations: [
            { op: "add", path: "members", value: [{ value: created.body.id }] },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(
      await provisionedRoleForSubject(ctx, org.id, "ada@ignored.example"),
    ).toBeUndefined();
  });
});
