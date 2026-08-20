import { describe, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "./control-plane.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

describe("createControlPlaneClient", () => {
  it("keeps a claim id inside its path segment", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const cp = createControlPlaneClient({
      baseUrl: "http://127.0.0.1:8788",
      fetchImpl: overlapCast(fetchImpl),
    });

    // An id that tries to aim the request — and the claim token with it — elsewhere.
    await cp.pollClaim("../../v1/principals/provisional/revoke", "osc_clm_abc");
    expect(seen[0]).toBe(
      "http://127.0.0.1:8788/v1/claims/..%2F..%2Fv1%2Fprincipals%2Fprovisional%2Frevoke",
    );
  });

  it("will not carry a bearer token over cleartext", () => {
    expect(() =>
      createControlPlaneClient({
        baseUrl: "http://api.example",
        accessToken: "at",
      }),
    ).toThrow(/https/i);
    expect(() =>
      createControlPlaneClient({
        baseUrl: "https://api.example",
        accessToken: "at",
      }),
    ).not.toThrow();
  });

  // The control plane mounts the product API under /v1 (apps/control-plane/src/app.ts),
  // not /api/v1. Pin every path this client aims at: a prefix the server does not
  // mount turns each ceremony into a 404 that reads as a permissions problem.
  it("calls the control plane paths the server actually mounts", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      if (url.pathname === "/v1/principals/provisional") {
        return new Response(
          JSON.stringify({
            principalId: "prn_guest",
            state: "provisional",
            assurance: "provisional",
            sessionId: "ps_1",
            accessToken: "pst_guest",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            tokenType: "Bearer",
          }),
          { status: 201 },
        );
      }
      if (url.pathname === "/v1/principals/provisional/revoke") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const cp = createControlPlaneClient({
      baseUrl: "http://127.0.0.1:8788",
      accessToken: "pst_existing",
      fetchImpl: overlapCast(fetchImpl),
    });

    await cp.whoami();
    await cp.createTemporaryProject({ name: "t" });
    await cp.registerAnonymousAgent({ displayName: "a", publicKeyJkt: "jkt" });
    await cp.logout();

    expect(seen).toEqual([
      "/v1/principals/me",
      "/v1/projects/temporary",
      "/v1/agents",
      "/v1/principals/provisional/revoke",
    ]);
  });

  it("bootstraps a provisional principal before anonymous agent registration", async () => {
    const calls: Array<{ path: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        calls.push({ path: url.pathname, auth: headers.get("authorization") });
        if (url.pathname === "/v1/principals/provisional") {
          return new Response(
            JSON.stringify({
              principalId: "prn_guest",
              state: "provisional",
              assurance: "provisional",
              sessionId: "ps_1",
              accessToken: "pst_guest",
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              tokenType: "Bearer",
            }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({
            agentId: "agt_1",
            instanceId: "agi_1",
            state: "provisional",
            claimId: "clm_1",
            claimToken: "osc_clm_x.y",
            userCode: "AAAA-BBBB",
          }),
          { status: 201 },
        );
      },
    );
    const cp = createControlPlaneClient({
      baseUrl: "http://127.0.0.1:8788",
      fetchImpl: overlapCast(fetchImpl),
    });

    const result = overlapCast(await cp.registerAnonymousAgent({
      displayName: "a",
      publicKeyJkt: "jkt",
    }));

    expect(calls).toEqual([
      { path: "/v1/principals/provisional", auth: null },
      { path: "/v1/agents", auth: "Bearer pst_guest" },
    ]);
    expect(result.claimToken).toBe("osc_clm_x.y");
    expect((overlapCast(result.provisional)).principalId).toBe(
      "prn_guest",
    );
  });

  it("logout without a session is a no-op", async () => {
    const fetchImpl = vi.fn();
    const cp = createControlPlaneClient({
      baseUrl: "http://127.0.0.1:8788",
      fetchImpl: overlapCast(fetchImpl),
    });
    await cp.logout();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
