import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type Plane = ReturnType<typeof createControlPlane>;
type Claim = { claimId: string; claimToken: string; userCode: string };
const manifest = {
  kind: "secret-drop",
  ciphertext: "encrypted",
  nonce: "nonce",
};

function plane(clock?: () => Date): Plane {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
    clock: clock ?? (() => new Date()),
  });
}

async function create(cp: Plane, targetManifest = manifest): Promise<Claim> {
  const owner = await cp.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(owner.status).toBe(201);
  const token = overlapCast(await owner.json()).accessToken;
  const response = await cp.app.request("/v1/claims", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "resource_bundle",
      targetManifest,
      ttlSeconds: 60,
    }),
  });
  expect(response.status).toBe(201);
  return overlapCast(await response.json());
}

function present(cp: Plane, body: BoundaryValue): Promise<Response> {
  return cp.app.request("/v1/claims/present", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("secret-drop code enforcement at the public API", () => {
  it("requires the separate code even when a custom client omits it", async () => {
    const cp = plane();
    const claim = await create(cp);
    const missing = await present(cp, { token: claim.claimToken });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "invalid_user_code" });
    expect((await cp.ctx.claims.get(claim.claimId))?.state).toBe("pending");
    const valid = await present(cp, {
      token: claim.claimToken,
      userCode: claim.userCode,
    });
    expect(valid.status).toBe(200);
    expect(overlapCast(await valid.json()).targetManifest).toEqual(manifest);
  });

  it("retains token-only presentation for other claim ceremonies", async () => {
    const cp = plane();
    const claim = await create(cp, { ...manifest, kind: "public-description" });
    expect((await present(cp, { token: claim.claimToken })).status).toBe(200);
  });

  it("rejects malformed code fields without releasing or spending a drop", async () => {
    const cp = plane();
    const claim = await create(cp);
    for (const userCode of [null, "", 42, {}, "x".repeat(65)]) {
      const denied = await present(cp, { token: claim.claimToken, userCode });
      expect(denied.status).toBe(400);
      expect(overlapCast(await denied.json()).targetManifest).toBeUndefined();
    }
    expect(
      (await present(cp, { token: claim.claimToken, userCode: claim.userCode }))
        .status,
    ).toBe(200);
  });

  it("checks the bearer before allowing guesses or charging another claim's budget", async () => {
    const cp = plane();
    const claim = await create(cp);
    for (let i = 0; i < 8; i++) {
      const denied = await present(cp, {
        token: `osc_clm_${claim.claimId}.invalid-secret`,
        userCode: "WRONG-CODE",
      });
      expect(denied.status).toBe(401);
      expect(overlapCast(await denied.json()).targetManifest).toBeUndefined();
    }
    expect(
      await cp.ctx.stores.claimApprovalAttempts.get(claim.claimId),
    ).toBeUndefined();
    expect(
      (await present(cp, { token: claim.claimToken, userCode: claim.userCode }))
        .status,
    ).toBe(200);
  });

  it("reserves only five guesses under concurrency, and omission cannot bypass exhaustion", async () => {
    const cp = plane();
    const claim = await create(cp);
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        present(cp, {
          token: claim.claimToken,
          userCode: "WRONG-CODE",
        }),
      ),
    );
    expect(results.filter((response) => response.status === 401)).toHaveLength(
      5,
    );
    expect(results.filter((response) => response.status === 429)).toHaveLength(
      11,
    );
    for (const body of [
      { token: claim.claimToken },
      { token: claim.claimToken, userCode: claim.userCode },
    ]) {
      const denied = await present(cp, body);
      expect(denied.status).toBe(429);
      expect(overlapCast(await denied.json()).targetManifest).toBeUndefined();
    }
    expect((await cp.ctx.claims.get(claim.claimId))?.state).toBe("pending");
  });

  it("releases the manifest exactly once under concurrent correct-code requests", async () => {
    const cp = plane();
    const claim = await create(cp);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        present(cp, {
          token: claim.claimToken,
          userCode: claim.userCode,
        }),
      ),
    );
    expect(results.filter((response) => response.status === 200)).toHaveLength(
      1,
    );
    for (const response of results) {
      const body = overlapCast(await response.json());
      if (response.status === 200)
        expect(body.targetManifest).toEqual(manifest);
      else expect(body.targetManifest).toBeUndefined();
    }
  });

  it("does not accept one claim's code for another or expose expired payloads", async () => {
    let now = new Date("2026-10-30T12:00:00Z");
    const cp = plane(() => now);
    const first = await create(cp);
    const second = await create(cp);
    expect(
      (
        await present(cp, {
          token: second.claimToken,
          userCode: first.userCode,
        })
      ).status,
    ).toBe(401);
    now = new Date(now.getTime() + 60_001);
    const expired = await present(cp, {
      token: first.claimToken,
      userCode: first.userCode,
    });
    expect(expired.status).toBe(404);
    expect(overlapCast(await expired.json()).targetManifest).toBeUndefined();
  });
});
