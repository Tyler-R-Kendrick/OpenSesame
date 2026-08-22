import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "./control-plane.js";

const BASE = "http://127.0.0.1:8788";

function fetchReturning(...responses: Response[]): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!res) throw new Error("missing mock response");
    return res;
  });
}

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientWith(fetchImpl: typeof fetch, accessToken?: string) {
  return createControlPlaneClient({
    baseUrl: BASE,
    fetchImpl,
    ...(accessToken === undefined ? undefined : { accessToken }),
  });
}

describe("createControlPlaneClient error paths", () => {
  it("fails the provisional session when the server refuses it", async () => {
    const cp = clientWith(fetchReturning(json({ error: "x" }, 500)));
    await expect(cp.createProvisionalSession()).rejects.toThrow(
      /provisional session failed: 500/u,
    );
  });

  it("refuses a provisional session response that carries no token", async () => {
    // A session without a token cannot authenticate anything that follows it;
    // proceeding would strand every later call as anonymous.
    const cp = clientWith(fetchReturning(json({ principalId: "prn_1" }, 201)));
    await expect(cp.createProvisionalSession()).rejects.toThrow(
      /no access token/u,
    );
  });

  it("refuses an incomplete provisional session", async () => {
    const cp = clientWith(fetchReturning(json({ accessToken: "pst_x" }, 201)));
    await expect(cp.createProvisionalSession()).rejects.toThrow(
      /response was invalid/u,
    );
  });

  it("surfaces a whoami rejection with the status", async () => {
    const cp = clientWith(fetchReturning(json({}, 401)), "pst_x");
    await expect(cp.whoami()).rejects.toThrow(/whoami failed: 401/u);
  });

  it("surfaces a project-create rejection with the status", async () => {
    const cp = clientWith(fetchReturning(json({}, 403)), "pst_x");
    await expect(cp.createTemporaryProject({ name: "t" })).rejects.toThrow(
      /project create failed: 403/u,
    );
  });

  it("requires the osc_clm_ claim token shape before polling", async () => {
    const fetchImpl: typeof fetch = vi.fn();
    const cp = clientWith(fetchImpl);
    await expect(cp.pollClaim("clm_1", "not-a-claim-token")).rejects.toThrow(
      /osc_clm_/u,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a claim-poll rejection with the status", async () => {
    const cp = clientWith(fetchReturning(json({}, 404)), "pst_x");
    await expect(cp.pollClaim("clm_1", "osc_clm_x")).rejects.toThrow(
      /claim poll failed: 404/u,
    );
  });

  it("surfaces an agent-registration rejection with the status", async () => {
    const cp = clientWith(fetchReturning(json({}, 422)), "pst_x");
    await expect(
      cp.registerAnonymousAgent({ displayName: "a", publicKeyJkt: "jkt" }),
    ).rejects.toThrow(/agent register failed: 422/u);
  });

  it("surfaces a logout rejection and keeps the bearer", async () => {
    const seen: Array<string | null> = [];
    const fetchImpl: typeof fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return json({}, 500);
      },
    );
    const cp = clientWith(fetchImpl, "pst_x");
    await expect(cp.logout()).rejects.toThrow(/logout failed: 500/u);
    // The session may still be live server-side; the client must keep the token
    // so a retry or a following call still authenticates.
    await expect(cp.whoami()).rejects.toThrow(/whoami failed: 500/u);
    expect(seen).toEqual(["Bearer pst_x", "Bearer pst_x"]);
  });

  it("accepts a 200 logout as well as a 204", async () => {
    const cp = clientWith(fetchReturning(json({}), json({})), "pst_x");
    await cp.logout();
    await expect(cp.authStatus()).resolves.toEqual({ authenticated: false });
  });
});

describe("createControlPlaneClient authStatus", () => {
  it("reports unauthenticated without calling the server", async () => {
    const fetchImpl: typeof fetch = vi.fn();
    const cp = clientWith(fetchImpl);
    await expect(cp.authStatus()).resolves.toEqual({ authenticated: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports the principal when the token holds", async () => {
    const cp = clientWith(
      fetchReturning(json({ principalId: "prn_1" })),
      "pst_x",
    );
    const status = await cp.authStatus();
    expect(status.authenticated).toBe(true);
    if (status.authenticated) {
      expect(status.principal).toEqual({ principalId: "prn_1" });
    }
  });

  it("reports unauthenticated when whoami rejects", async () => {
    const cp = clientWith(fetchReturning(json({}, 401)), "pst_x");
    await expect(cp.authStatus()).resolves.toEqual({ authenticated: false });
  });
});

describe("createControlPlaneClient request headers", () => {
  it("marks JSON bodies and does not clobber a caller's content-type", async () => {
    const seen: Array<{ contentType: string | null; auth: string | null }> = [];
    const fetchImpl: typeof fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          contentType: headers.get("content-type"),
          auth: headers.get("authorization"),
        });
        return json({ ok: true });
      },
    );
    const cp = clientWith(fetchImpl, "pst_x");

    await cp.createTemporaryProject({ name: "t" });
    expect(seen[0]).toEqual({
      contentType: "application/json",
      auth: "Bearer pst_x",
    });

    await cp.pollClaim("clm_1", "osc_clm_x");
    // A bodiless call must not gain a content-type it does not need.
    expect(seen[1]?.contentType).toBeNull();
  });
});
