import type { UpdateOrganizationRequest } from "@opensesame/contracts";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

describe("native SAML entity configuration fences", () => {
  it("accepts a native URN while preserving broker, metadata and deployment claim guards", async () => {
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        allowDevDefaults: false,
      },
    });
    const created = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const session: { principalId: string; accessToken: string } =
      await created.json();
    const id = "org:saml-config";
    const now = ctx.clock();
    await ctx.stores.organizations.set(id, {
      id,
      slug: "saml-config",
      displayName: "SAML configuration",
      state: "active",
      createdBy: session.principalId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.stores.organizationMemberships.upsert({
      organizationId: id,
      principalId: session.principalId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    const headers = {
      authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json",
    };
    const patch = (body: UpdateOrganizationRequest) =>
      app.request(`/v1/organizations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
    const native = {
      samlIssuer: "urn:example:idp:acme",
      samlMetadataUrl: "https://idp.example/metadata",
      samlMetadataXml: null,
    };
    ctx.config.organizationIssuerAllowlist = [
      ...(ctx.config.organizationIssuerAllowlist ?? []),
      `${id}|${native.samlIssuer}`,
    ];
    expect((await patch(native)).status).toBe(200);
    expect((await ctx.stores.organizations.get(id))?.samlIssuer).toBe(
      native.samlIssuer,
    );
    expect((await patch({ samlMetadataUrl: null })).status).toBe(400);
    expect((await patch({ samlIssuer: "http://127.0.0.1:8788" })).status).toBe(
      400,
    );
    expect(
      (await patch({ samlMetadataUrl: "https://169.254.169.254/metadata" }))
        .status,
    ).toBe(400);
    expect(
      (
        await patch({
          samlIssuer: "https://169.254.169.254",
          samlMetadataUrl: null,
        })
      ).status,
    ).toBe(400);
    expect((await ctx.stores.organizations.get(id))?.samlIssuer).toBe(
      native.samlIssuer,
    );
    const denied = await app.request(
      `/v1/organizations/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(native),
      },
    );
    expect(denied.status).toBe(401);
  });
});
