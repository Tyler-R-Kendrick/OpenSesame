import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type Plane = ReturnType<typeof createControlPlane>;
type Claim = { claimId: string; claimToken: string; userCode: string };

function plane(): Plane {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  });
}

async function actor(cp: Plane): Promise<string> {
  const response = await cp.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(response.status).toBe(201);
  return overlapCast(await response.json()).accessToken;
}

async function create(cp: Plane, kind = "secret-drop"): Promise<Claim> {
  const token = await actor(cp);
  const response = await cp.app.request("/v1/claims", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "resource_bundle",
      targetManifest: { kind, ciphertext: "fixture" },
      ttlSeconds: 60,
    }),
  });
  expect(response.status).toBe(201);
  return overlapCast(await response.json());
}

function complete(
  cp: Plane,
  principalToken: string,
  claim: Claim,
  extra: JsonObject = {},
  headerToken?: string,
) {
  const headers = new Headers({
    authorization: `Bearer ${principalToken}`,
    "content-type": "application/json",
  });
  if (headerToken) headers.set("x-claim-token", headerToken);
  return cp.app.request(`/v1/claims/${claim.claimId}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      acceptedItemIds: [],
      userCode: claim.userCode,
      ...extra,
    }),
  });
}

function present(cp: Plane, claim: Claim, code = claim.userCode) {
  return cp.app.request("/v1/claims/present", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: claim.claimToken, userCode: code }),
  });
}

describe("secret-drop completion requires its bearer before the shared code budget", () => {
  it.each(["omitted", "wrong", "cross-claim"])(
    "refuses %s bearer guesses from an unrelated principal without draining the drop",
    async (mode) => {
      const cp = plane();
      const claim = await create(cp);
      const other = await create(cp);
      const principal = await actor(cp);
      const extra =
        mode === "omitted"
          ? {}
          : {
              claimToken:
                mode === "wrong"
                  ? `osc_clm_${claim.claimId}.wrong-secret`
                  : other.claimToken,
            };
      for (let i = 0; i < 8; i++) {
        const denied = await complete(cp, principal, claim, {
          ...extra,
          userCode: "WRONG-CODE",
        });
        expect(denied.status).toBe(401);
        expect(await denied.json()).toEqual({ error: "invalid_claim_token" });
      }
      expect(
        await cp.ctx.stores.claimApprovalAttempts.get(claim.claimId),
      ).toBeUndefined();
      expect((await cp.ctx.claims.get(claim.claimId))?.state).toBe("pending");
      expect((await present(cp, claim)).status).toBe(200);
    },
  );

  it("an invalid bearer and valid code cannot refund earlier failed guesses", async () => {
    const cp = plane();
    const claim = await create(cp);
    const principal = await actor(cp);
    for (let i = 0; i < 4; i++)
      expect((await present(cp, claim, "WRONG-CODE")).status).toBe(401);
    const denied = await complete(cp, principal, claim, {
      claimToken: `osc_clm_${claim.claimId}.wrong-secret`,
    });
    expect(denied.status).toBe(401);
    expect(await cp.ctx.stores.claimApprovalAttempts.get(claim.claimId)).toBe(
      4,
    );
    expect((await present(cp, claim)).status).toBe(200);
  });

  it.each(["body", "header"])(
    "completes a legitimately presented drop with its %s bearer",
    async (location) => {
      const cp = plane();
      const claim = await create(cp);
      const principal = await actor(cp);
      expect((await present(cp, claim)).status).toBe(200);
      const response = await complete(
        cp,
        principal,
        claim,
        location === "body" ? { claimToken: claim.claimToken } : {},
        location === "header" ? claim.claimToken : undefined,
      );
      expect(response.status).toBe(200);
      const body = overlapCast(await response.json());
      expect(body.state).toBe("completed");
      expect(body.targetManifest).toBeUndefined();
    },
  );

  it("valid bearer completion guesses share the presentation fence", async () => {
    const cp = plane();
    const claim = await create(cp);
    const principal = await actor(cp);
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await complete(cp, principal, claim, {
            claimToken: claim.claimToken,
            userCode: "WRONG-CODE",
          })
        ).status,
      ).toBe(401);
    }
    expect((await present(cp, claim)).status).toBe(429);
  });

  it("preserves code-only completion for other claim ceremonies", async () => {
    const cp = plane();
    const claim = await create(cp, "public-description");
    const principal = await actor(cp);
    expect((await present(cp, claim)).status).toBe(200);
    expect((await complete(cp, principal, claim)).status).toBe(200);
  });
});
