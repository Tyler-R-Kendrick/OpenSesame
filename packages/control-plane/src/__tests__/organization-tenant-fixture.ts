import { overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import type { createControlPlane } from "../create-app.js";

type App = ReturnType<typeof createControlPlane>["app"];

export const operatorApprovals: string[] = [];

export function testConfig() {
  return {
    organizationIssuerAllowlist: operatorApprovals,
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

export async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  const session: { principalId: string; accessToken: string } =
    await res.json();
  return session;
}

export async function verified(app: App, subject: string) {
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

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

export async function seedOrg(app: App) {
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
    }),
  });
  expect(created.status).toBe(201);
  const org = overlapCast(await created.json());
  operatorApprovals.push(
    `${org.id}|http://127.0.0.1:9090`,
    `${org.id}|http://127.0.0.1:8080/realms/acme`,
    `${org.id}|https://idp.example`,
  );
  const configured = await app.request(`/v1/organizations/${org.id}`, {
    method: "PATCH",
    headers: {
      ...auth(owner.accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ssoIssuer: "http://127.0.0.1:9090",
      samlIssuer: "http://127.0.0.1:8080/realms/acme",
    }),
  });
  expect(configured.status).toBe(200);
  return overlapCast(await configured.json());
}
