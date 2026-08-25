import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetFederatedDiscoveryCache } from "../interactions/federated.js";
import type { startServer } from "../server.js";

type Started = Awaited<ReturnType<typeof startServer>>;
/** What a completed brokered round-trip hands back to the page that ran it. */
type BrokeredSignIn = { accessToken: string; principalId: string };

/**
 * Brokered session adoption, end to end (C13, D8).
 *
 * Nothing here is simulated. A real static-site client runs the real
 * origin-profile code flow against a real control plane, whose hosted login
 * page runs the real OIDC leg against the reference IdP; the access token that
 * comes back out of `/token` is the one oidc-provider actually issued, and it
 * is that token — not a hand-built stand-in — that the adoption endpoint is
 * asked to resolve.
 *
 * What the endpoint must never become is the thing D8 warns about: a way to
 * attach the page's pairwise identity to whatever session the browser happens
 * to hold (T23). It mints a session for the principal oidc-provider already
 * decided the token belonged to, and does nothing else.
 */

const RP_ORIGIN = "http://127.0.0.1:4402";
const RP_CLIENT_ID = `origin:${RP_ORIGIN}`;
const RP_REDIRECT = `${RP_ORIGIN}/opensesame/callback`;

/** Minimal cookie jar: a superset of browser path-scoping, fine for tests. */
class Jar {
  private cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  header() {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  // SAFETY: probe.listen established the runtime AddressInfo invariant.
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function extractCsrf(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error("no csrf token in page");
  return match[1];
}

describe("POST /v1/principals/federated-session", () => {
  let upstream: ReferenceIdp;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    upstream = await startReferenceIdp();
    const port = await reservePort();
    const { startServer: start } = await import("../server.js");
    started = await start({
      config: {
        host: "127.0.0.1",
        port,
        publicUrl: `http://127.0.0.1:${port}`,
        issuer: `http://127.0.0.1:${port}`,
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
        OPENSESAME_TRUSTED_UPSTREAMS: upstream.issuer,
      },
    });
    base = `http://127.0.0.1:${started.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await upstream.close();
    resetFederatedDiscoveryCache();
  });

  async function req(
    jar: Jar,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
      redirect: "manual",
      ...init,
      headers: { ...jar.header(), ...overlapCast(init.headers) },
    });
    jar.absorb(res);
    return res;
  }

  /**
   * The whole brokered round-trip a static page makes: authorize against this
   * server, sign in federated on its hosted page, consent, and exchange the
   * code at `/token` from the exact origin the client id names.
   */
  async function brokeredAccessToken(): Promise<BrokeredSignIn> {
    const jar = new Jar();
    const { verifier, challenge } = pkce();
    const authorize = await req(
      jar,
      `/auth?${new URLSearchParams({
        client_id: RP_CLIENT_ID,
        redirect_uri: RP_REDIRECT,
        response_type: "code",
        scope: "openid",
        state: "s-1",
        nonce: "n-1",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString()}`,
    );
    expect(authorize.status).toBe(303);
    const uid = (authorize.headers.get("location") ?? "").slice(
      "/interaction/".length,
    );
    const page = await (await req(jar, `/interaction/${uid}`)).text();
    const start = await req(jar, `/interaction/${uid}/federated/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: extractCsrf(page),
        issuer: upstream.issuer,
      }),
    });
    expect(start.status).toBe(303);
    const upstreamRes = await fetch(
      new URL(start.headers.get("location") ?? ""),
      { redirect: "manual" },
    );
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    const completed = await req(
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(completed.status).toBe(303);

    // Follow the resume chain, answering the consent prompt if one appears,
    // until the authorization request lands back on the client's redirect URI.
    let location = completed.headers.get("location") ?? "";
    let code: string | undefined;
    for (let hop = 0; hop < 8 && !code; hop++) {
      if (location.startsWith(RP_ORIGIN)) {
        code = new URL(location).searchParams.get("code") ?? undefined;
        break;
      }
      const res = await req(jar, location);
      if (res.status === 200) {
        // The consent prompt. It is a NEW interaction with its own uid and its
        // own single-use CSRF token, so both come from this page, not from the
        // login interaction that got us here.
        const consentUid = new URL(location, base).pathname.slice(
          "/interaction/".length,
        );
        const html = await res.text();
        const confirm = await req(jar, `/interaction/${consentUid}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ _csrf: extractCsrf(html) }),
        });
        expect(confirm.status).toBe(303);
        location = confirm.headers.get("location") ?? "";
        continue;
      }
      location = res.headers.get("location") ?? "";
    }
    if (!code)
      throw new Error("the brokered flow issued no authorization code");

    const tokenRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // The origin-profile contract: the exact origin inside the client id.
        origin: RP_ORIGIN,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: RP_CLIENT_ID,
        code,
        redirect_uri: RP_REDIRECT,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = overlapCast(await tokenRes.json());
    expect(tokens.access_token).toBeTruthy();

    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
      issuer: upstream.issuer,
      subject: createHash("sha256")
        .update(`os-mock:${currentSubject}:origin:${base}`)
        .digest("hex")
        .slice(0, 32),
    });
    if (!identity) throw new Error("the brokered sign-in linked no identity");
    return {
      accessToken: String(tokens.access_token),
      principalId: identity.principalId,
    };
  }

  let currentSubject = "";

  it("adopts the principal the access token was issued for", async () => {
    currentSubject = `adopt-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(currentSubject);
    const { accessToken, principalId } = await brokeredAccessToken();

    const res = await fetch(`${base}/v1/principals/federated-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken }),
    });
    expect(res.status).toBe(200);
    const body = overlapCast(await res.json());
    // The SAME principal: no new one is minted, and the id is the one the
    // hosted leg admitted, not whatever session the caller was holding.
    expect(body.principalId).toBe(principalId);
    expect(String(body.accessToken).startsWith("pst_")).toBe(true);
    expect(Date.parse(String(body.expiresAt))).toBeGreaterThan(Date.now());

    // The bearer works exactly like any other first-party session bearer.
    const me = await fetch(`${base}/v1/principals/me`, {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.status).toBe(200);
    expect(overlapCast(await me.json()).id).toBe(principalId);

    // Adoption is audited as adoption, not as a fresh admission.
    const events = await started.ctx.repos.auditEvents.list({ limit: 50 });
    const adopted = events.find(
      (event) => event.eventType === "principal.session_adopted",
    );
    expect(adopted?.principalId).toBe(principalId);
    expect(overlapCast(adopted?.metadata ?? {}).via).toBe("oidc_access_token");
  }, 30_000);

  it("mints a second, independent session rather than moving the first", async () => {
    currentSubject = `twice-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(currentSubject);
    const { accessToken, principalId } = await brokeredAccessToken();

    const first = overlapCast(
      await (
        await fetch(`${base}/v1/principals/federated-session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken }),
        })
      ).json(),
    );
    const second = overlapCast(
      await (
        await fetch(`${base}/v1/principals/federated-session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken }),
        })
      ).json(),
    );
    expect(first.principalId).toBe(principalId);
    expect(second.principalId).toBe(principalId);
    expect(second.accessToken).not.toBe(first.accessToken);
    // Both still authenticate: adopting a session must not revoke another.
    for (const token of [first.accessToken, second.accessToken]) {
      const me = await fetch(`${base}/v1/principals/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(200);
    }
  }, 30_000);

  it.each([
    ["a token nobody issued", randomBytes(32).toString("base64url")],
    ["an empty token", ""],
    ["a JWT rather than an opaque access token", "aaa.bbb.ccc"],
    ["something absurdly long", "x".repeat(9000)],
  ])("answers 401 invalid_token for %s", async (_label, accessToken) => {
    const res = await fetch(`${base}/v1/principals/federated-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it.each([
    ["no body at all", ""],
    ["a body that is not JSON", "not json"],
    ["a body with no accessToken", JSON.stringify({ token: "x" })],
    ["a non-string accessToken", JSON.stringify({ accessToken: 42 })],
  ])("answers 401 invalid_token for %s", async (_label, body) => {
    const res = await fetch(`${base}/v1/principals/federated-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  /**
   * A token issued to somebody else's client is not a session.
   *
   * What this route returns is a first-party `pst_` bearer, which
   * `authMiddleware` resolves to a full principal for every route behind
   * `requirePrincipal()` — projects, claims, organizations, SCIM token
   * minting. An OAuth access token is narrower than that by construction, so
   * accepting any of them would let a relying party a user granted `openid`
   * alone trade it for the user's whole identity-plane session.
   *
   * The exchange exists for one caller: an origin-profile static site
   * finishing the brokered flow (C13). Anything else is refused with the same
   * answer every other failure gets.
   */
  it("refuses a token issued to a pre-registered client", async () => {
    upstream.setSubject(currentSubject);
    const { principalId } = await brokeredAccessToken();

    // A confidential client of the same deployment, registered the ordinary
    // way. Its token is perfectly valid; it is simply not this route's.
    const confidentialId = `rp-confidential-${randomBytes(4).toString("hex")}`;
    await started.ctx.oauth.clientStore.insertAtomic({
      id: confidentialId,
      admissionMode: "pre_registered",
      displayName: "Confidential RP",
      redirectUris: ["https://rp.example/callback"],
      sectorIdentifier: "rp.example",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      // Public: a confidential one needs a secret in its metadata, and the
      // admission mode is what this test is about, not the auth method.
      tokenEndpointAuthMethod: "none",
      allowedScopes: ["openid"],
      allowedResources: [],
      state: "active",
    });

    const provider = started.ctx.oauth.provider;
    const client = await provider.Client.find(confidentialId);
    const issued = new provider.AccessToken(
      overlapCast({
        client,
        accountId: principalId,
        scope: "openid",
        clientId: confidentialId,
      }),
    );
    const asToken: { save(): Promise<string> } = overlapCast(issued);
    const value = await asToken.save();

    const res = await fetch(`${base}/v1/principals/federated-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: value }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  }, 30_000);

  it("refuses an expired access token", async () => {
    currentSubject = `expired-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(currentSubject);
    const { principalId } = await brokeredAccessToken();

    // A real oidc-provider access token for the same principal, saved with an
    // expiry already in the past — the store holds it, and `find` must still
    // refuse it. Nothing about the token is fabricated except its clock.
    const provider = started.ctx.oauth.provider;
    const client = await provider.Client.find(RP_CLIENT_ID);
    const stale = new provider.AccessToken(
      overlapCast({
        client,
        accountId: principalId,
        scope: "openid",
        clientId: RP_CLIENT_ID,
      }),
    );
    const staleToken: { exp: number; save(): Promise<string> } =
      overlapCast(stale);
    staleToken.exp = Math.floor(Date.now() / 1000) - 60;
    const value = await staleToken.save();

    const res = await fetch(`${base}/v1/principals/federated-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: value }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  }, 30_000);
});
