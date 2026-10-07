import { randomUUID } from "node:crypto";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type Plane = ReturnType<typeof createControlPlane>;
type Headers = Record<string, string>;

function request<
  H extends Record<string, string>,
  B extends Record<string, BoundaryValue>,
>(plane: Plane, path: string, headers: H, method = "POST", body?: B) {
  const init: RequestInit = {
    method,
    headers: { ...headers, "content-type": "application/json" },
  };
  if (method !== "GET") init.body = JSON.stringify(body ?? {});
  return plane.app.request(path, init);
}

async function owner(plane: Plane, email: string) {
  const created = await plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(created.status).toBe(201);
  const session = overlapCast(await created.json());
  const headers = { authorization: `Bearer ${session.accessToken}` };
  const linked = await request(
    plane,
    "/v1/principals/link-identities",
    { ...headers, "idempotency-key": randomUUID() },
    "POST",
    {
      kind: "oidc",
      issuer: "https://mock.example",
      subject: randomUUID(),
      emailNormalized: email,
      emailVerified: true,
      assurance: "verified",
    },
  );
  expect(linked.status).toBe(201);
  return { headers, principalId: String(session.principalId) };
}

async function application(plane: Plane, headers: Headers) {
  const created = await request(
    plane,
    "/v1/authentication/applications",
    headers,
    "POST",
    {
      displayName: "Managed application",
      rpId: "localhost",
      origins: ["http://localhost:5180"],
    },
  );
  expect(created.status).toBe(201);
  const body = overlapCast(await created.json());
  return {
    id: String(overlapCast(body.application).id),
    secret: String(body.apiSecret),
    body,
  };
}

