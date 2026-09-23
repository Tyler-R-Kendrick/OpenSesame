import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type App = ReturnType<typeof createControlPlane>["app"];

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

async function verified(app: App, subject: string) {
  const minted = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const body = overlapCast(await minted.json());
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${body.accessToken}`,
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
  return body;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createClient(app: App, token: string, name: string) {
  const res = await app.request("/v1/oauth/clients", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({
      displayName: name,
      redirectUris: [`https://${name.replace(/\s+/g, "")}.example/cb`],
      sectorIdentifier: `https://${name.replace(/\s+/g, "")}.example`,
    }),
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

describe("ADV-23 scoped application administration", () => {
  it("denies another app, owner self-assignment, tenant user list, and public client_credentials", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "adv23-owner");
    const other = await verified(app, "adv23-other");
    const client = await createClient(app, owner.accessToken, "App A");
    await createClient(app, other.accessToken, "App B");

    const patchOther = await app.request(`/v1/oauth/clients/${client.id}`, {
      method: "PATCH",
      headers: {
        ...auth(other.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "Stolen" }),
    });
    expect(patchOther.status).toBe(404);

    const stealOwner = await app.request(`/v1/oauth/clients/${client.id}`, {
      method: "PATCH",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ownerPrincipalId: other.principalId }),
    });
    expect(stealOwner.status).toBe(400);

    const claimsOther = await app.request(
      `/v1/oauth/clients/${client.id}/claims`,
      { headers: auth(other.accessToken) },
    );
    expect(claimsOther.status).toBe(404);

    const org = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "adv23-org", displayName: "ADV23" }),
    });
    expect(org.status).toBe(201);
    const orgBody = overlapCast(await org.json());
    const members = await app.request(
      `/v1/organizations/${orgBody.id}/members`,
      { headers: auth(other.accessToken) },
    );
    expect(members.status).toBe(404);

    const publicCc = await app.request("/v1/oauth/clients", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Public CC",
        redirectUris: ["https://publiccc.example/cb"],
        sectorIdentifier: "https://publiccc.example",
        grantTypes: ["client_credentials"],
        tokenEndpointAuthMethod: "none",
      }),
    });
    expect(publicCc.status).toBe(400);

    const confidential = await app.request("/v1/oauth/clients", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Workload",
        redirectUris: ["https://workload.example/cb"],
        sectorIdentifier: "https://workload.example",
        grantTypes: ["client_credentials"],
        tokenEndpointAuthMethod: "private_key_jwt",
      }),
    });
    expect(confidential.status).toBe(400);
  });
});
