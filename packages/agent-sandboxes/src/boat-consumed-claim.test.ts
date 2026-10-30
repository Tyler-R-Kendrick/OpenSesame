import { describe, expect, it } from "vitest";
import type { BoatJsonValue } from "./boat-client.js";
import {
  type BoatProviderState,
  BoatSandboxProvider,
} from "./boat-provider.js";
import { SandboxClaimRequiredError } from "./types.js";

const request = { origin: "https://accounts.example.test" };
const claimGrant = "urn:workos:agent-auth:grant-type:claim";
const assertionGrant = "urn:ietf:params:oauth:grant-type:jwt-bearer";
function json(value: BoatJsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
function billing(path: string): Response {
  if (path === "/api/v1/sandboxes")
    return json(
      {
        ok: false,
        status: 402,
        code: "billing_required",
        error: { code: "billing_required", message: "billing" },
      },
      402,
    );
  if (path === "/api/boat/billing/checkout")
    return json({ url: "https://checkout.stripe.com/session" });
  throw new Error(`unexpected ${path}`);
}
function grantType(init: RequestInit | undefined): string | null {
  return new URLSearchParams(String(init?.body ?? "")).get("grant_type");
}

describe("consumed Boat claim grants", () => {
  it("persists the rotated assertion without the one-use claim, then resumes in a fresh provider", async () => {
    const grants: (string | null)[] = [];
    let persisted: BoatProviderState = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path !== "/api/boat/oauth2/token") return billing(path);
      const kind = grantType(init);
      grants.push(kind);
      if (kind === claimGrant)
        return json({ access_token: "live", identity_assertion: "rotated" });
      if (kind === assertionGrant)
        return json({ access_token: "live2", identity_assertion: "rotated2" });
      throw new Error("unexpected grant");
    };
    const first = new BoatSandboxProvider({
      state: { claimToken: "one-use" },
      fetchImpl,
      agentCommand: "agent",
      onStateChange: (state) => {
        persisted = state;
      },
    });
    await expect(first.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(persisted).toEqual({ identityAssertion: "rotated" });
    const second = new BoatSandboxProvider({
      state: persisted,
      fetchImpl,
      agentCommand: "agent",
    });
    await expect(second.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(grants).toEqual([claimGrant, assertionGrant]);
  });

  it("recovers a legacy consumed claim only for HTTP 400 invalid_grant", async () => {
    const grants: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path !== "/api/boat/oauth2/token") return billing(path);
      const kind = grantType(init);
      grants.push(kind);
      return kind === claimGrant
        ? json({ error: "invalid_grant" }, 400)
        : json({ access_token: "live", identity_assertion: "fresh" });
    };
    let persisted: BoatProviderState = {};
    const provider = new BoatSandboxProvider({
      state: { claimToken: "used", identityAssertion: "saved" },
      fetchImpl,
      agentCommand: "agent",
      onStateChange: (state) => {
        persisted = state;
      },
    });
    await expect(provider.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(grants).toEqual([claimGrant, assertionGrant]);
    expect(persisted).toEqual({ identityAssertion: "fresh" });
  });

  it.each([500, 401])(
    "does not fall back on invalid_grant with HTTP %i",
    async (status) => {
      const grants: (string | null)[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        grants.push(grantType(init));
        return json({ error: "invalid_grant" }, status);
      };
      const provider = new BoatSandboxProvider({
        state: { claimToken: "used", identityAssertion: "saved" },
        fetchImpl,
        agentCommand: "agent",
      });
      await expect(provider.allocate(request)).rejects.toThrow(
        "token grant failed",
      );
      expect(grants).toEqual([claimGrant]);
    },
  );
  it("does not fall back on a network failure or malformed response", async () => {
    for (const scenario of ["network", "malformed"]) {
      const grants: (string | null)[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        grants.push(grantType(init));
        if (scenario === "network") throw new Error("network unavailable");
        return new Response("not-json", { status: 400 });
      };
      const provider = new BoatSandboxProvider({
        state: { claimToken: "used", identityAssertion: "saved" },
        fetchImpl,
        agentCommand: "agent",
      });
      await expect(provider.allocate(request)).rejects.toThrow();
      expect(grants).toEqual([claimGrant]);
    }
  });
});
