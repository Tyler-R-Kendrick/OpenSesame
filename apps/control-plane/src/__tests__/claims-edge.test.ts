import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { type JsonObject, overlapCast, type BoundaryValue } from "@opensesame/os-domain";

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

async function createClaim(app: App, accessToken: string, body: BoundaryValue) {
  const res = await app.request("/v1/claims", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function createDeviceClaim(app: App, accessToken: string) {
  const res = await createClaim(app, accessToken, {
    type: "device",
    targetManifest: { deviceId: "dev_1" },
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

describe("claims routes edge cases", () => {
  it("creates a claim directly and reads it with a Bearer claim token", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const claim = await createDeviceClaim(app, owner.accessToken);

    const byBearer = await app.request(`/v1/claims/${claim.claimId}`, {
      headers: { authorization: `Bearer ${claim.claimToken}` },
    });
    expect(byBearer.status).toBe(200);
    expect((overlapCast(await byBearer.json())).id).toBe(claim.claimId);
  });

  it("rejects claim reads with malformed or mismatched tokens", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const claim = await createDeviceClaim(app, owner.accessToken);

    // Well-formed prefix but no `<id>.<secret>` structure.
    const unparsable = await app.request(`/v1/claims/${claim.claimId}`, {
      headers: { "x-claim-token": "osc_clm_noseparator" },
    });
    expect(unparsable.status).toBe(401);

    // Parses, but names a different claim.
    const mismatch = await app.request(`/v1/claims/${claim.claimId}`, {
      headers: { "x-claim-token": "osc_clm_clm_other.secret" },
    });
    expect(mismatch.status).toBe(401);

    // Names this claim but the secret is wrong.
    const wrongSecret = await app.request(`/v1/claims/${claim.claimId}`, {
      headers: { "x-claim-token": `osc_clm_${claim.claimId}.wrongsecret` },
    });
    expect(wrongSecret.status).toBe(401);

    // Names a claim that does not exist at all.
    const unknown = await app.request("/v1/claims/clm_missing", {
      headers: { "x-claim-token": "osc_clm_clm_missing.secret" },
    });
    expect(unknown.status).toBe(401);
  });

  it("validates create bodies and enforces the live-claims quota", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);

    const invalid = await createClaim(app, owner.accessToken, {
      type: "not-a-type",
    });
    expect(invalid.status).toBe(400);
    expect((overlapCast(await invalid.json())).error).toBe(
      "validation_error",
    );

    // Provisional principals hold at most 8 live claims.
    for (let i = 0; i < 8; i += 1) {
      expect(
        (await createDeviceClaim(app, owner.accessToken)).claimId,
      ).toBeTruthy();
    }
    const overQuota = await createClaim(app, owner.accessToken, {
      type: "device",
      targetManifest: {},
    });
    expect(overQuota.status).toBe(403);
    expect(
      (overlapCast(await overQuota.json())).reasons,
    ).toContain("quota_claims");
  });

  it("an expired claim no longer counts against the live-claims quota", async () => {
    let now = new Date("2026-08-08T10:00:00Z");
    const { app } = createControlPlane({
      config: testConfig(),
      clock: () => now,
    });
    const owner = await provisional(app);

    for (let i = 0; i < 8; i += 1) {
      const res = await createClaim(app, owner.accessToken, {
        type: "device",
        targetManifest: {},
        ttlSeconds: 60,
      });
      expect(res.status).toBe(201);
    }
    // All eight lapse; the slots must come back.
    now = new Date(now.getTime() + 120_000);
    const after = await createClaim(app, owner.accessToken, {
      type: "device",
      targetManifest: {},
    });
    expect(after.status).toBe(201);
  });

  it("present validates input and maps domain errors to statuses", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const claim = await createDeviceClaim(app, owner.accessToken);

    const tooShort = await app.request("/v1/claims/present", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "short" }),
    });
    expect(tooShort.status).toBe(400);

    const invalidClaim = await app.request("/v1/claims/present", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-claim-token-at-all" }),
    });
    expect(invalidClaim.status).toBe(401);
    expect((overlapCast(await invalidClaim.json())).error).toBe(
      "invalid_token",
    );

    const unknown = await app.request("/v1/claims/present", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "osc_clm_clm_missing.somesecret" }),
    });
    expect(unknown.status).toBe(404);

    const wrongSecret = await app.request("/v1/claims/present", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: `osc_clm_${claim.claimId}.wrongsecret` }),
    });
    expect(wrongSecret.status).toBe(401);
  });

  it("complete fences bad user codes and refuses an unpresented claim", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const auth = { authorization: `Bearer ${owner.accessToken}` };
    const claim = await createDeviceClaim(app, owner.accessToken);

    const invalidBody = await app.request(
      `/v1/claims/${claim.claimId}/complete`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ acceptedItemIds: [] }),
      },
    );
    expect(invalidBody.status).toBe(400);

    const unknown = await app.request("/v1/claims/clm_missing/complete", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ acceptedItemIds: [], userCode: "AAAA-BBBB" }),
    });
    expect(unknown.status).toBe(404);

    const attempt = (userCode: string, extra: JsonObject = {}) =>
      app.request(`/v1/claims/${claim.claimId}/complete`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ acceptedItemIds: [], userCode, ...extra }),
      });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt("0000-0000")).status).toBe(401);
    }
    // The sixth try is refused outright, even with the right code.
    expect((await attempt(claim.userCode)).status).toBe(429);
  });

  it("complete rejects a mismatched claim token and an unpresented claim", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const auth = { authorization: `Bearer ${owner.accessToken}` };
    const claim = await createDeviceClaim(app, owner.accessToken);

    const badToken = await app.request(`/v1/claims/${claim.claimId}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        acceptedItemIds: [],
        userCode: claim.userCode,
        claimToken: "osc_clm_clm_other.secret",
      }),
    });
    expect(badToken.status).toBe(401);
    expect((overlapCast(await badToken.json())).error).toBe(
      "invalid_claim_token",
    );

    // Consent first: a claim nobody presented cannot be completed.
    const pending = await app.request(`/v1/claims/${claim.claimId}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        acceptedItemIds: [],
        userCode: claim.userCode,
        claimToken: claim.claimToken,
      }),
    });
    expect(pending.status).toBe(422);
    expect((overlapCast(await pending.json())).error).toBe(
      "INVALID_TRANSITION",
    );
  });

  it("completes a presented claim, then maps replay to a domain error", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const auth = { authorization: `Bearer ${owner.accessToken}` };
    const claim = await createDeviceClaim(app, owner.accessToken);

    const present = await app.request("/v1/claims/present", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: claim.claimToken }),
    });
    expect(present.status).toBe(200);

    const complete = await app.request(`/v1/claims/${claim.claimId}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        acceptedItemIds: [],
        userCode: claim.userCode,
        destination: { kind: "vault" },
        idempotencyKey: "complete-key-1",
      }),
    });
    expect(complete.status).toBe(200);
    const done = overlapCast(await complete.json());
    expect(done.state).toBe("completed");
    expect(done.won).toBe(true);

    // A second completion is not a fresh consent.
    const replay = await app.request(`/v1/claims/${claim.claimId}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ acceptedItemIds: [], userCode: claim.userCode }),
    });
    expect([409, 422]).toContain(replay.status);

    // Completed claims poll clean.
    const poll = await app.request(`/v1/claims/${claim.claimId}/poll`, {
      headers: { "x-claim-token": claim.claimToken },
    });
    expect(poll.status).toBe(200);
    expect((overlapCast(await poll.json())).status).toBe(
      "completed",
    );
  });

  it("deny requires the creator and ends polling with access_denied", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const other = await provisional(app);
    const claim = await createDeviceClaim(app, owner.accessToken);

    const unknown = await app.request("/v1/claims/clm_missing/deny", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(unknown.status).toBe(404);

    const foreign = await app.request(`/v1/claims/${claim.claimId}/deny`, {
      method: "POST",
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(foreign.status).toBe(403);

    // Denial is a review verdict: only a reviewed claim can be denied.
    const pendingDeny = await app.request(`/v1/claims/${claim.claimId}/deny`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(pendingDeny.status).toBe(422);

    await app.request("/v1/claims/present", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: claim.claimToken }),
    });
    await ctx.claims.authenticateClaim(claim.claimId);
    await ctx.claims.reviewClaim(claim.claimId, { acceptedItemIds: [] });

    const denied = await app.request(`/v1/claims/${claim.claimId}/deny`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(denied.status).toBe(200);
    expect((overlapCast(await denied.json())).state).toBe("denied");

    const poll = await app.request(`/v1/claims/${claim.claimId}/poll`, {
      headers: { "x-claim-token": claim.claimToken },
    });
    expect(poll.status).toBe(400);
    expect((overlapCast(await poll.json())).error).toBe(
      "access_denied",
    );

    // Denial is terminal.
    const again = await app.request(`/v1/claims/${claim.claimId}/deny`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect([409, 422]).toContain(again.status);
  });

  it("polls a pending claim as authorization_pending", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const claim = await createDeviceClaim(app, owner.accessToken);

    const poll = await app.request(`/v1/claims/${claim.claimId}/poll`, {
      headers: { "x-claim-token": claim.claimToken },
    });
    expect(poll.status).toBe(400);
    const body = overlapCast(await poll.json());
    expect(body.status).toBe("pending");
    expect(body.error).toBe("authorization_pending");
  });

  it("completing an agent claim flips the agent to claimed", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const auth = { authorization: `Bearer ${owner.accessToken}` };

    const registered = await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "claimable-agent",
        publicKeyJkt: "jkt-claimable",
      }),
    });
    expect(registered.status).toBe(201);
    const agent = overlapCast(await registered.json());

    await app.request("/v1/claims/present", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: agent.claimToken }),
    });
    const complete = await app.request(`/v1/claims/${agent.claimId}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        acceptedItemIds: [],
        userCode: agent.userCode,
      }),
    });
    expect(complete.status).toBe(200);
    const body = overlapCast(await complete.json());
    expect(body.preserved.agentId).toBe(agent.agentId);
    expect(ctx.stores.agents.get(agent.agentId)?.state).toBe("claimed");
  });
});
