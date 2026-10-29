import { describe, expect, it } from "vitest";
import { BoatAgentAuth, BoatClaimPendingError } from "./boat-auth.js";

interface FakeBody {
  claim_token?: string;
  identity_assertion?: string;
  access_token?: string;
  error?: string;
  claim?: {
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
}

interface RecordedRequest {
  url: string;
  body: string;
  contentType: string;
}

function fakeAuth(responses: FakeBody[]) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    requests.push({
      url,
      body: String(init?.body ?? ""),
      contentType: new Headers(init?.headers).get("content-type") ?? "",
    });
    const body = responses.shift();
    if (!body) throw new Error("unexpected request");
    const status = body.error ? 400 : 200;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    // SAFETY: checked at the fake-fetch boundary: the mock implements exactly the (url, init) call shapes the auth client sends.
    auth: new BoatAgentAuth({
      origin: "https://boat.test",
      fetchImpl: fetchImpl as typeof fetch,
    }),
    requests,
  };
}

const CLAIM = {
  user_code: "123456",
  verification_uri:
    "https://boat.test/api/boat/agent/identity/claim?claim_attempt_token=x",
  expires_in: 600,
  interval: 5,
};

describe("BoatAgentAuth (auth.md)", () => {
  it("registers anonymously and exchanges the assertion", async () => {
    const { auth, requests } = fakeAuth([
      { claim_token: "clm_1", identity_assertion: "assert-1" },
      { access_token: "boat_pre", identity_assertion: "assert-2" },
    ]);
    const registration = await auth.register();
    expect(registration).toEqual({
      claimToken: "clm_1",
      identityAssertion: "assert-1",
    });
    expect(requests[0]?.url).toBe("https://boat.test/api/boat/agent/identity");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      type: "anonymous",
    });
    const grant = await auth.exchangeAssertion("assert-1");
    expect(grant).toEqual({
      accessToken: "boat_pre",
      identityAssertion: "assert-2",
    });
    const form = new URLSearchParams(requests[1]?.body);
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    expect(form.get("assertion")).toBe("assert-1");
    expect(form.get("resource")).toBe("https://boat.test/api/v1/");
    expect(requests[1]?.contentType).toContain(
      "application/x-www-form-urlencoded",
    );
  });

  it("registers with service_auth and returns ceremony materials", async () => {
    const { auth, requests } = fakeAuth([
      { claim_token: "clm_9", claim: CLAIM },
    ]);
    const registration = await auth.register("person@example.test");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      type: "service_auth",
      login_hint: "person@example.test",
    });
    expect(registration.claim).toEqual({
      claimToken: "clm_9",
      userCode: "123456",
      verificationUri: CLAIM.verification_uri,
      expiresIn: 600,
      interval: 5,
    });
  });

  it("requests a claim for an anonymous registration and polls the grant", async () => {
    const { auth, requests } = fakeAuth([
      { claim_token: "clm_1", ...CLAIM },
      { error: "authorization_pending" },
      { access_token: "boat_live" },
    ]);
    const materials = await auth.requestClaim("clm_1", "person@example.test");
    expect(materials.userCode).toBe("123456");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      claim_token: "clm_1",
      email: "person@example.test",
    });
    await expect(auth.pollClaim("clm_1")).rejects.toBeInstanceOf(
      BoatClaimPendingError,
    );
    const form = new URLSearchParams(requests[1]?.body);
    expect(form.get("grant_type")).toBe(
      "urn:workos:agent-auth:grant-type:claim",
    );
    expect(form.get("claim_token")).toBe("clm_1");
    await expect(auth.pollClaim("clm_1")).resolves.toEqual({
      accessToken: "boat_live",
    });
  });
});
