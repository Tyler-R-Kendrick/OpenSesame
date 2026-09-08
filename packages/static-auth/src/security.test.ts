import { overlapCast } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HostedProfile, createHostedClient } from "./hosted.js";
import {
  type LoopbackProfile,
  signInLoopback,
  validateLoopbackToken,
} from "./passthrough.js";
import { fetchJson, isLoopbackOrigin } from "./transport.js";

const loopback: LoopbackProfile = {
  profile: "pages_passthrough_loopback",
  brokerBase: "https://broker.example/",
  issuer: "https://shoo.dev",
  audience: "origin:https://broker.example",
};
const hosted: HostedProfile = {
  profile: "hosted_identity",
  issuer: "https://identity.example",
  clientId: "rp-client",
  redirectUri: "https://rp.example/callback",
  authorizationEndpoint: "https://identity.example/auth",
  tokenEndpoint: "https://identity.example/token",
  jwksUri: "https://identity.example/jwks",
};
function token(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return `${btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${btoa(JSON.stringify({ iss: "https://shoo.dev", aud: loopback.audience, pairwise_sub: "pairwise-test", iat: now, exp: now + 300, ...claims }))}.c2ln`;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("loopback admission and pinned verification", () => {
  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
  ])("admits actual canonical loopback %s", (origin) =>
    expect(isLoopbackOrigin(origin)).toBe(true),
  );
  it.each([
    "https://localhost.evil.example",
    "http://user@localhost",
    "http://localhost/",
    "http://localhost.",
    "null",
    "http://2130706433",
    "https://rp.example",
    "http://localhost:80",
  ])("refuses ambiguous/remote origins %s", (origin) =>
    expect(isLoopbackOrigin(origin)).toBe(false),
  );
  it("requires an active pinned session check before deriving a subject", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "active" }));
    vi.stubGlobal("fetch", fetcher);
    const result = await validateLoopbackToken(
      token(),
      loopback,
      "http://localhost:5173",
    );
    expect(result.subject).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result).not.toHaveProperty("id_token");
    expect(fetcher).toHaveBeenCalledWith(
      "https://shoo.dev/session/check",
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        method: "POST",
      }),
    );
  });
  it.each([{ status: "inactive" }, { active: true }, {}])(
    "rejects absent active verdict %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(
        validateLoopbackToken(token(), loopback, "http://localhost:5173"),
      ).rejects.toThrow();
    },
  );
  it.each([
    { iss: "https://evil.example" },
    { aud: "other" },
    { exp: 1 },
    { iat: 9999999999 },
    { nbf: 9999999999 },
    { pairwise_sub: "" },
  ])("rejects claims before egress %j", async (claims) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      validateLoopbackToken(token(claims), loopback, "http://localhost:5173"),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not turn a shaped fake JWT into authentication when the verifier rejects it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 401 })),
    );
    await expect(
      validateLoopbackToken(token(), loopback, "http://localhost:5173"),
    ).rejects.toThrow();
  });
  it("fails closed on redirects and oversized verification responses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 302 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchJson("https://shoo.dev/session/check")).rejects.toThrow();
    fetcher.mockResolvedValue(new Response("x".repeat(65537)));
    await expect(fetchJson("https://shoo.dev/session/check")).rejects.toThrow();
  });
});

describe("popup transaction", () => {
  function browser() {
    const popup = { closed: false, close: vi.fn() };
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const stub = {
      location: { origin: "http://localhost:5173" },
      open: vi.fn((_url: URL) => popup),
      addEventListener: (name: string, cb: (event: MessageEvent) => void) =>
        listeners.set(name, cb),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    const receive = (
      source: Pick<Window, "closed" | "close">,
      state: string,
      origin = "https://broker.example",
    ) =>
      listeners.get("message")?.(
        overlapCast({
          source,
          origin,
          data: {
            type: "opensesame:signin",
            state,
            id_token: token(),
            jwks_uri: "https://attacker.example/keys",
          },
        }),
      );
    return { stub, popup, receive };
  }
  it("binds exact source/state/origin and consumes before asynchronous verification", async () => {
    const { stub, popup, receive } = browser();
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "active" }));
    vi.stubGlobal("fetch", fetcher);
    const pending = signInLoopback(loopback, overlapCast(stub));
    const state =
      new URL(String(stub.open.mock.calls[0]?.[0])).searchParams.get("state") ??
      "";
    receive({ closed: false, close: vi.fn() }, state);
    receive(popup, "wrong");
    receive(popup, state, "https://other.example");
    expect(fetcher).not.toHaveBeenCalled();
    receive(popup, state);
    receive(popup, state);
    await expect(pending).resolves.toHaveProperty("subject");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://shoo.dev/session/check");
  });
  it("expires and closes a stale transaction", async () => {
    vi.useFakeTimers();
    const { stub, popup } = browser();
    const pending = signInLoopback(loopback, overlapCast(stub));
    const assertion = expect(pending).rejects.toThrow("signin_failed");
    await vi.advanceTimersByTimeAsync(300250);
    await assertion;
    expect(popup.close).toHaveBeenCalled();
  });
});

describe("hosted code flow", () => {
  function browser() {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => map.set(key, value),
      removeItem: (key: string) => {
        map.delete(key);
      },
    };
    const stub = {
      location: {
        origin: "https://rp.example",
        href: hosted.redirectUri,
        assign: vi.fn(),
      },
      history: { replaceState: vi.fn() },
      sessionStorage: storage,
    };
    return {
      stub,
      map,
      client: createHostedClient(hosted, overlapCast(stub)),
    };
  }
  it("uses PKCE S256, validates signature/nonce/RP audience, scrubs and consumes callback", async () => {
    const { stub, client, map } = browser();
    await client.begin();
    const authorize = new URL(stub.location.assign.mock.calls[0]?.[0] ?? "");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("nonce")?.length).toBeGreaterThanOrEqual(
      22,
    );
    const keys = await generateKeyPair("ES256");
    const jwt = await new SignJWT({
      nonce: authorize.searchParams.get("nonce"),
    })
      .setProtectedHeader({ alg: "ES256", kid: "key" })
      .setIssuer(hosted.issuer)
      .setAudience(hosted.clientId)
      .setSubject("rp-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id_token: jwt }))
      .mockResolvedValueOnce(
        Response.json({
          keys: [{ ...(await exportJWK(keys.publicKey)), kid: "key" }],
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    stub.location.href = `${hosted.redirectUri}?${new URLSearchParams({ code: "code", state: authorize.searchParams.get("state") ?? "", iss: hosted.issuer })}`;
    await expect(client.complete()).resolves.toEqual({
      subject: "rp-subject",
      expiresAt: expect.any(Number),
    });
    expect(map.size).toBe(0);
    expect(stub.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      hosted.redirectUri,
    );
    await expect(client.complete()).rejects.toThrow("invalid_callback");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects issuer mix-up before sending a verifier", async () => {
    const { stub, client } = browser();
    await client.begin();
    const authorize = new URL(stub.location.assign.mock.calls[0]?.[0] ?? "");
    stub.location.href = `${hosted.redirectUri}?code=code&state=${authorize.searchParams.get("state")}&iss=https://attacker.example`;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(client.complete()).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
