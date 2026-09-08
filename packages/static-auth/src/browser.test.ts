import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostedProfile } from "./hosted.js";
import type { LoopbackProfile } from "./passthrough.js";

const hosted: HostedProfile = {
  profile: "hosted_identity",
  issuer: "https://identity.example",
  clientId: "rp",
  redirectUri: "https://rp.example/callback",
  authorizationEndpoint: "https://identity.example/auth",
  tokenEndpoint: "https://identity.example/token",
  jwksUri: "https://identity.example/jwks",
};
const loopback: LoopbackProfile = {
  profile: "pages_passthrough_loopback",
  brokerBase: "https://broker.example/",
  issuer: "https://shoo.dev",
  audience: "origin:https://broker.example",
};

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function browser(origin: string) {
  const events: Event[] = [];
  const map = new Map<string, string>();
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const popup = { closed: false, close: vi.fn() };
  const stub = {
    location: { origin, href: hosted.redirectUri, assign: vi.fn() },
    history: { replaceState: vi.fn() },
    sessionStorage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    },
    open: vi.fn((_url: URL) => popup),
    addEventListener: (name: string, cb: (event: MessageEvent) => void) =>
      listeners.set(name, cb),
    removeEventListener: (name: string) => listeners.delete(name),
    dispatchEvent: (event: Event) => {
      events.push(event);
      return true;
    },
  };
  vi.stubGlobal("window", stub);
  return { stub, events, popup, listeners };
}

it("does not announce authentication on hosted navigation or an absent callback", async () => {
  const { stub, events } = browser("https://rp.example");
  await import("./browser.js");
  await window.OpenSesame.signIn(hosted);
  const url = new URL(stub.location.assign.mock.calls[0]?.[0] ?? "");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  await expect(window.OpenSesame.complete(hosted)).resolves.toBeNull();
  expect(events).toEqual([]);
  expect(Object.isFrozen(window.OpenSesame)).toBe(true);
});

it("refuses and scrubs an unsolicited hosted callback without an authenticated event", async () => {
  const { stub, events } = browser("https://rp.example");
  stub.location.href = `${hosted.redirectUri}?code=untrusted-provider-body`;
  await import("./browser.js");
  await expect(window.OpenSesame.complete(hosted)).rejects.toThrow(
    "signin_failed",
  );
  expect(stub.history.replaceState).toHaveBeenCalledWith(
    null,
    "",
    hosted.redirectUri,
  );
  expect(events).toEqual([
    expect.objectContaining({
      type: "opensesame:signin_error",
      detail: { code: "signin_failed" },
    }),
  ]);
});

it.each(["browser", "compatibility"])(
  "%s waits for the pinned active verdict and redacts a rejected token",
  async (entry) => {
    const { stub, events, popup, listeners } = browser("http://localhost:5173");
    if (entry === "browser") await import("./browser.js");
    else await import("./compatibility.js");
    const now = Math.floor(Date.now() / 1000);
    const token = `${btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${btoa(JSON.stringify({ iss: loopback.issuer, aud: loopback.audience, pairwise_sub: "pairwise-test", iat: now, exp: now + 300 }))}.c2ln`;
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "active" }));
    vi.stubGlobal("fetch", fetcher);
    const receive = () => {
      const url = stub.open.mock.lastCall?.[0];
      listeners.get("message")?.(
        overlapCast({
          source: popup,
          origin: "https://broker.example",
          data: {
            type: "opensesame:signin",
            state: url?.searchParams.get("state"),
            id_token: token,
          },
        }),
      );
    };
    const pending = window.OpenSesame.signIn(loopback);
    expect(events).toEqual([]);
    receive();
    expect(events).toEqual([]);
    const result = await pending;
    expect(result).toEqual({
      subject: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: (now + 300) * 1000,
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "opensesame:signed_in", detail: result }),
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://shoo.dev/session/check",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    events.length = 0;
    fetcher.mockResolvedValue(
      new Response("private-token-body", { status: 401 }),
    );
    const rejected = window.OpenSesame.signIn(loopback);
    receive();
    await expect(rejected).rejects.toThrow("signin_failed");
    expect(events).toEqual([
      expect.objectContaining({
        type: "opensesame:signin_error",
        detail: { code: "signin_failed" },
      }),
    ]);
    expect(listeners.size).toBe(0);
  },
);
