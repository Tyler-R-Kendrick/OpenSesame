import { describe, expect, it } from "vitest";
import {
  createBoatCheckout,
  exchangeBoatAssertion,
  pollBoatClaim,
  readBoatAccount,
  startBoatClaim,
} from "./boat-ceremony.js";

function fakeBoat(pollResults: ("pending" | "claimed")[]) {
  const calls: string[] = [];
  let pollIndex = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/boat/agent/identity"))
      return Response.json({
        claim_token: "clm_test",
        claim: {
          user_code: "123456",
          verification_uri: "https://boat.dev/api/boat/agent/identity/claim",
          expires_in: 600,
          interval: 5,
        },
      });
    if (url.endsWith("/api/boat/oauth2/token")) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (form.get("grant_type")?.includes("jwt-bearer"))
        return Response.json({ access_token: "tok_exchanged" });
      const next = pollResults[pollIndex++] ?? "claimed";
      if (next === "pending")
        return Response.json(
          { error: "authorization_pending" },
          { status: 400 },
        );
      return Response.json({
        access_token: "tok_test",
        identity_assertion: "assertion_test",
      });
    }
    if (url.endsWith("/api/v1/me"))
      return Response.json({
        ok: true,
        user: { login: "person@example.test", email: "person@example.test" },
      });
    if (url.endsWith("/api/v1/limits"))
      return Response.json({
        ok: true,
        accessTier: "trial",
        blockedReason: "subscription_required",
      });
    if (url.endsWith("/api/boat/billing/checkout"))
      return Response.json({
        success: true,
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
      });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

describe("boat claim ceremony client", () => {
  it("registers with the person's email and returns claim materials", async () => {
    const fake = fakeBoat([]);
    const start = await startBoatClaim(fake.fetchImpl, "person@example.test");
    expect(start).toMatchObject({
      claimToken: "clm_test",
      userCode: "123456",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    });
    expect(start.verificationUri).toBe(
      "https://boat.dev/api/boat/agent/identity/claim",
    );
  });

  it("polls pending, then claimed with a recovery assertion", async () => {
    const fake = fakeBoat(["pending", "claimed"]);
    await expect(pollBoatClaim(fake.fetchImpl, "clm_test")).resolves.toEqual({
      status: "pending",
    });
    await expect(pollBoatClaim(fake.fetchImpl, "clm_test")).resolves.toEqual({
      status: "claimed",
      accessToken: "tok_test",
      identityAssertion: "assertion_test",
    });
  });

  it("reads account and billing state, and mints a validated checkout", async () => {
    const fake = fakeBoat([]);
    await expect(readBoatAccount(fake.fetchImpl, "tok_test")).resolves.toEqual(
      {
        login: "person@example.test",
        email: "person@example.test",
        accessTier: "trial",
        blockedReason: "subscription_required",
      },
    );
    await expect(
      createBoatCheckout(fake.fetchImpl, "tok_test"),
    ).resolves.toBe("https://checkout.stripe.com/c/pay/cs_test_123");
  });

  it("exchanges the sealed assertion for a fresh access token", async () => {
    const fake = fakeBoat([]);
    await expect(
      exchangeBoatAssertion(fake.fetchImpl, "assertion_test"),
    ).resolves.toBe("tok_exchanged");
  });

  it("refuses a claim URL that does not point at Boat's claim path", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        claim_token: "clm_evil",
        claim: {
          user_code: "999999",
          verification_uri: "https://evil.example.test/claim",
          expires_in: 600,
          interval: 5,
        },
      });
    await expect(
      startBoatClaim(fetchImpl, "person@example.test"),
    ).rejects.toThrow("claim");
  });
});
