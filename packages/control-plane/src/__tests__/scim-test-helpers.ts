import { createHash, randomBytes } from "node:crypto";
import type { ReferenceIdp } from "@opensesame/mock-upstream-idp/testkit";
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import type { createControlPlane } from "../create-app.js";

export type App = ReturnType<typeof createControlPlane>["app"];

export const PAGES_ORIGIN = "http://localhost:5180";
export const DEFAULT_IDP_SUBJECT = "mock-user-1";

export function testConfig(issuer: string) {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
    trustedUpstreamIssuers: [issuer],
  } as const;
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

export function json(token: string) {
  return { ...auth(token), "content-type": "application/json" };
}

function requireToken(body: JsonObject): string {
  const token = body.accessToken;
  if (!isString(token)) throw new Error("accessToken missing");
  return token;
}

export async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

export async function verified(app: App, subject: string) {
  const created = await provisional(app);
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: json(requireToken(created)),
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
export async function mintOrgIdToken(idp: ReferenceIdp, origin: string) {
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

export async function seedTenant(app: App, slug: string, idp: ReferenceIdp) {
  const owner = await verified(app, `${slug}-owner`);
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: json(requireToken(owner)),
    body: JSON.stringify({
      slug,
      displayName: `Org ${slug}`,
      ssoIssuer: idp.issuer,
    }),
  });
  expect(created.status).toBe(201);
  const org = overlapCast(await created.json());
  const orgId = overlapCast(org.id);
  if (!isString(orgId)) throw new Error("org.id missing");
  const enabled = await app.request(`/v1/organizations/${orgId}`, {
    method: "PATCH",
    headers: json(requireToken(owner)),
    body: JSON.stringify({ provisioningEnabled: true }),
  });
  expect(enabled.status).toBe(200);
  return { owner, org };
}

export async function mintScimToken(
  app: App,
  orgId: string,
  ownerToken: string,
) {
  const res = await app.request(`/v1/organizations/${orgId}/scim/tokens`, {
    method: "POST",
    headers: json(ownerToken),
  });
  expect(res.status).toBe(201);
  const body = overlapCast(await res.json());
  if (!isString(body.token)) throw new Error("no provisioning token minted");
  return { token: body.token, id: String(body.id) };
}

export function scimHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

export function usersPath(orgId: string, suffix = ""): string {
  return `/v1/organizations/${orgId}/scim/v2/Users${suffix}`;
}

export function groupsPath(orgId: string, groupId: string): string {
  return `/v1/organizations/${orgId}/scim/v2/Groups/${encodeURIComponent(groupId)}`;
}

export async function provisionUser(
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

export function joinTenant(
  app: App,
  slug: string,
  bearer: string,
  idToken: string,
) {
  return app.request(`/v1/organizations/tenants/${slug}/join`, {
    method: "POST",
    headers: json(bearer),
    body: JSON.stringify({ method: "sso", idToken }),
  });
}

export async function patchScim(
  app: App,
  path: string,
  token: string,
  operations: JsonObject[],
) {
  return app.request(path, {
    method: "PATCH",
    headers: scimHeaders(token),
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: operations,
    }),
  });
}
