import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
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

function clientBody(overrides: JsonObject = {}) {
  return {
    displayName: "RP",
    redirectUris: ["http://127.0.0.1:5173/callback"],
    sectorIdentifier: "https://rp.example",
    ...overrides,
  };
}

async function createClient(app: App, token: string, body: JsonObject) {
  return app.request("/v1/oauth/clients", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("oauth clients routes edge cases", () => {
  it("requires a verified identity for registration and mutation", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const anon = await provisional(app);

    const register = await createClient(app, anon.accessToken, clientBody());
    expect(register.status).toBe(403);
    expect(overlapCast(await register.json()).error).toBe("assurance_too_low");

    for (const [method, path] of [
      ["PATCH", "/v1/oauth/clients/cli_x"],
      ["POST", "/v1/oauth/clients/cli_x/rotate"],
      ["POST", "/v1/oauth/clients/cli_x/revoke"],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: {
          ...auth(anon.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    }
  });

  it("validates registration and gates admission modes and sectors", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "oauth-create-owner");

    expect((await createClient(app, owner.accessToken, {})).status).toBe(400);

    const gated = await createClient(
      app,
      owner.accessToken,
      clientBody({ admissionMode: "dynamic_registration" }),
    );
    expect(gated.status).toBe(400);
    expect(overlapCast(await gated.json()).error).toBe(
      "admission_mode_disabled",
    );

    expect(
      (await createClient(app, owner.accessToken, clientBody())).status,
    ).toBe(201);

    // Another owner may not claim the same sector identifier.
    const other = await verified(app, "oauth-create-other");
    const stolen = await createClient(app, other.accessToken, clientBody());
    expect(stolen.status).toBe(409);
    expect(overlapCast(await stolen.json()).error).toBe(
      "sector_identifier_taken",
    );

    // The same owner may reuse their own sector.
    expect(
      (
        await createClient(
          app,
          owner.accessToken,
          clientBody({ displayName: "RP Two" }),
        )
      ).status,
    ).toBe(201);

    const list = await app.request("/v1/oauth/clients", {
      headers: auth(owner.accessToken),
    });
    expect(overlapCast(await list.json()).clients).toHaveLength(2);
    const otherList = await app.request("/v1/oauth/clients", {
      headers: auth(other.accessToken),
    });
    expect(overlapCast(await otherList.json()).clients).toHaveLength(0);
  });

  it("patches only owned, live clients", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "oauth-patch-owner");
    const other = await verified(app, "oauth-patch-other");

    const created = await createClient(app, owner.accessToken, clientBody());
    const client = overlapCast(await created.json());

    const patch = (token: string, id: string, body: BoundaryValue) =>
      app.request(`/v1/oauth/clients/${id}`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await patch(owner.accessToken, "cli_missing", {})).status).toBe(
      404,
    );
    expect((await patch(other.accessToken, client.id, {})).status).toBe(404);
    expect(
      (await patch(owner.accessToken, client.id, { displayName: "" })).status,
    ).toBe(400);

    const updated = await patch(owner.accessToken, client.id, {
      displayName: "Renamed RP",
      redirectUris: ["http://127.0.0.1:5173/other-callback"],
      allowedScopes: ["openid", "profile"],
      allowedResources: ["https://api.example"],
      state: "suspended",
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      displayName: "Renamed RP",
      redirectUris: ["http://127.0.0.1:5173/other-callback"],
      allowedScopes: ["openid", "profile"],
      allowedResources: ["https://api.example"],
      state: "suspended",
    });
  });

  it("rotates a client, retiring the old registration", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "oauth-rotate-owner");

    expect(
      (
        await app.request("/v1/oauth/clients/cli_missing/rotate", {
          method: "POST",
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);

    const created = await createClient(app, owner.accessToken, clientBody());
    const client = overlapCast(await created.json());

    const rotated = await app.request(`/v1/oauth/clients/${client.id}/rotate`, {
      method: "POST",
      headers: auth(owner.accessToken),
    });
    expect(rotated.status).toBe(201);
    const next = overlapCast(await rotated.json());
    expect(next.id).not.toBe(client.id);
    expect(next.state).toBe("active");

    // The retired id is no longer patchable, and it no longer lists.
    expect(
      (
        await app.request(`/v1/oauth/clients/${client.id}`, {
          method: "PATCH",
          headers: {
            ...auth(owner.accessToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({ displayName: "Zombie" }),
        })
      ).status,
    ).toBe(404);
    const list = await app.request("/v1/oauth/clients", {
      headers: auth(owner.accessToken),
    });
    const ids = overlapCast(await list.json()).clients.map((c) => c.id);
    expect(ids).toEqual([next.id]);
  });

  it("revokes a client, idempotently", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "oauth-revoke-owner");

    expect(
      (
        await app.request("/v1/oauth/clients/cli_missing/revoke", {
          method: "POST",
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);

    const created = await createClient(app, owner.accessToken, clientBody());
    const client = overlapCast(await created.json());

    const revoked = await app.request(`/v1/oauth/clients/${client.id}/revoke`, {
      method: "POST",
      headers: auth(owner.accessToken),
    });
    expect(revoked.status).toBe(200);
    expect(overlapCast(await revoked.json()).state).toBe("revoked");

    // Revoking again is still the owner's own client, not a 404.
    const again = await app.request(`/v1/oauth/clients/${client.id}/revoke`, {
      method: "POST",
      headers: auth(owner.accessToken),
    });
    expect(again.status).toBe(200);

    // A revoked client frees its sector for its owner.
    expect(
      (await createClient(app, owner.accessToken, clientBody())).status,
    ).toBe(201);
  });
});
