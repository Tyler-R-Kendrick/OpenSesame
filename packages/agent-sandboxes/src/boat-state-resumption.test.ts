import { describe, expect, it } from "vitest";
import type { BoatJsonValue } from "./boat-client.js";
import {
  type BoatProviderState,
  BoatSandboxProvider,
} from "./boat-provider.js";
import { SandboxClaimRequiredError } from "./types.js";

const request = { origin: "https://accounts.example.test" };
function json(value: BoatJsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Boat registration state resumption", () => {
  it("uses the retained anonymous assertion when the claim remains pending", async () => {
    const grants: string[] = [];
    let registrations = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/boat/agent/identity") {
        registrations += 1;
        return json({ claim_token: "claim", identity_assertion: "anonymous" });
      }
      if (url.pathname === "/api/boat/oauth2/token") {
        const grant =
          new URLSearchParams(String(init?.body)).get("grant_type") ?? "";
        grants.push(grant);
        return grant.includes("claim")
          ? json({ error: "authorization_pending" }, 400)
          : json({ access_token: "preclaim" });
      }
      if (url.pathname === "/api/v1/sandboxes")
        return json(
          {
            ok: false,
            status: 402,
            code: "billing_required",
            error: { code: "billing_required", message: "billing" },
          },
          402,
        );
      if (url.pathname === "/api/boat/billing/checkout")
        return json({ url: "https://checkout.stripe.com/session" });
      throw new Error(`unexpected ${url.pathname}`);
    };
    let persisted: BoatProviderState = {};
    const first = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      onStateChange: (state) => {
        persisted = state;
      },
    });
    await expect(first.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(persisted).toEqual({
      claimToken: "claim",
      identityAssertion: "anonymous",
    });
    const resumed = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      state: persisted,
    });
    await expect(resumed.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(registrations).toBe(1);
    expect(grants).toEqual([
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
      "urn:workos:agent-auth:grant-type:claim",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ]);
  });

  it("preserves the claim handoff after a failed durable write and across a fresh provider", async () => {
    let writes = 0;
    let persisted: BoatProviderState = {};
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/boat/agent/identity")
        return json({
          claim_token: "claim",
          claim: {
            user_code: "123456",
            verification_uri:
              "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=one",
            expires_in: 600,
            interval: 5,
          },
        });
      if (url.pathname === "/api/boat/oauth2/token")
        return json({ error: "authorization_pending" }, 400);
      throw new Error(`unexpected ${url.pathname}`);
    };
    const first = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      onStateChange: (state) => {
        writes += 1;
        if (writes === 1) throw new Error("disk unavailable");
        persisted = state;
      },
    });
    await expect(first.allocate(request)).rejects.toThrow("disk unavailable");
    await expect(first.allocate(request)).rejects.toMatchObject({
      verificationUri:
        "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=one",
      userCode: "123456",
    });
    const resumed = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      state: persisted,
    });
    await expect(resumed.allocate(request)).rejects.toMatchObject({
      verificationUri:
        "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=one",
      userCode: "123456",
    });
  });

  it("refreshes expired claim material and never shows it when refresh is unavailable", async () => {
    const stale: BoatProviderState = {
      claimToken: "old",
      claimIssuedAt: Date.now() - 10000,
      claimMaterials: {
        claimToken: "old",
        userCode: "111111",
        verificationUri:
          "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=old",
        expiresIn: 1,
        interval: 1,
      },
    };
    let persisted: BoatProviderState = {};
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/boat/oauth2/token")
        return json({ error: "authorization_pending" }, 400);
      if (path === "/api/boat/agent/identity/claim")
        return json({
          claim_token: "new",
          user_code: "222222",
          verification_uri:
            "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=new",
          expires_in: 600,
          interval: 5,
        });
      throw new Error(`unexpected ${path}`);
    };
    const withoutEmail = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      state: stale,
      claimEmail: "",
    });
    await expect(withoutEmail.allocate(request)).rejects.toThrow(
      /unavailable or expired/,
    );
    const withEmail = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      state: stale,
      claimEmail: "person@example.test",
      onStateChange: (state) => {
        persisted = state;
      },
    });
    await expect(withEmail.allocate(request)).rejects.toMatchObject({
      verificationUri:
        "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=new",
      userCode: "222222",
    });
    expect(persisted.claimToken).toBe("new");
    expect(persisted.claimMaterials?.claimToken).toBe("new");
  });

  it("rejects mismatched stored claim materials and ignores those from an overridden token", async () => {
    const claim = {
      claimToken: "other",
      userCode: "111111",
      verificationUri:
        "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=old",
      expiresIn: 600,
      interval: 1,
    };
    expect(
      () =>
        new BoatSandboxProvider({
          state: { claimToken: "first", claimMaterials: claim },
        }),
    ).toThrow(/do not match/);
    const fetchImpl: typeof fetch = async () =>
      json({ error: "authorization_pending" }, 400);
    const provider = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      claimToken: "override",
      claimEmail: "",
      state: {
        claimToken: "other",
        identityAssertion: "old-registration-assertion",
        claimMaterials: claim,
        claimIssuedAt: Date.now(),
      },
    });
    await expect(provider.allocate(request)).rejects.toThrow(
      /unavailable or expired/,
    );
  });

  it("does not poll a saved account when an explicit identity overrides it", async () => {
    const grants: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/boat/oauth2/token") {
        grants.push(
          new URLSearchParams(String(init?.body)).get("grant_type") ?? "",
        );
        return json({ access_token: "new-account" });
      }
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
    };
    const provider = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      identityAssertion: "explicit-new",
      state: { claimToken: "old-account", identityAssertion: "old-assertion" },
    });
    await expect(provider.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(grants).toEqual(["urn:ietf:params:oauth:grant-type:jwt-bearer"]);
  });

  it("retains a one-use claim grant until the rotated identity is persisted", async () => {
    let polls = 0;
    let writes = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/boat/oauth2/token") {
        polls += 1;
        return polls === 1
          ? json({ access_token: "live", identity_assertion: "rotated" })
          : json({ error: "invalid_grant" }, 400);
      }
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
    };
    const provider = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      state: { claimToken: "claim" },
      onStateChange: () => {
        writes += 1;
        if (writes === 1) throw new Error("disk unavailable");
      },
    });
    await expect(provider.allocate(request)).rejects.toThrow(
      /rotated identity could not be persisted/,
    );
    await expect(provider.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(polls).toBe(1);
    expect(writes).toBe(2);
  });

  it("persists rotated assertion before retrying after a write failure", async () => {
    const events: string[] = [];
    let writes = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/boat/oauth2/token") {
        events.push("grant");
        return json({ access_token: "token", identity_assertion: "rotated" });
      }
      if (url.pathname === "/api/v1/sandboxes")
        return json(
          {
            ok: false,
            status: 402,
            code: "billing_required",
            error: { code: "billing_required", message: "billing" },
          },
          402,
        );
      if (url.pathname === "/api/boat/billing/checkout")
        return json({ url: "https://checkout.stripe.com/session" });
      throw new Error(`unexpected ${url.pathname}`);
    };
    const provider = new BoatSandboxProvider({
      origin: "https://boat.dev",
      fetchImpl,
      agentCommand: "agent",
      state: { identityAssertion: "old" },
      onStateChange: () => {
        events.push("persist");
        writes += 1;
        if (writes === 1) throw new Error("disk unavailable");
      },
    });
    await expect(provider.allocate(request)).rejects.toThrow(
      "rotated identity could not be persisted",
    );
    await expect(provider.allocate(request)).rejects.toBeInstanceOf(
      SandboxClaimRequiredError,
    );
    expect(events.slice(0, 3)).toEqual(["grant", "persist", "persist"]);
  });
});
