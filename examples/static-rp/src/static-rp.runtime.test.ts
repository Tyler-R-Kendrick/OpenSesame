// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:4101/"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  begin,
  callback,
  observed,
  render,
  startRuntime,
  stopRuntime,
} from "./runtime.test-support.js";

beforeEach(startRuntime);
afterEach(stopRuntime);

describe("actual static RP public entrypoints", () => {
  it("renders pinned origin and issuer, and sign-out stores no RP token", async () => {
    await import("../public/index.js");
    expect(document.querySelector("#origin")?.textContent).toBe(
      window.location.origin,
    );
    expect(document.querySelector("#issuer")?.textContent).toBe(
      observed.issuer,
    );
    expect(document.querySelector("#status")?.textContent).toBe("Signed out.");
    document.querySelector<HTMLButtonElement>("#sign-out")?.click();
    expect(document.querySelector("#status")?.textContent).toBe(
      "Signed out. No RP token is stored.",
    );
    expect(window.sessionStorage.length).toBe(0);
    expect(observed.requests).toEqual([]);
  });

  it("begins genuine PKCE with the exact origin callback and sealed transaction", async () => {
    const authorization = await begin();
    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      `${observed.issuer}/auth`,
    );
    expect(authorization.hash).toBe("");
    expect(authorization.username).toBe("");
    expect(authorization.searchParams.get("client_id")).toBe(
      `origin:${window.location.origin}`,
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${window.location.origin}/opensesame/callback`,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    for (const key of ["state", "nonce", "code_challenge"]) {
      const value = authorization.searchParams.get(key);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/u);
      const storageKey = window.sessionStorage.key(0);
      if (storageKey === null || value === null)
        throw new Error("Sealed transaction missing.");
      expect(Buffer.from(value, "base64url")).toHaveLength(
        key === "code_challenge" ? 32 : 16,
      );
      expect(window.sessionStorage.getItem(storageKey)).not.toContain(value);
    }
    expect(observed.requests).toEqual([]);
  });

  it("rejects sign-in when the origin key provider cannot protect the redirect transaction", async () => {
    const { useClientAtRestKeys } = await import("@opensesame/browser-at-rest");
    useClientAtRestKeys(() =>
      Promise.reject(new Error("Origin key unavailable.")),
    );
    await import("../public/index.js");
    document.querySelector<HTMLButtonElement>("#sign-in")?.click();
    await vi.waitFor(() =>
      expect(document.querySelector("#status")?.textContent).toBe(
        "Sign-in failed.",
      ),
    );
    expect(observed.navigations).toEqual([]);
    expect(observed.requests).toEqual([]);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("refuses a missing required UI element before any sign-in effect", async () => {
    document.querySelector("#origin")?.remove();
    await expect(import("../public/index.js")).rejects.toThrow(
      "Missing example UI element",
    );
    expect(observed.navigations).toEqual([]);
    expect(observed.requests).toEqual([]);
  });
});

describe("real sealed transaction and ES256 callback verification", () => {
  it("renders no pending sign-in without network or retained tokens", async () => {
    render("opensesame/callback.html");
    await import("../public/callback.js");
    expect(document.querySelector("#message")?.textContent).toBe(
      "No pending sign-in.",
    );
    expect(observed.requests).toEqual([]);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("accepts the real issuer signature and nonce, strips callback secrets and consumes PKCE once", async () => {
    vi.spyOn(globalThis, "fetch");
    const authorization = await begin();
    callback(authorization);
    await import("../public/callback.js");
    expect(document.querySelector("#message")?.textContent).toBe(
      "Signed in as controlled-rp-subject",
    );
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.length).toBe(0);
    expect(observed.requests.map((request) => request.path)).toEqual([
      "/token",
      "/jwks",
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${observed.issuer}/token`,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${observed.issuer}/jwks`,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
    const exchange = observed.requests[0];
    if (exchange === undefined) throw new Error("Token exchange missing.");
    const form = new URLSearchParams(exchange.body);
    expect(form.get("code")).toBe("controlled-one-use-code");
    expect(form.get("client_id")).toBe(`origin:${window.location.origin}`);
    expect(form.get("redirect_uri")).toBe(
      `${window.location.origin}/opensesame/callback`,
    );
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
    expect(
      observed.requests.every(
        (request) =>
          request.authorization === undefined && request.cookie === undefined,
      ),
    ).toBe(true);
    const { sesame } = await import("../public/client.js");
    await expect(sesame.complete()).resolves.toBeNull();
    expect(observed.requests).toHaveLength(2);
  });

  it.each(["state", "iss", "error", "fragment"])(
    "rejects callback %s tampering before exchanging credentials",
    async (field) => {
      const authorization = await begin();
      const url = callback(authorization);
      if (field === "fragment") url.hash = "credential-fragment";
      else
        url.searchParams.set(
          field,
          field === "iss" ? "https://wrong-issuer.example" : "wrong",
        );
      window.history.replaceState(null, "", url.href);
      await import("../public/callback.js");
      expect(document.querySelector("#message")?.textContent).toBe(
        "Sign-in verification failed.",
      );
      expect(observed.requests).toEqual([]);
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("");
      expect(window.sessionStorage.length).toBe(0);
    },
  );
});

describe("controlled issuer failures retain no authenticated RP state", () => {
  it.each(["nonce", "signature", "token-status", "jwks-redirect"])(
    "rejects genuine token/transport %s failure",
    async (failure) => {
      const authorization = await begin();
      if (failure === "nonce") observed.nonce = "wrong-nonce";
      if (failure === "signature") observed.wrongSignature = true;
      if (failure === "token-status") observed.tokenStatus = 401;
      if (failure === "jwks-redirect") observed.jwksRedirect = true;
      callback(authorization);
      await import("../public/callback.js");
      expect(document.querySelector("#message")?.textContent).toBe(
        "Sign-in verification failed.",
      );
      expect(window.location.search).toBe("");
      expect(window.sessionStorage.length).toBe(0);
      expect(observed.requests[0]?.path).toBe("/token");
      expect(
        observed.requests.some((request) => request.path === "/unexpected"),
      ).toBe(false);
    },
  );
});
