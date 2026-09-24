/**
 * The claim calls on the wire: what each one sends, and how each refusal the
 * server names is read. The shapes and codes are the Identity API's
 * (`packages/control-plane/src/routes/claims.ts`).
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identitySeams } from "../identity.js";
import {
  type ClaimTransport,
  completeClaim,
  identityClaimTransport,
  presentClaim,
  readClaim,
} from "./transport.js";

const CLAIM = {
  id: "clm_1",
  type: "agent",
  state: "presented",
  targetManifestDigest: "sha256:abc",
  expiresAt: "2026-09-24T00:00:00.000Z",
  version: 1,
  items: [{ id: "item-1" }, { id: "item-2" }],
};

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transportAnswering(...answers: Array<Response | Error>) {
  const fetch = vi.fn(async (_path: string, _init: RequestInit) => {
    const next = answers.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no answer");
    return next;
  });
  const transport: ClaimTransport = {
    fetch,
    principal: () => "prn_1",
    provisional: async () => "prn_guest",
  };
  return { transport, fetch };
}

function sent(fetch: ReturnType<typeof transportAnswering>["fetch"]) {
  const [path, init] = fetch.mock.calls.at(-1) ?? ["", {}];
  return {
    path,
    method: init.method ?? "GET",
    headers: new Headers(init.headers),
    body: init.body ? JSON.parse(String(init.body)) : null,
  };
}

const original = { ...identitySeams };
afterEach(() => Object.assign(identitySeams, original));

describe("claim requests", () => {
  it("presents the bearer in the body, never the address", async () => {
    const { transport, fetch } = transportAnswering(json(CLAIM));
    const claim = await presentClaim(transport, "osc_clm_x.secret");
    expect(claim).toEqual({
      id: "clm_1",
      type: "agent",
      state: "presented",
      targetManifestDigest: "sha256:abc",
      itemIds: ["item-1", "item-2"],
    });
    const request = sent(fetch);
    expect(request).toMatchObject({
      path: "/v1/claims/present",
      method: "POST",
      body: { token: "osc_clm_x.secret" },
    });
    expect(request.path).not.toContain("osc_clm_");
  });

  it("reads a presented claim back with the bearer in a header", async () => {
    const { transport, fetch } = transportAnswering(json(CLAIM));
    await readClaim(transport, "clm/1", "osc_clm_x.secret");
    const request = sent(fetch);
    expect(request.path).toBe("/v1/claims/clm%2F1");
    expect(request.method).toBe("GET");
    expect(request.headers.get("x-claim-token")).toBe("osc_clm_x.secret");
  });

  it("completes with the items, the code and the bearer", async () => {
    const { transport, fetch } = transportAnswering(
      json({ ...CLAIM, state: "completed", won: true }),
    );
    await completeClaim(transport, "clm_1", {
      acceptedItemIds: ["item-1"],
      userCode: "WORD-WORD",
      claimToken: "osc_clm_x.secret",
    });
    const request = sent(fetch);
    expect(request).toMatchObject({
      path: "/v1/claims/clm_1/complete",
      method: "POST",
      body: {
        acceptedItemIds: ["item-1"],
        userCode: "WORD-WORD",
        claimToken: "osc_clm_x.secret",
      },
    });
    expect(request.headers.get("x-claim-token")).toBe("osc_clm_x.secret");
  });
});

describe("claim refusals on the wire", () => {
  const cases: Array<[BoundaryValue, number, string, boolean]> = [
    [{ error: "invalid_token" }, 401, "invalid", true],
    [{ error: "invalid_claim_token" }, 401, "invalid", true],
    [{ error: "invalid_user_code" }, 401, "wrong_code", false],
    [
      { error: "unauthorized", message: "Authentication required" },
      401,
      "signed_out",
      false,
    ],
    [{ error: "too_many_attempts" }, 429, "locked_out", true],
    [{ error: "EXPIRED" }, 410, "expired", true],
    [{ error: "INVALID_TRANSITION" }, 422, "decided", true],
    [{ error: "CONFLICT" }, 409, "decided", true],
    [{ error: "not_found" }, 404, "invalid", true],
    [{ error: "validation_error" }, 400, "rejected", false],
    [{}, 500, "unavailable", false],
    [null, 502, "unavailable", false],
  ];

  for (const [body, status, kind, spent] of cases) {
    it(`reads ${JSON.stringify(body)} ${status} as ${kind}`, async () => {
      const { transport } = transportAnswering(json(body, status));
      await expect(
        presentClaim(transport, "osc_clm_x.y"),
      ).rejects.toMatchObject({ kind, spent, status });
    });
  }

  it("words a server fault in the server's own words", async () => {
    const { transport } = transportAnswering(
      json({ message: "overloaded" }, 503),
    );
    await expect(presentClaim(transport, "osc_clm_x.y")).rejects.toThrow(
      "overloaded",
    );
  });

  it("keeps the bearer when nothing reached the server", async () => {
    const { transport } = transportAnswering(new TypeError("connection reset"));
    await expect(presentClaim(transport, "osc_clm_x.y")).rejects.toMatchObject({
      kind: "unreachable",
      spent: false,
    });
  });
});

describe("Pages' Identity transport", () => {
  it("rides identityFetch and reads the principal from the Identity session", async () => {
    const identityFetch = vi.fn(async () => json(CLAIM));
    Object.assign(identitySeams, {
      identityFetch,
      currentSession: () => ({
        principalId: "prn_1",
        accessToken: "at",
        issuerOrigin: "https://id.example",
      }),
      connectProvisional: async () => ({
        principalId: "prn_guest",
        accessToken: "at2",
        issuerOrigin: "https://id.example",
      }),
    });
    expect(identityClaimTransport.principal()).toBe("prn_1");
    await expect(identityClaimTransport.provisional()).resolves.toBe(
      "prn_guest",
    );
    await presentClaim(identityClaimTransport, "osc_clm_x.y");
    expect(identityFetch).toHaveBeenCalledWith(
      "/v1/claims/present",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("has no principal without an Identity session", () => {
    Object.assign(identitySeams, { currentSession: () => null });
    expect(identityClaimTransport.principal()).toBeNull();
  });
});
