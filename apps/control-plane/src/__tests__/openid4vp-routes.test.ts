/**
 * Hosted OpenID4VP verifier routes — presentation begin/complete gates.
 */

import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { verifiedPrincipal } from "./authentication-fixture.js";

function plane() {
  return createControlPlane({
    config: {
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      claimPepper: "openid4vp-route-test-pepper-32bytes!",
      isProduction: false,
      protocolFeatures: {
        oid4vp: true,
        oid4vci: false,
        fedcm: false,
        digitalCredentialsApi: false,
        openidFederation: false,
        sdJwtVc: false,
        tokenStatusList: false,
        presentationAgentIntents: false,
      },
    },
  });
}

describe("hosted OpenID4VP routes (F08 / V-03)", () => {
  it("refuses an unauthenticated begin", async () => {
    const { app } = plane();
    const res = await app.request("/v1/openid4vp/presentations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "ixn_does_not_exist",
        requestDigest: `sha256:${"a".repeat(64)}`,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses begin for an unknown interaction (T-09 shape)", async () => {
    const { app } = plane();
    const { auth } = await verifiedPrincipal(app);
    const res = await app.request("/v1/openid4vp/presentations", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "ixn_missing_subject_zzzz",
        requestDigest: `sha256:${"b".repeat(64)}`,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("does not settle from the public direct_post callback alone (T-23)", async () => {
    const { app } = plane();
    const res = await app.request("/v1/openid4vp/response", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "state=forged&vp_token=%7B%7D",
    });
    expect(res.status).toBe(404);
  });
});
