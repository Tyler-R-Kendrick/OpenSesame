/**
 * Rendezvous address admission — scanner is never the holder (T-27 / T-28).
 */

import { isJsonObject, isString } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { verifiedPrincipal } from "./authentication-fixture.js";

function plane() {
  return createControlPlane({
    config: {
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      claimPepper: "rendezvous-admit-test-pepper-32b!!",
      isProduction: false,
    },
  });
}

describe("rendezvous address admission (T-27/T-28)", () => {
  it("does not disclose holder identity for an unknown address", async () => {
    const { app } = plane();
    const res = await app.request(
      "/v1/rendezvous/addresses/addr_photographed_xx",
    );
    expect(res.status).toBe(404);
    const parsed: unknown = await res.json();
    if (!isJsonObject(parsed)) throw new Error("expected JSON object");
    expect(isString(parsed.error) ? parsed.error : null).toBe(
      "address_unavailable",
    );
    expect(parsed.owner).toBeUndefined();
  });

  it("authenticated admit cannot mint requests against a disabled address registry", async () => {
    const { app } = plane();
    const { auth } = await verifiedPrincipal(app);
    const res = await app.request("/v1/rendezvous/admit", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        addressId: "addr_photographed_xx",
        requesterBinding: "req_binding_fixture_01",
      }),
    });
    expect(res.status).toBe(404);
  });
});
