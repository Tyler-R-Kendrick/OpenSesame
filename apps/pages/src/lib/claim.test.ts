import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "./access.js";
import { presentOffer } from "./claim.js";

const hostFetch = vi.hoisted(() => vi.fn());

import { identitySeams } from "./identity.js";
Object.assign(identitySeams, {
  hostFetch,
  hostBase: () => "http://127.0.0.1:8787",
});

type LastCall = { url: string; init: RequestInit };

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(): LastCall {
  const call = hostFetch.mock.calls.at(-1);
  if (!call) throw new Error("hostFetch was not called");
  return { url: String(call[0]), init: call[1] ? overlapCast(call[1]) : {} };
}

/** Await a call expected to fail, returning the thrown error as an Error. */
async function failureOf(promise: Promise<BoundaryValue>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught instanceof Error ? caught : new Error(String(caught));
  }
  throw new Error("expected the call to fail");
}

const OFFER_WIRE = {
  id: "off_1",
  state: "presented",
  manifest_digest: "sha256:abc",
  expires_at: "2026-08-30T00:00:00Z",
  items: [
    {
      id: "item_1",
      connection_id: "conn_github",
      provider_id: "github",
      display_name: "GitHub prod",
      actions: ["read"],
      resources: ["repo:opensesame"],
      expires_in_seconds: 3600,
      execution_mode: "broker",
      required: true,
      dependencies: [],
    },
  ],
};

describe("claim client", () => {
  beforeEach(() => {
    hostFetch.mockReset();
  });

  it("presents an offer by POSTing only the claim token", async () => {
    hostFetch.mockResolvedValue(jsonResponse({ offer: OFFER_WIRE }));
    const offer = await presentOffer("osc_clm_id.secret");
    expect(lastCall().url).toBe("/api/v1/delegations/present");
    expect(lastCall().init.method).toBe("POST");
    expect(String(lastCall().init.body)).toBe(
      JSON.stringify({ claim_token: "osc_clm_id.secret" }),
    );
    expect(offer).toEqual({
      id: "off_1",
      state: "presented",
      manifestDigest: "sha256:abc",
      expiresAt: "2026-08-30T00:00:00Z",
      items: [
        {
          id: "item_1",
          connectionId: "conn_github",
          providerId: "github",
          displayName: "GitHub prod",
          actions: ["read"],
          resources: ["repo:opensesame"],
          expiresInSeconds: 3600,
          executionMode: "broker",
          required: true,
          dependencies: [],
        },
      ],
    });
  });

  it("collapses unknown, spent, and expired offers to one line", async () => {
    for (const status of [404, 409, 410]) {
      hostFetch.mockResolvedValueOnce(
        jsonResponse({ error: "offer_expired", detail: "expired" }, status),
      );
      const error = await failureOf(presentOffer("osc_clm_id.secret"));
      expect(error).toBeInstanceOf(AccessError);
      if (error instanceof AccessError) {
        expect(error.status).toBe(status);
        expect(error.code).toBe("offer_expired");
      }
      expect(error.message).toMatch(/unknown, spent, or expired/);
    }
  });

  it("maps network failures to an unreachable-Host error", async () => {
    hostFetch.mockRejectedValue(new TypeError("fetch failed"));
    const error = await failureOf(presentOffer("osc_clm_id.secret"));
    expect(error).toBeInstanceOf(AccessError);
    if (error instanceof AccessError) {
      expect(error.code).toBe("unreachable");
    }
    expect(error.message).toMatch(
      /Host API unreachable at http:\/\/127\.0\.0\.1:8787/,
    );
  });
});
