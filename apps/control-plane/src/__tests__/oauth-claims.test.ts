import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

async function verified(
  app: ReturnType<typeof createControlPlane>["app"],
  subject: string,
) {
  const minted = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const body = overlapCast(await minted.json());
  expect(
    (
      await app.request("/v1/principals/link-identities", {
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
      })
    ).status,
  ).toBe(201);
  return body;
}

describe("hosted claim mapping adapter", () => {
  it("wires findAccount lookup so missing ids issue no account", async () => {
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const findAccount = ctx.oauth.configuration.findAccount;
    await expect(findAccount?.({}, "does-not-exist")).resolves.toBeUndefined();
    const owner = await verified(app, "lookup-owner");
    const account = overlapCast(await findAccount?.({}, owner.principalId));
    expect(account.accountId).toBe(owner.principalId);
    await expect(account.claims("id_token", "openid")).resolves.toEqual({
      sub: owner.principalId,
    });
  });

  it("previews unsigned claims from the issuance projector and refuses reserved overrides", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const owner = await verified(app, "claims-owner");
    const created = await app.request("/v1/oauth/clients", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Claims RP",
        redirectUris: ["https://rp.example/cb"],
        sectorIdentifier: "https://claimsrp.example",
      }),
    });
    const client = overlapCast(await created.json());
    const reserved = await app.request(
      `/v1/oauth/clients/${client.id}/claims`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ claims: { sub: "spoofed" } }),
      },
    );
    expect(reserved.status).toBe(400);
    const mapping = await app.request(`/v1/oauth/clients/${client.id}/claims`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ allow: ["name", "email"] }),
    });
    expect(mapping.status).toBe(200);
    const preview = await app.request(
      `/v1/oauth/clients/${client.id}/claim-preview`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scopes: ["openid", "profile", "email"],
          persona: {
            name: "Ada",
            email: "ada@example.test",
            emailVerified: true,
            emailAuthoritative: true,
          },
        }),
      },
    );
    expect(preview.status).toBe(200);
    const body = overlapCast(await preview.json());
    expect(body.signed).toBe(false);
    expect(overlapCast(body.claims).sub).toBe("synthetic-preview-sub");
    expect(overlapCast(body.claims).name).toBe("Ada");
    expect(body.claims).not.toHaveProperty("access_token");
  });
});
