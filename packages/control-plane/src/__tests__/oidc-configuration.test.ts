import { randomBytes } from "node:crypto";
import type { UpdateOrganizationRequest } from "@opensesame/contracts";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { approveFederationFixture } from "./approved-federation.test-support.js";

describe("organization OIDC credential configuration", () => {
  it("retains write-only secrets only for the issuer and client that received them", async () => {
    const { app, ctx } = createControlPlane();
    const created = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const session: { principalId: string; accessToken: string } =
      await created.json();
    const id = "org:oidc-config";
    const now = ctx.clock();
    await ctx.stores.organizations.set(id, {
      id,
      slug: "oidc-config",
      displayName: "OIDC configuration",
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
    const secret = randomBytes(24).toString("base64url");
    approveFederationFixture(ctx, {
      organizationId: id,
      ssoIssuer: "https://idp.example",
    });
    const first = await patch({
      ssoIssuer: "https://idp.example",
      ssoClientId: "client-a",
      ssoClientSecret: secret,
    });
    expect(first.status).toBe(200);
    expect(await first.text()).not.toContain(secret);
    expect((await patch({ displayName: "Renamed" })).status).toBe(200);
    expect((await ctx.stores.organizations.get(id))?.ssoClientSecret).toBe(
      secret,
    );
    expect((await patch({ ssoClientId: "client-b" })).status).toBe(200);
    expect(
      (await ctx.stores.organizations.get(id))?.ssoClientSecret,
    ).toBeUndefined();
    expect((await patch({ ssoClientSecret: secret })).status).toBe(200);
    approveFederationFixture(ctx, {
      organizationId: id,
      ssoIssuer: "https://other.example",
    });
    expect((await patch({ ssoIssuer: "https://other.example" })).status).toBe(
      200,
    );
    expect(
      (await ctx.stores.organizations.get(id))?.ssoClientSecret,
    ).toBeUndefined();
    approveFederationFixture(ctx, {
      organizationId: id,
      ssoIssuer: "https://third.example",
    });
    const replacement = randomBytes(24).toString("base64url");
    expect(
      (
        await patch({
          ssoIssuer: "https://third.example",
          ssoClientId: "client-c",
          ssoClientSecret: replacement,
        })
      ).status,
    ).toBe(200);
    expect((await ctx.stores.organizations.get(id))?.ssoClientSecret).toBe(
      replacement,
    );
  });
});
