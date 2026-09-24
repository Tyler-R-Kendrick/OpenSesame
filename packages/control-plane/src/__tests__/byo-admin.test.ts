import { randomUUID } from "node:crypto";
import type { ByoUpstream } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resolveTrustedIssuer } from "../interactions/trust.js";

/**
 * Operator lifecycle for bring-your-own upstreams (D14).
 *
 * The interesting assertion is not the 200: it is that disabling a record
 * actually withdraws it from the trust fence, so a disabled upstream stops
 * signing anybody in without being deleted.
 */

const OPERATOR_TOKEN = "test-operator-token";
const ADMIN_BASE = "/v1/federated/admin/byo-upstreams";

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
    operatorToken: OPERATOR_TOKEN,
    trustedUpstreamIssuers: ["https://idp.example"],
  } as const;
}

function operator(token = OPERATOR_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

function upstreamRecord(overrides: Partial<ByoUpstream> = {}): ByoUpstream {
  return {
    id: `byo_${randomUUID()}`,
    issuer: "https://keycloak.byo.example",
    label: "keycloak.byo.example",
    clientId: "byo-client",
    // Held verbatim because it must be presented upstream as issued — and
    // therefore must never come back out of an admin API.
    clientSecret: "byo-client-secret-value",
    clientAuth: "client_secret_post",
    registrationSource: "dcr",
    state: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("BYO upstream administration", () => {
  it("lists records without ever revealing a client secret", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const record = await ctx.repos.byoUpstreams.create(upstreamRecord());

    const res = await app.request(ADMIN_BASE, { headers: operator() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(record.id);
    expect(text).toContain(record.issuer);
    expect(text).not.toContain("byo-client-secret-value");
  });

  it("disables a record, withdrawing it from the trust fence", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const record = await ctx.repos.byoUpstreams.create(upstreamRecord());
    expect(await resolveTrustedIssuer(ctx, record.issuer)).toMatchObject({
      source: "byo",
    });

    const disabled = await app.request(`${ADMIN_BASE}/${record.id}/disable`, {
      method: "POST",
      headers: operator(),
    });
    expect(disabled.status).toBe(200);
    expect(overlapCast(await disabled.json()).state).toBe("disabled");
    expect(await resolveTrustedIssuer(ctx, record.issuer)).toBeUndefined();

    // Repeating an applied transition is not an error: durable state already
    // reflects it.
    const again = await app.request(`${ADMIN_BASE}/${record.id}/disable`, {
      method: "POST",
      headers: operator(),
    });
    expect(again.status).toBe(200);
    expect(overlapCast(await again.json()).state).toBe("disabled");

    const enabled = await app.request(`${ADMIN_BASE}/${record.id}/enable`, {
      method: "POST",
      headers: operator(),
    });
    expect(enabled.status).toBe(200);
    expect(overlapCast(await enabled.json()).state).toBe("active");
    expect(await resolveTrustedIssuer(ctx, record.issuer)).toMatchObject({
      source: "byo",
    });

    const trail = JSON.stringify(
      await ctx.repos.auditEvents.list({ limit: 100 }),
    );
    expect(trail).toContain("byo_upstream.disabled");
    expect(trail).toContain("byo_upstream.enabled");
    expect(trail).not.toContain("byo-client-secret-value");
  });

  it("answers 404 for an id it does not hold", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const res = await app.request(`${ADMIN_BASE}/byo_${randomUUID()}/disable`, {
      method: "POST",
      headers: operator(),
    });
    expect(res.status).toBe(404);
    expect(overlapCast(await res.json()).error).toBe("not_found");
  });

  it("is fenced to the operator token", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const record = await ctx.repos.byoUpstreams.create(upstreamRecord());

    for (const headers of [
      {},
      operator("wrong-token"),
      { authorization: "Basic dXNlcjpwYXNz" },
    ]) {
      expect((await app.request(ADMIN_BASE, { headers })).status).toBe(401);
      expect(
        (
          await app.request(`${ADMIN_BASE}/${record.id}/disable`, {
            method: "POST",
            headers,
          })
        ).status,
      ).toBe(401);
    }
    // Refused, therefore unchanged.
    expect((await ctx.repos.byoUpstreams.getById(record.id))?.state).toBe(
      "active",
    );
  });

  it("does not become an existence oracle for a principal's own session", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const record = await ctx.repos.byoUpstreams.create(upstreamRecord());
    const session = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const principal = overlapCast(await session.json());

    // A perfectly good principal bearer is not an operator token.
    const res = await app.request(`${ADMIN_BASE}/${record.id}/disable`, {
      method: "POST",
      headers: { authorization: `Bearer ${principal.accessToken}` },
    });
    expect(res.status).toBe(401);
    expect((await ctx.repos.byoUpstreams.getById(record.id))?.state).toBe(
      "active",
    );
  });
});
