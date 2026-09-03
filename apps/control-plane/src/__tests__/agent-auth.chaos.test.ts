import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

/**
 * Chaos for AgentAuth. Concurrent claim completion and token exchange must
 * fail closed: at most one completion wins, and a revoked or pre-claim token
 * never gains post-claim authority because another request finished first.
 */

function app() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  }).app;
}

async function json(res: Response) {
  return overlapCast(await res.json());
}

describe("AgentAuth chaos", () => {
  it("two completions of the same user_code admit at most one winner", async () => {
    const hono = app();
    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anonymous" }),
      }),
    );
    const started = await json(
      await hono.request("/agent/identity/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim_token: registered.claim_token,
          email: "owner@example.com",
        }),
      }),
    );
    const userCode = overlapCast(started.claim_attempt).user_code as string;
    const returnTo = new URL(
      String(overlapCast(started.claim_attempt).verification_uri),
    ).searchParams.get("return_to");
    const claimAttemptToken = new URL(
      returnTo ?? "",
      "http://127.0.0.1:8788",
    ).searchParams.get("claim_attempt_token");

    const created = await json(
      await hono.request("/v1/principals/provisional", { method: "POST" }),
    );
    const auth = { authorization: `Bearer ${created.accessToken}` };
    const linked = await hono.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "chaos-owner@example.com",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://mock.example",
        subject: "sub-owner@example.com",
        emailNormalized: "owner@example.com",
        emailVerified: true,
        assurance: "verified",
      }),
    });
    expect(linked.status).toBe(201);

    const attempts = await Promise.all(
      [0, 1].map(() =>
        hono.request("/agent/identity/claim/complete", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            claim_attempt_token: claimAttemptToken,
            user_code: userCode,
          }),
        }),
      ),
    );
    const wins = attempts.filter((res) => res.status === 200).length;
    expect(wins).toBe(1);
    expect(
      attempts.some((res) => res.status === 409 || res.status === 400),
    ).toBe(true);
  });

  it("forged JWTs and none-alg tokens never mint an access token", async () => {
    const hono = app();
    const garbage = [
      "",
      "not-a-jwt",
      "a.b.c",
      "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhcmVnX3gifQ.",
    ];
    for (const assertion of garbage) {
      const res = await hono.request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      });
      expect(res.status, assertion).toBe(400);
    }
  });
});