it("authorizes management by owner, rotates backend authority, and refuses suspended applications", async () => {
  const plane = createControlPlane();
  const human = await owner(plane, "owner@example.test");
  const foreign = await owner(plane, "foreign@example.test");
  const app = await application(plane, human.headers);
  const root = `/v1/authentication/applications/${app.id}`;
  expect(
    (
      await request(plane, root, foreign.headers, "PATCH", {
        displayName: "Stolen",
      })
    ).status,
  ).toBe(404);
  expect(
    (await request(plane, root, human.headers, "PATCH", { state: "invented" }))
      .status,
  ).toBe(400);
  const listed = await request(
    plane,
    "/v1/authentication/applications",
    human.headers,
    "GET",
  );
  expect(listed.status).toBe(200);
  const listing = overlapCast(await listed.json());
  expect(JSON.stringify(listing)).not.toContain(app.secret);
  expect(JSON.stringify(listing)).not.toContain("secretHash");
  const foreignList = await request(
    plane,
    "/v1/authentication/applications",
    foreign.headers,
    "GET",
  );
  expect(await foreignList.json()).toEqual({ applications: [] });
  const registration = {
    applicationId: app.id,
    userId: "managed-user",
    userName: "User",
    displayName: "User",
  };
  const backend = (secret: string) => ({ authorization: `Bearer ${secret}` });
  expect(
    (
      await request(
        plane,
        "/v1/authentication/backend/registration-tokens",
        backend(app.secret),
        "POST",
        registration,
      )
    ).status,
  ).toBe(201);
  const rotated = await request(plane, `${root}/rotate-secret`, human.headers);
  expect(rotated.status).toBe(200);
  const secret = String(overlapCast(await rotated.json()).apiSecret);
  expect(secret).not.toBe(app.secret);
  expect(
    (
      await request(
        plane,
        "/v1/authentication/backend/registration-tokens",
        backend(app.secret),
        "POST",
        registration,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await request(
        plane,
        "/v1/authentication/backend/registration-tokens",
        backend(secret),
        "POST",
        registration,
      )
    ).status,
  ).toBe(201);
  expect(
    (await request(plane, root, human.headers, "PATCH", { state: "suspended" }))
      .status,
  ).toBe(200);
  expect(
    (
      await request(
        plane,
        "/v1/authentication/backend/registration-tokens",
        backend(secret),
        "POST",
        registration,
      )
    ).status,
  ).toBe(401);
  expect(
    (await request(plane, root, human.headers, "PATCH", { state: "active" }))
      .status,
  ).toBe(200);
  expect(
    (
      await request(
        plane,
        "/v1/authentication/backend/registration-tokens",
        backend(secret),
        "POST",
        registration,
      )
    ).status,
  ).toBe(201);
});

it("requires a remaining active API key and refuses deletion until the selected key is locked", async () => {
  const plane = createControlPlane();
  const human = await owner(plane, "keys@example.test");
  const app = await application(plane, human.headers);
  const initial = overlapCast(overlapCast(app.body.application).apiKeys);
  const first = String(overlapCast(initial[0]).id);
  const root = `/v1/authentication/applications/${app.id}/api-keys`;
  expect(
    (
      await request(plane, `${root}/${first}`, human.headers, "PATCH", {
        state: "locked",
      })
    ).status,
  ).toBe(409);
  const created = await request(plane, root, human.headers);
  expect(created.status).toBe(201);
  const key = overlapCast(overlapCast(await created.json()).apiKey);
  const second = String(key.id);
  expect(
    (await request(plane, `${root}/${second}`, human.headers, "DELETE")).status,
  ).toBe(409);
  expect(
    (
      await request(plane, `${root}/missing`, human.headers, "PATCH", {
        state: "locked",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(plane, `${root}/${second}`, human.headers, "PATCH", {
        state: "locked",
      })
    ).status,
  ).toBe(200);
  expect(
    (await request(plane, `${root}/${second}`, human.headers, "DELETE")).status,
  ).toBe(200);
  expect(
    (await request(plane, `${root}/${second}`, human.headers, "DELETE")).status,
  ).toBe(404);
  const token = await request(
    plane,
    "/v1/authentication/backend/registration-tokens",
    { authorization: `Bearer ${key.secret}` },
    "POST",
    {
      applicationId: app.id,
      userId: "removed-key",
      userName: "User",
      displayName: "User",
    },
  );
  expect(token.status).toBe(401);
});

it("creates organization-owned applications only for an active organization administrator", async () => {
  const plane = createControlPlane();
  const human = await owner(plane, "organization@example.test");
  const outsider = await owner(plane, "outsider@example.test");
  const organization = await request(
    plane,
    "/v1/organizations",
    human.headers,
    "POST",
    { slug: `authority-${randomUUID()}`, displayName: "Authority workspace" },
  );
  expect(organization.status).toBe(201);
  const organizationId = String(overlapCast(await organization.json()).id);
  const body = {
    displayName: "Organization application",
    rpId: "localhost",
    origins: ["http://localhost:5180"],
    organizationId,
  };
  expect(
    (
      await request(
        plane,
        "/v1/authentication/applications",
        outsider.headers,
        "POST",
        body,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        plane,
        "/v1/authentication/applications",
        human.headers,
        "POST",
        { ...body, organizationId: "missing" },
      )
    ).status,
  ).toBe(403);
  const created = await request(
    plane,
    "/v1/authentication/applications",
    human.headers,
    "POST",
    body,
  );
  expect(created.status).toBe(201);
  const appId = String(
    overlapCast(overlapCast(await created.json()).application).id,
  );
  const listed = overlapCast(
    await (
      await request(
        plane,
        "/v1/authentication/applications",
        human.headers,
        "GET",
      )
    ).json(),
  );
  expect(JSON.stringify(listed)).toContain(appId);
});

it("rejects foreign registration revocation and revokes the owner's existing access and assertion authority", async () => {
  const plane = createControlPlane();
  const human = await owner(plane, "agent-owner@example.test");
  const foreign = await owner(plane, "agent-foreign@example.test");
  const registered = await request(plane, "/agent/identity", {}, "POST", {
    type: "anonymous",
  });
  expect(registered.status).toBe(200);
  const agent = overlapCast(await registered.json());
  const exchange = (assertion = String(agent.identity_assertion)) =>
    plane.app.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
  const access = await exchange();
  expect(access.status).toBe(200);
  const token = String(overlapCast(await access.json()).access_token);
  const started = await request(plane, "/agent/identity/claim", {}, "POST", {
    claim_token: agent.claim_token,
    email: "agent-owner@example.test",
  });
  expect(started.status).toBe(200);
  const attempt = overlapCast(overlapCast(await started.json()).claim_attempt);
  const returnTo = new URL(String(attempt.verification_uri)).searchParams.get(
    "return_to",
  );
  const attemptToken = new URL(
    returnTo ?? "",
    plane.ctx.config.publicUrl,
  ).searchParams.get("claim_attempt_token");
  expect(
    (
      await request(
        plane,
        "/agent/identity/claim/complete",
        human.headers,
        "POST",
        { claim_attempt_token: attemptToken, user_code: attempt.user_code },
      )
    ).status,
  ).toBe(200);
  const revoke = `/agent/identity/${agent.registration_id}/revoke`;
  expect((await request(plane, revoke, foreign.headers)).status).toBe(403);
  // Claimed grants are distinct from stale pre-claim tokens.
  const claimed = await plane.app.request("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:workos:agent-auth:grant-type:claim",
      claim_token: String(agent.claim_token),
    }),
  });
  expect(claimed.status).toBe(200);
  const grant = overlapCast(await claimed.json());
  const current = String(grant.access_token);
  const assertion = String(grant.identity_assertion);
  const resource = (accessToken: string) =>
    plane.app.request("/v1/agent-resources/demo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  expect((await resource(current)).status).toBe(200);
  expect((await exchange(assertion)).status).toBe(200);
  expect((await request(plane, revoke, human.headers)).status).toBe(200);
  for (const retired of [token, current]) {
    expect((await resource(retired)).status).toBe(401);
  }
  expect((await exchange(assertion)).status).toBe(400);
  const independent = await request(plane, "/agent/identity", {}, "POST", {
    type: "anonymous",
  });
  expect(independent.status).toBe(200);
  const renewed = await exchange(
    String(overlapCast(await independent.json()).identity_assertion),
  );
  expect(renewed.status).toBe(200);
  expect(
    (await resource(String(overlapCast(await renewed.json()).access_token)))
      .status,
  ).toBe(200);
  expect(
    (await request(plane, "/agent/identity/missing/revoke", human.headers))
      .status,
  ).toBe(200);
});
