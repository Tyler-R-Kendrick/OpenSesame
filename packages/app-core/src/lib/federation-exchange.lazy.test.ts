/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import {
  ambientAuthSeams,
  resetAmbientAuthSeams,
} from "./ambient-auth-seam.js";
import {
  type TokenFault,
  callbackHost,
  exchangeIssuer,
  holdExchangeLoader,
} from "./federation-exchange.test-support.js";
import { PKCE_KEY, peekPending, storePending } from "./federation-pending.js";
import { readFederationSessionJson } from "./federation-session-store.js";
import {
  clearSession,
  completeSignIn,
  federationExchangeSeams,
  loadSession,
} from "./federation.js";

const closes: (() => Promise<void>)[] = [];
beforeEach(() => {
  callbackHost();
  clearSession();
});
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetAmbientAuthSeams();
  configureHost(createTestHost());
});
async function setup(fault: TokenFault = "none") {
  const host = callbackHost();
  const issuer = await exchangeIssuer(fault);
  closes.push(issuer.close);
  return { host, issuer, gate: holdExchangeLoader() };
}
it("consumes state and scrubs the URL before loading, then runs the real signed token/JWKS exchange and session consumer exactly once", async () => {
  const { host, issuer, gate } = await setup();
  const completion = completeSignIn();
  await gate.arrived;
  expect(host.local.getItem(PKCE_KEY)).toBeNull();
  expect(new URL(host.href()).search).toBe("?keep=1");
  expect(issuer.requests).toEqual([]);
  expect(readFederationSessionJson()).toBeNull();
  gate.release();
  const result = await completion;
  expect(result?.identity).toMatchObject({
    pairwiseSub: "signed-operator",
    name: "Signed operator",
    audience: "callback-spa",
  });
  expect(result?.returnTo).toBe("/vault?keep=1");
  expect(result?.accessToken).toBeUndefined();
  expect(loadSession()?.idToken).toBe(issuer.token);
  expect(issuer.requests).toEqual(["POST /token", "GET /jwks"]);
  expect(issuer.errors).toEqual([]);
  expect(await completeSignIn()).toBeNull();
  expect(gate.load).toHaveBeenCalledOnce();
  expect(issuer.forms).toHaveLength(1);
});
it.each(["signout", "configuration", "callback", "origin", "fetch"] as const)(
  "refuses %s while the loader is held before any actual token egress or publication",
  async (withdrawal) => {
    const { host, issuer, gate } = await setup();
    const completion = completeSignIn();
    await gate.arrived;
    if (withdrawal === "signout") clearSession();
    if (withdrawal === "configuration")
      issuer.settings.signIn.providers.splice(0);
    if (withdrawal === "callback")
      host.navigate("/other?code=foreign&state=foreign-state");
    if (withdrawal === "origin")
      host.navigate(
        "https://foreign.example/?code=foreign&state=foreign-state",
      );
    if (withdrawal === "fetch")
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.reject(new Error("Foreign carrier must never be used")),
        ),
      );
    gate.release();
    await expect(completion).rejects.toMatchObject({
      code: withdrawal === "signout" ? "sign_in_cancelled" : "invalid_request",
    });
    expect(issuer.requests).toEqual([]);
    expect(readFederationSessionJson()).toBeNull();
  },
);
it("keeps the immutable original PKCE/client/redirect while preserving an unrelated newer pending ceremony", async () => {
  const { issuer, gate } = await setup();
  const completion = completeSignIn();
  await gate.arrived;
  storePending({
    upstreamId: "identity:other",
    issuer: "https://other.example",
    state: "state-newer-ceremony",
    verifier: "new-verifier-abcdefghijklmnopqrstuvwxyz0123456789",
    tokenEndpoint: "https://other.example/token",
    jwksUri: "https://other.example/jwks",
    clientId: "new-client",
    redirectUri: "https://other.example/return",
    scope: "openid",
  });
  gate.release();
  expect((await completion)?.identity.pairwiseSub).toBe("signed-operator");
  expect(issuer.requests).toEqual(["POST /token", "GET /jwks"]);
  expect(peekPending().pending?.state).toBe("state-newer-ceremony");
  expect(issuer.errors).toEqual([]);
});
it.each(["signature", "nonce", "audience", "issuer", "expired"] as const)(
  "preserves actual %s rejection through the deferred validator",
  async (fault) => {
    const { issuer, gate } = await setup(fault);
    const completion = completeSignIn();
    await gate.arrived;
    gate.release();
    if (fault === "nonce")
      await expect(completion).rejects.toThrow("id_token nonce mismatch");
    else
      await expect(completion).rejects.toMatchObject({
        code:
          fault === "signature"
            ? "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"
            : fault === "expired"
              ? "ERR_JWT_EXPIRED"
              : "ERR_JWT_CLAIM_VALIDATION_FAILED",
      });
    expect(issuer.requests).toEqual(["POST /token", "GET /jwks"]);
    expect(readFederationSessionJson()).toBeNull();
    expect(loadSession()).toBeNull();
    expect(issuer.errors).toEqual([]);
  },
);
it("a rejected loader leaves a consumed/scrubbed callback that cannot replay", async () => {
  const host = callbackHost();
  const issuer = await exchangeIssuer();
  closes.push(issuer.close);
  const load = vi
    .spyOn(federationExchangeSeams, "load")
    .mockRejectedValue(new Error("module delivery failed"));
  await expect(completeSignIn()).rejects.toThrow("module delivery failed");
  expect(peekPending().pending).toBeNull();
  expect(new URL(host.href()).search).toBe("?keep=1");
  expect(await completeSignIn()).toBeNull();
  expect(load).toHaveBeenCalledOnce();
  expect(issuer.requests).toEqual([]);
});
it("captures the ordinary callback before the ambient seam's existing await and refuses replacement", async () => {
  const { host, issuer, gate } = await setup();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(ambientAuthSeams, "completeIfPresent").mockImplementation(
    async () => {
      await held;
      return null;
    },
  );
  const completion = completeSignIn();
  host.navigate("/?code=foreign&state=foreign-state");
  release();
  await expect(completion).rejects.toMatchObject({ code: "invalid_request" });
  expect(gate.load).not.toHaveBeenCalled();
  expect(peekPending().pending?.state).toBe("state-original-callback");
  expect(issuer.requests).toEqual([]);
});
it("does not load the exchange for an ordinary page or malformed callback", async () => {
  const host = callbackHost();
  const load = vi.spyOn(federationExchangeSeams, "load");
  host.navigate("/?keep=1");
  expect(await completeSignIn()).toBeNull();
  host.navigate("/?code=first&code=duplicate&state=state-original-callback");
  await expect(completeSignIn()).rejects.toThrow();
  expect(load).not.toHaveBeenCalled();
  expect(new URL(host.href()).search).toBe("");
});
