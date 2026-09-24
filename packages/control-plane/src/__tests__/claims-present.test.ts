import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type App = ReturnType<typeof createControlPlane>["app"];

interface CreatedClaim {
  claimId: string;
  claimToken: string;
  userCode: string;
}

const DROP_MANIFEST = {
  kind: "secret-drop",
  name: "Deploy token",
  contentType: "text/plain",
  ciphertext: "Y2lwaGVydGV4dA",
  nonce: "bm9uY2U",
};

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

async function createDropClaim(
  app: App,
  accessToken: string,
): Promise<CreatedClaim> {
  const res = await app.request("/v1/claims", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "resource_bundle",
      targetManifest: DROP_MANIFEST,
    }),
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

function present(app: App, body: BoundaryValue) {
  return app.request("/v1/claims/present", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("claim presentation (ADR 0062)", () => {
  it("creates a manifest-only session and presents it back exactly once", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const claim = await createDropClaim(app, owner.accessToken);

    const first = await present(app, { token: claim.claimToken });
    expect(first.status).toBe(200);
    const body: BoundaryValue = overlapCast(await first.json());
    expect(body.state).toBe("presented");
    expect(body.targetManifest).toEqual(DROP_MANIFEST);

    // Presentation is single-use: a second present is refused.
    const second = await present(app, { token: claim.claimToken });
    expect(second.status).toBe(422);
  });

  it("accepts a correct user code and serves the manifest with it", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const claim = await createDropClaim(app, owner.accessToken);

    const res = await present(app, {
      token: claim.claimToken,
      userCode: claim.userCode,
    });
    expect(res.status).toBe(200);
    expect(overlapCast(await res.json()).targetManifest).toEqual(DROP_MANIFEST);
  });

  it("refuses a wrong user code without burning the presentation", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const claim = await createDropClaim(app, owner.accessToken);

    const wrong = await present(app, {
      token: claim.claimToken,
      userCode: "WRONG-CODE",
    });
    expect(wrong.status).toBe(401);
    expect(overlapCast(await wrong.json()).error).toBe("invalid_user_code");

    // The single-use CAS never ran, so the right code still opens the claim.
    const right = await present(app, {
      token: claim.claimToken,
      userCode: claim.userCode,
    });
    expect(right.status).toBe(200);
  });

  it("fences repeated wrong codes exactly like completion does", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const claim = await createDropClaim(app, owner.accessToken);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await present(app, {
        token: claim.claimToken,
        userCode: "WRONG-CODE",
      });
      expect(res.status).toBe(401);
    }
    const fenced = await present(app, {
      token: claim.claimToken,
      userCode: claim.userCode,
    });
    expect(fenced.status).toBe(429);
    expect(overlapCast(await fenced.json()).error).toBe("too_many_attempts");
  });

  it("keeps the manifest out of the GET, poll, and complete projections", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const claim = await createDropClaim(app, owner.accessToken);

    const read = await app.request(`/v1/claims/${claim.claimId}`, {
      headers: { "x-claim-token": claim.claimToken },
    });
    expect(read.status).toBe(200);
    expect("targetManifest" in overlapCast(await read.json())).toBe(false);

    const poll = await app.request(`/v1/claims/${claim.claimId}/poll`, {
      headers: { "x-claim-token": claim.claimToken },
    });
    // An open claim polls as authorization_pending (400 by device-poll
    // contract); the projection still answers, and it must not carry the
    // manifest in either envelope.
    const pollBody: BoundaryValue = overlapCast(await poll.json());
    expect("targetManifest" in pollBody).toBe(false);
    expect("targetManifest" in overlapCast(pollBody.claim)).toBe(false);

    expect((await present(app, { token: claim.claimToken })).status).toBe(200);
    const complete = await app.request(`/v1/claims/${claim.claimId}/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        acceptedItemIds: [],
        userCode: claim.userCode,
        claimToken: claim.claimToken,
      }),
    });
    expect(complete.status).toBe(200);
    expect("targetManifest" in overlapCast(await complete.json())).toBe(false);
  });
});
