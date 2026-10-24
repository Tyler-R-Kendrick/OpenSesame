/** @vitest-environment node */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { resetAmbientAuthSeams } from "./ambient-auth-seam.js";
import type {
  BeginSignInOptions,
  TrustedUpstream,
} from "./federation-contract.js";
import {
  callbackHost,
  exchangeIssuer,
  holdStartLoader,
} from "./federation-exchange.test-support.js";
import { clearPendingSignIn, peekPending } from "./federation-pending.js";
import { beginSignIn, clearSession, discover } from "./federation.js";

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
async function setup() {
  const host = callbackHost();
  const issuer = await exchangeIssuer();
  closes.push(issuer.close);
  clearPendingSignIn();
  host.navigate("/signin?keep=1");
  const upstream: TrustedUpstream = {
    id: "identity:callback",
    issuer: issuer.issuer,
    clientId: "callback-spa",
    displayName: "Configured issuer",
    accountKind: "Configured account",
    protocol: "oidc",
    scope: "openid",
  };
  return { host, issuer, upstream };
}
function pendingRequired() {
  const pending = peekPending().pending;
  if (!pending)
    throw new Error("The real start did not publish a live PKCE transaction");
  return pending;
}
it("loads the actual start action and real discovery with immutable inputs, genuine S256/nonce/state and original security metadata", async () => {
  const { host, issuer, upstream } = await setup();
  const gate = holdStartLoader();
  const options: BeginSignInOptions = {
    scope: "openid profile email",
    returnTo: "/vault?keep=1",
    providerHint: "google",
    loginHint: "example.test",
    prompt: "login",
    orgSlug: "tenant",
    orgMethod: "sso",
  };
  const earliest = Date.now();
  const starting = beginSignIn(upstream, options);
  await gate.arrived;
  expect(issuer.requests).toEqual([]);
  expect(peekPending().pending).toBeNull();
  upstream.issuer = "https://foreign.example";
  upstream.clientId = "foreign-client";
  upstream.protocol = "shoo";
  options.scope = "foreign-scope";
  options.returnTo = "https://foreign.example";
  options.providerHint = "foreign";
  gate.release();
  await starting;
  const pending = pendingRequired();
  const url = new URL(host.href());
  expect(url.origin).toBe(issuer.issuer);
  expect(url.pathname).toBe("/authorize");
  expect(pending).toMatchObject({
    upstreamId: "identity:callback",
    issuer: issuer.issuer,
    clientId: "callback-spa",
    redirectUri: "https://app.example.test/",
    scope: "openid profile email",
    returnTo: "/vault?keep=1",
    orgSlug: "tenant",
    orgMethod: "sso",
  });
  expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(pending.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(pending.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(pending.createdAt).toBeGreaterThanOrEqual(earliest);
  expect(pending.createdAt).toBeLessThanOrEqual(Date.now());
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: "callback-spa",
    redirect_uri: "https://app.example.test/",
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: createHash("sha256")
      .update(pending.verifier)
      .digest("base64url"),
    code_challenge_method: "S256",
    response_type: "code",
    scope: "openid profile email",
    kc_idp_hint: "google",
    login_hint_provider: "google",
    login_hint: "example.test",
    prompt: "login",
  });
  expect(issuer.requests).toEqual(["GET /.well-known/openid-configuration"]);
  expect(issuer.errors).toEqual([]);
});
it.each(["signout", "configuration", "origin", "route", "fetch"] as const)(
  "refuses %s during the held start loader before discovery, pending publication or navigation",
  async (withdrawal) => {
    const { host, issuer, upstream } = await setup();
    const gate = holdStartLoader();
    const starting = beginSignIn(upstream);
    await gate.arrived;
    if (withdrawal === "signout") clearSession();
    if (withdrawal === "configuration")
      issuer.settings.signIn.providers.splice(0);
    if (withdrawal === "origin")
      host.navigate("https://foreign.example/signin");
    if (withdrawal === "route") host.navigate("/different-ceremony");
    if (withdrawal === "fetch")
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.reject(new Error("Foreign carrier must not be used")),
        ),
      );
    gate.release();
    await expect(starting).rejects.toMatchObject({
      code: withdrawal === "signout" ? "sign_in_cancelled" : "invalid_request",
    });
    expect(issuer.requests).toEqual([]);
    expect(peekPending().pending).toBeNull();
    expect(new URL(host.href()).pathname).not.toBe("/authorize");
  },
);
it("the public discovery API uses the same actual deferred owner without creating a pending ceremony", async () => {
  const { host, issuer } = await setup();
  const gate = holdStartLoader();
  const discovering = discover(issuer.issuer);
  await gate.arrived;
  expect(issuer.requests).toEqual([]);
  gate.release();
  expect(await discovering).toEqual(issuer.discovery);
  expect(issuer.requests).toEqual(["GET /.well-known/openid-configuration"]);
  expect(gate.load).toHaveBeenCalledOnce();
  expect(peekPending().pending).toBeNull();
  expect(new URL(host.href()).pathname).toBe("/signin");
});
it.each(["signout", "configuration"] as const)(
  "refuses %s while a real discovery response is held before any PKCE publication",
  async (withdrawal) => {
    const { host, issuer, upstream } = await setup();
    const held = issuer.holdDiscovery();
    const starting = beginSignIn(upstream);
    await held.arrived;
    if (withdrawal === "signout") clearSession();
    else issuer.settings.signIn.providers.splice(0);
    held.release();
    await expect(starting).rejects.toMatchObject({
      code: withdrawal === "signout" ? "sign_in_cancelled" : "invalid_request",
    });
    expect(issuer.requests).toEqual(["GET /.well-known/openid-configuration"]);
    expect(peekPending().pending).toBeNull();
    expect(new URL(host.href()).pathname).toBe("/signin");
  },
);
it.each(["issuer", "incomplete"] as const)(
  "retains the actual discovery %s refusal before pending state or navigation",
  async (fault) => {
    const { host, issuer, upstream } = await setup();
    if (fault === "issuer") issuer.discovery.issuer = "https://foreign.example";
    else Reflect.deleteProperty(issuer.discovery, "jwks_uri");
    await expect(beginSignIn(upstream)).rejects.toMatchObject({
      code: fault === "issuer" ? "issuer_mismatch" : "upstream_unavailable",
    });
    expect(issuer.requests).toEqual(["GET /.well-known/openid-configuration"]);
    expect(peekPending().pending).toBeNull();
    expect(new URL(host.href()).pathname).toBe("/signin");
  },
);
