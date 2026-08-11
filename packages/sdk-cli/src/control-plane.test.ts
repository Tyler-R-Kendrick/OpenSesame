import { describe, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "./control-plane.js";

describe("createControlPlaneClient", () => {
  it("keeps a claim id inside its path segment", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const cp = createControlPlaneClient({
      baseUrl: "http://127.0.0.1:8788",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // An id that tries to aim the request — and the claim token with it — elsewhere.
    await cp.pollClaim("../../v1/session/logout", "osc_clm_abc");
    expect(seen[0]).toBe(
      "http://127.0.0.1:8788/api/v1/claims/..%2F..%2Fv1%2Fsession%2Flogout",
    );
  });

  it("will not carry a bearer token over cleartext", () => {
    expect(() =>
      createControlPlaneClient({ baseUrl: "http://api.example", accessToken: "at" }),
    ).toThrow(/https/i);
    expect(() =>
      createControlPlaneClient({ baseUrl: "https://api.example", accessToken: "at" }),
    ).not.toThrow();
  });
});
