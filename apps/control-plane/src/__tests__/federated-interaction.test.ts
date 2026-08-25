import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodePending,
  encodePending,
  federatedUpstreams,
  matchUpstreamHint,
  resetFederatedDiscoveryCache,
  revokeSessionsForIdentity,
} from "../interactions/federated.js";
import type { startServer } from "../server.js";
import { renderLoginPage } from "../ui/interaction-pages.js";

type Started = Awaited<ReturnType<typeof startServer>>;
type FederatedStartForm = Record<string, string>;
type FederatedTestEnvironment = Record<string, string>;
type LoginPageResult = { jar: Jar; uid: string; html: string };

const RP_ORIGIN = "http://127.0.0.1:4311";
const RP_CLIENT_ID = `origin:${RP_ORIGIN}`;
const RP_REDIRECT = `${RP_ORIGIN}/opensesame/callback`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

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

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header() {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }
}

async function startControlPlane(
  upstreamIssuer: string,
  port: number,
  extraEnv: FederatedTestEnvironment = {},
): Promise<Started> {
  const { startServer: start } = await import("../server.js");
  return start({
    config: {
      host: "127.0.0.1",
      port,
      // publicUrl must match the real bound port: it is both the origin-profile
      // client id and the base of the federated redirect_uri.
      publicUrl: `http://127.0.0.1:${port}`,
      issuer: `http://127.0.0.1:${port}`,
    },
    processEnv: {
      ...process.env,
      OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
      OPENSESAME_TRUSTED_UPSTREAMS: upstreamIssuer,
      ...extraEnv,
    },
  });
}

/** Reserve a port so publicUrl can name it before the server binds. */
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

async function req(
  base: string,
  jar: Jar,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const res = await fetch(url, {
    redirect: "manual",
    ...init,
    headers: { ...jar.header(), ...overlapCast(init.headers) },
  });
  jar.absorb(res);
  return res;
}

function postForm(fields: FederatedStartForm): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  };
}

/**
 * The reference IdP's pairwise subject derivation, mirrored so a test can look
 * up the identity row an origin-profile sign-in wrote. Origin-profile clients
 * never see the canonical subject; the row records what the assertion carried.
 */
function pairwiseSubjectFor(sub: string, clientOrigin: string): string {
  return createHash("sha256")
    .update(`os-mock:${sub}:origin:${clientOrigin}`)
    .digest("hex")
    .slice(0, 32);
}

/** The hidden inputs of a `form_post` auto-submitting response body. */
function parseAutoSubmitForm(html: string): {
  action: string;
  fields: Record<string, string>;
} {
  const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const input of html.matchAll(/<input[^>]*>/g)) {
    const name = input[0].match(/name="([^"]+)"/)?.[1];
    const value = input[0].match(/value="([^"]*)"/)?.[1];
    if (name) fields[name] = value ?? "";
  }
  return { action, fields };
}

describe("federated upstream table", () => {
  it("names shoo.dev by the account kind it fronts", () => {
    const [shoo] = federatedUpstreams(
      overlapCast({ trustedUpstreamIssuers: ["https://shoo.dev"] }),
    );
    expect(shoo).toEqual({
      id: "shoo",
      issuer: "https://shoo.dev",
      label: "Google",
    });
  });

  it("marks a loopback issuer as the local test account", () => {
    const [mock] = federatedUpstreams(
      overlapCast({ trustedUpstreamIssuers: ["http://127.0.0.1:9090"] }),
    );
    expect(mock?.id).toBe("mock");
    expect(mock?.label).toBe("a local test account");
  });

  it("falls back to the host for an unrecognized issuer", () => {
    const [other] = federatedUpstreams(
      overlapCast({ trustedUpstreamIssuers: ["https://idp.example.com"] }),
    );
    expect(other).toEqual({
      id: "idp.example.com",
      issuer: "https://idp.example.com",
      label: "idp.example.com",
    });
  });
});

describe("provider hint matching", () => {
  const upstreams = federatedUpstreams(
    overlapCast({
      trustedUpstreamIssuers: ["https://shoo.dev", "http://127.0.0.1:9090"],
    }),
  );

  it.each([
    ["shoo", "https://shoo.dev"],
    ["SHOO", "https://shoo.dev"],
    ["google", "https://shoo.dev"],
    ["https://shoo.dev", "https://shoo.dev"],
    ["shoo.dev", "https://shoo.dev"],
    ["mock", "http://127.0.0.1:9090"],
  ])("resolves %s to %s", (hint, issuer) => {
    expect(matchUpstreamHint(upstreams, hint)?.issuer).toBe(issuer);
  });

  it.each([undefined, "", "   ", "unknown-provider"])(
    "ignores the unusable hint %p",
    (hint) => {
      expect(matchUpstreamHint(upstreams, hint)).toBeUndefined();
    },
  );
});

describe("pending leg state", () => {
  const pending = {
    issuer: "https://shoo.dev",
    state: "st",
    nonce: "no",
    verifier: "ve",
  };

  it("round-trips", () => {
    expect(decodePending(encodePending(pending))).toEqual(pending);
  });

  it("round-trips the v2 provenance fields", () => {
    const v2 = {
      ...pending,
      kind: "oauth2" as const,
      providerId: "github",
      byoId: "byo_1",
      orgId: "org_1",
    };
    expect(decodePending(encodePending(v2))).toEqual(v2);
  });

  it.each([
    ["absent", undefined],
    ["not base64", "!!!!"],
    ["not an object", Buffer.from('"nope"').toString("base64url")],
    [
      "missing a field",
      Buffer.from(JSON.stringify({ issuer: "x", state: "y" })).toString(
        "base64url",
      ),
    ],
    [
      "an unknown kind",
      Buffer.from(
        JSON.stringify({ ...pending, kind: "saml" }),
      ).toString("base64url"),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(decodePending(raw)).toBeUndefined();
  });
});

describe("login page federated block", () => {
  const base = {
    uid: "u1",
    csrfToken: "tok",
    loginAction: "/interaction/u1/login",
    publicUrl: "http://127.0.0.1:8788",
  };

  it("omits the block when nothing is allowlisted", () => {
    const html = renderLoginPage({
      ...base,
      federated: { startAction: "/x", upstreams: [] },
    });
    expect(html).not.toContain("Sign in with");
  });

  it("renders one form per upstream, above the session action", () => {
    const html = renderLoginPage({
      ...base,
      federated: {
        startAction: "/interaction/u1/federated/start",
        upstreams: [
          { issuer: "https://shoo.dev", label: "Google" },
          { issuer: "http://127.0.0.1:9090", label: "a local test account" },
        ],
      },
    });
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("Sign in with a local test account");
    expect(html.indexOf("Sign in with Google")).toBeLessThan(
      html.indexOf("Start a session"),
    );
  });

  it("promotes the hinted upstream to first and primary", () => {
    const html = renderLoginPage({
      ...base,
      federated: {
        startAction: "/interaction/u1/federated/start",
        upstreams: [
          { issuer: "http://127.0.0.1:9090", label: "a local test account" },
          { issuer: "https://shoo.dev", label: "Google" },
        ],
        preferredIssuer: "https://shoo.dev",
      },
    });
    expect(html.indexOf("Sign in with Google")).toBeLessThan(
      html.indexOf("Sign in with a local test account"),
    );
    const googleForm = html.slice(html.indexOf("https://shoo.dev"));
    expect(googleForm.slice(0, 400)).toContain("btn-primary");
  });

  it("escapes a hostile label rather than emitting markup", () => {
    const html = renderLoginPage({
      ...base,
      federated: {
        startAction: "/x",
        upstreams: [
          { issuer: "https://e.test", label: '<img src=x onerror="boom">' },
        ],
      },
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

/**
 * The counterparty for every case below is the reference IdP (C18) — a real
 * OIDC server over real HTTP with keys generated at startup, which enforces
 * PKCE S256, single-use codes, and the origin-profile contract's `Origin`
 * byte-equality on the token endpoint. Nothing here is stubbed: an assertion
 * about what the leg sent is an assertion about bytes that crossed a socket.
 */
describe("federated interaction leg", () => {
  let upstream: ReferenceIdp;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    upstream = await startReferenceIdp();
    started = await startControlPlane(upstream.issuer, await reservePort());
    base = `http://127.0.0.1:${started.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await upstream.close();
    resetFederatedDiscoveryCache();
  });

  async function loginPage(): Promise<LoginPageResult> {
    const jar = new Jar();
    const { challenge } = pkce();
    const params = new URLSearchParams({
      client_id: RP_CLIENT_ID,
      redirect_uri: RP_REDIRECT,
      response_type: "code",
      scope: "openid",
      state: "s-1",
      nonce: "n-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await req(base, jar, `/auth?${params.toString()}`);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    const page = await req(base, jar, location);
    return { jar, uid, html: await page.text() };
  }

  it("offers the allowlisted upstream on the login page", async () => {
    const { html } = await loginPage();
    expect(html).toContain("Sign in with a local test account");
    expect(html).toContain("/federated/start");
  });

  it("refuses an issuer outside the allowlist", async () => {
    const { jar, uid, html } = await loginPage();
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({
        _csrf: extractCsrf(html),
        issuer: "https://evil.example.com",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses a provider id nothing in the registry answers to", async () => {
    // A `provider` field that resolves to nothing must not fall through to the
    // legacy `issuer` field: that would sign the user in somewhere else.
    const { jar, uid, html } = await loginPage();
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({
        _csrf: extractCsrf(html),
        provider: "not-a-provider",
        issuer: upstream.issuer,
      }),
    );
    expect(res.status).toBe(403);
    expect(jar.get(`os.fed.${uid}`)).toBeFalsy();
  });

  it("refuses a start without the CSRF token", async () => {
    const { jar, uid } = await loginPage();
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: "wrong", issuer: upstream.issuer }),
    );
    expect(res.status).toBe(403);
  });

  it("redirects to the upstream with PKCE S256, state and nonce", async () => {
    const { jar, uid, html } = await loginPage();
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    expect(res.status).toBe(303);
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.origin).toBe(upstream.issuer);
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("state")).toBeTruthy();
    expect(target.searchParams.get("nonce")).toBeTruthy();
    expect(target.searchParams.get("client_id")).toBe(`origin:${base}`);
    expect(target.searchParams.get("redirect_uri")).toBe(
      `${base}/interaction/${uid}/federated/callback`,
    );
    expect(jar.get(`os.fed.${uid}`)).toBeTruthy();
  });

  it("starts from a provider id and records it in the pending cookie", async () => {
    // The catalog button posts `provider`; the leg must resolve it to the same
    // issuer the legacy field names, and stamp the provenance on the cookie.
    const { jar, uid, html } = await loginPage();
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), provider: "mock" }),
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "").origin).toBe(
      upstream.issuer,
    );
    const pending = decodePending(jar.get(`os.fed.${uid}`));
    expect(pending?.issuer).toBe(upstream.issuer);
    expect(pending?.kind).toBe("oidc");
    expect(pending?.providerId).toBe("mock");
  });

  it("rejects a callback with no pending leg state", async () => {
    const { jar, uid } = await loginPage();
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback?code=x&state=y`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("did not match");
  });

  it("sends a refusal back to the login page", async () => {
    const { jar, uid, html } = await loginPage();
    await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback?error=access_denied`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/interaction/${uid}`);
  });

  it("rejects a callback whose state does not match the pending cookie", async () => {
    const { jar, uid, html } = await loginPage();
    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    const authorize = new URL(start.headers.get("location") ?? "");
    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    back.searchParams.set("state", "tampered");
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(res.status).toBe(400);
  });

  /**
   * A pending cookie that claims the generic OAuth2 leg must not be finished
   * by the OIDC one. The OIDC leg's whole guarantee is a JWKS-verified
   * id_token; running it for a provider that issues none would admit on
   * whatever the token endpoint returned.
   */
  it("refuses a pending cookie claiming a kind the registry does not offer", async () => {
    const { jar, uid, html } = await loginPage();
    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    const authorize = new URL(start.headers.get("location") ?? "");
    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");

    const forged = decodePending(jar.get(`os.fed.${uid}`));
    if (!forged) throw new Error("no pending cookie to forge from");
    const rewritten = encodePending({
      ...forged,
      kind: "oauth2",
      providerId: "mock",
    });
    const cookie = (jar.header().cookie ?? "")
      .split("; ")
      .map((entry) =>
        entry.startsWith(`os.fed.${uid}=`)
          ? `os.fed.${uid}=${rewritten}`
          : entry,
      )
      .join("; ");
    const res = await fetch(
      `${base}/interaction/${uid}/federated/callback${back.search}`,
      { redirect: "manual", headers: { cookie } },
    );
    expect(res.status).toBe(403);
  });

  /**
   * The whole point: a first-time visitor who never supplies a password,
   * passkey or PIN still ends up as one durable, verified principal.
   */
  it("admits a brand-new user and promotes the principal in place", async () => {
    const subject = `fresh-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(subject);
    const { jar, uid, html } = await loginPage();
    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    const authorize = new URL(start.headers.get("location") ?? "");
    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");

    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(res.status).toBe(303);
    // Back into the authorization request, i.e. the interaction completed.
    expect(res.headers.get("location")).toContain("/auth/");
    // The server-side exchange must present the origin the client id names.
    expect(upstream.tokenOriginSeen()).toBe(base);
    // And it is now a real session, not an anonymous one.
    expect(jar.get("os_provisional")).toBeTruthy();

    // The definition of done, asserted rather than inferred from the redirect:
    // one canonical principal, promoted in place, with the identity bound to
    // it. Everything above this point would still pass if the route stopped
    // promoting and left a provisional principal behind.
    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
      issuer: upstream.issuer,
      // Origin-profile clients get a pairwise subject, which is what the
      // identity row records.
      subject: pairwiseSubjectFor(subject, base),
    });
    expect(identity).toBeTruthy();
    expect(identity?.assurance).toBe("verified");

    const principal = await started.ctx.repos.principals.getById(
      identity?.principalId ?? "",
    );
    expect(principal?.state).toBe("active");
    expect(principal?.assurance).toBe("verified");
  });

  /**
   * Parity with POST /v1/principals/link-identities, which ensures the personal
   * project on a principal's first authenticated session. Without the same call
   * here, *where* you signed in would decide whether you have one — the API
   * surface gives you a project, the hosted login page does not.
   *
   * Asserted by re-running the ensure and requiring it to report `created:
   * false`: the only way that holds is if the sign-in already did it.
   */
  it("gives a federated first-timer the personal project the API path does", async () => {
    const subject = `project-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(subject);
    const { jar, uid, html } = await loginPage();
    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    const authorize = new URL(start.headers.get("location") ?? "");
    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(res.status).toBe(303);

    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
      issuer: upstream.issuer,
      subject: pairwiseSubjectFor(subject, base),
    });
    expect(identity).toBeTruthy();
    const { created } = await started.ctx.stores.projects.ensurePersonal(
      identity?.principalId ?? "",
      undefined,
      started.ctx.clock(),
    );
    expect(created).toBe(false);
  }, 30_000);

  it("reuses the same principal on a second sign-in", async () => {
    const subject = `repeat-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(subject);

    async function signIn(): Promise<{ principalId: string; cookie: string }> {
      const { jar, uid, html } = await loginPage();
      const start = await req(
        base,
        jar,
        `/interaction/${uid}/federated/start`,
        postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
      );
      const authorize = new URL(start.headers.get("location") ?? "");
      const upstreamRes = await fetch(authorize, { redirect: "manual" });
      const back = new URL(upstreamRes.headers.get("location") ?? "");
      const res = await req(
        base,
        jar,
        `/interaction/${uid}/federated/callback${back.search}`,
      );
      expect(res.status).toBe(303);
      const resumed = await req(base, jar, res.headers.get("location") ?? "");
      // Consent page (or straight through); either way the account is bound.
      expect([200, 303]).toContain(resumed.status);
      const identity = await started.ctx.repos.externalIdentities.findByTuple({
        kind: "oidc",
        issuer: upstream.issuer,
        subject: pairwiseSubjectFor(subject, base),
      });
      return {
        principalId: identity?.principalId ?? "",
        cookie: jar.get("os_provisional") ?? "",
      };
    }

    const first = await signIn();
    const second = await signIn();
    expect(first.principalId).toBeTruthy();
    // The identity tuple resolves before anything is minted, so the second
    // pass lands on the same principal rather than a fresh one.
    expect(second.principalId).toBe(first.principalId);
    // And a returning identity is issued no new provisional cookie (T6).
    expect(second.cookie).toBe("");
  }, 30_000);
});

/**
 * The effect half of OIDC Back-Channel Logout (C17).
 *
 * S10 owns the endpoint that verifies a `logout_token`; this is what it calls
 * once it has, and the thing that must actually be true afterwards is that the
 * bearer stops working. A revocation that removed a row and left a live token
 * behind would leave the human signed in for the rest of the session TTL,
 * which is exactly the window back-channel logout exists to close.
 *
 * Its own server so exactly one sign-in has happened when it runs: the
 * assertion is about a session ending, and it should not have to reason about
 * which of several sessions it is looking at.
 */
describe("federated leg, upstream logout", () => {
  let upstream: ReferenceIdp;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    upstream = await startReferenceIdp();
    started = await startControlPlane(upstream.issuer, await reservePort());
    base = `http://127.0.0.1:${started.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await upstream.close();
    resetFederatedDiscoveryCache();
  });

  it("revokes the sessions of an identity the upstream logged out", async () => {
    const subject = `logout-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(subject);

    const jar = new Jar();
    const { challenge } = pkce();
    const authRes = await req(
      base,
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
    const location = authRes.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    const html = await (await req(base, jar, location)).text();
    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    const authorize = new URL(start.headers.get("location") ?? "");
    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    const completed = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(completed.status).toBe(303);

    const bearer = jar.get("os_provisional") ?? "";
    expect(bearer).toBeTruthy();
    const before = await fetch(`${base}/v1/principals/me`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(before.status).toBe(200);

    const revoked = await revokeSessionsForIdentity(
      started.ctx,
      upstream.issuer,
      pairwiseSubjectFor(subject, base),
    );
    expect(revoked).toBe(1);

    const after = await fetch(`${base}/v1/principals/me`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(after.status).toBe(401);
  }, 30_000);

  it("revokes nothing for a subject it has never seen", async () => {
    // No oracle and no side effect: an unknown (issuer, subject) is a normal
    // thing for an unauthenticated back-channel POST to carry.
    expect(
      await revokeSessionsForIdentity(
        started.ctx,
        upstream.issuer,
        "nobody-here",
      ),
    ).toBe(0);
  });
});

/**
 * Organization sign-in JIT-join (D6).
 *
 * The tenant's IdP is deliberately NOT in `OPENSESAME_TRUSTED_UPSTREAMS`: the
 * only thing vouching for it is the organization row, which is what makes this
 * a test of the org branch of trust resolution rather than of the allowlist.
 * Completing the leg has to both admit the principal and make it a member —
 * a sign-in that verified the tenant's assertion and then left the human
 * outside the tenant would be a sign-in that did half its job.
 */
describe("federated leg, organization sign-in", () => {
  let allowlisted: ReferenceIdp;
  let tenantIdp: ReferenceIdp;
  let started: Started;
  let base: string;
  const organizationId = "org_jit_test";

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    allowlisted = await startReferenceIdp();
    tenantIdp = await startReferenceIdp();
    started = await startControlPlane(allowlisted.issuer, await reservePort());
    base = `http://127.0.0.1:${started.port}`;
    const now = started.ctx.clock();
    await started.ctx.stores.organizations.set(organizationId, {
      id: organizationId,
      slug: "acme",
      displayName: "Acme",
      state: "active",
      createdBy: "prn_seed_owner",
      createdAt: now,
      updatedAt: now,
      ssoIssuer: tenantIdp.issuer,
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await allowlisted.close();
    await tenantIdp.close();
    resetFederatedDiscoveryCache();
  });

  it("admits the subject and joins it to the tenant", async () => {
    const subject = `tenant-${randomBytes(4).toString("hex")}`;
    tenantIdp.setSubject(subject);

    const jar = new Jar();
    const { challenge } = pkce();
    const authRes = await req(
      base,
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
    const location = authRes.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    const html = await (await req(base, jar, location)).text();

    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: tenantIdp.issuer }),
    );
    expect(start.status).toBe(303);
    // The organization is what vouched for this issuer, and the cookie says so.
    expect(decodePending(jar.get(`os.fed.${uid}`))?.orgId).toBe(organizationId);

    const upstreamRes = await fetch(
      new URL(start.headers.get("location") ?? ""),
      { redirect: "manual" },
    );
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/auth/");

    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
      issuer: tenantIdp.issuer,
      subject: pairwiseSubjectFor(subject, base),
    });
    expect(identity).toBeTruthy();

    const membership = await started.ctx.stores.organizationMemberships.find(
      organizationId,
      identity?.principalId ?? "",
    );
    expect(membership?.role).toBe("member");

    const events = await started.ctx.repos.auditEvents.list({ limit: 50 });
    const joined = events.find(
      (event) =>
        event.eventType === "organization.member_joined" &&
        event.principalId === identity?.principalId,
    );
    expect(joined?.organizationId).toBe(organizationId);
  }, 30_000);

  it("refuses an issuer no organization and no allowlist names", async () => {
    const { jar, uid, html } = await (async () => {
      const cookieJar = new Jar();
      const { challenge } = pkce();
      const res = await req(
        base,
        cookieJar,
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
      const location = res.headers.get("location") ?? "";
      const page = await req(base, cookieJar, location);
      return {
        jar: cookieJar,
        uid: location.slice("/interaction/".length),
        html: await page.text(),
      };
    })();

    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({
        _csrf: extractCsrf(html),
        issuer: "https://some-other-tenant.example",
      }),
    );
    expect(res.status).toBe(403);
  });
});

/**
 * Discovery-cache isolation (T1).
 *
 * The cache key is `${issuer}|${clientId}`, and this is what that buys: two
 * deployments of this server, on two ports, are two different origin-profile
 * clients at the SAME issuer. Keyed on the issuer alone, the second one would
 * reuse the first's Configuration — sending the first's client id and the
 * first's `Origin` — and the reference IdP would answer `origin_cors_denied`.
 * The cache is deliberately NOT reset between the two sign-ins here; that is
 * the whole experiment.
 */
describe("federated leg, two clients at one issuer", () => {
  let upstream: ReferenceIdp;
  let first: Started;
  let second: Started;

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    upstream = await startReferenceIdp();
    first = await startControlPlane(upstream.issuer, await reservePort());
    second = await startControlPlane(upstream.issuer, await reservePort());
  }, 30_000);

  afterAll(async () => {
    for (const started of [first, second]) {
      await new Promise<void>((resolve, reject) =>
        started.server.close((err) => (err ? reject(err) : resolve())),
      );
    }
    await upstream.close();
    resetFederatedDiscoveryCache();
  });

  async function signInThrough(started: Started): Promise<void> {
    const base = `http://127.0.0.1:${started.port}`;
    const jar = new Jar();
    const { challenge } = pkce();
    const authRes = await req(
      base,
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
    const location = authRes.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    const html = await (await req(base, jar, location)).text();
    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    expect(start.status).toBe(303);
    const authorize = new URL(start.headers.get("location") ?? "");
    expect(authorize.searchParams.get("client_id")).toBe(`origin:${base}`);
    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/auth/");
    // Each deployment presented its OWN origin on the token request.
    expect(upstream.tokenOriginSeen()).toBe(base);
    expect(upstream.tokenClientSeen().id).toBe(`origin:${base}`);
  }

  it("does not hand the second client the first one's configuration", async () => {
    upstream.setSubject(`cache-a-${randomBytes(4).toString("hex")}`);
    await signInThrough(first);
    upstream.setSubject(`cache-b-${randomBytes(4).toString("hex")}`);
    await signInThrough(second);
  }, 30_000);
});

/**
 * Confidential-client mode (federated-signin.md §7.4). A broker that cannot
 * serve the secret-less origin-profile contract is authenticated by a secret
 * configured *for that exact issuer* instead.
 */
describe("federated leg, confidential client", () => {
  let upstream: ReferenceIdp;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    upstream = await startReferenceIdp();
    const port = await reservePort();
    upstream.setRedirectUris([
      `http://127.0.0.1:${port}/interaction/x/federated/callback`,
    ]);
    started = await startControlPlane(upstream.issuer, port, {
      OPENSESAME_UPSTREAM_ISSUER: upstream.issuer,
      OPENSESAME_UPSTREAM_CLIENT_ID: upstream.clientId,
      OPENSESAME_UPSTREAM_CLIENT_SECRET: upstream.clientSecret,
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

  it("authenticates with the configured secret, not a derived origin", async () => {
    upstream.setSubject(`conf-${randomBytes(4).toString("hex")}`);
    const jar = new Jar();
    const { challenge } = pkce();
    const authRes = await req(
      base,
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
    const location = authRes.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    const html = await (await req(base, jar, location)).text();
    // The confidential client's redirect URIs are registered at the IdP, so
    // this interaction's callback has to be among them.
    upstream.setRedirectUris([
      `${base}/interaction/${uid}/federated/callback`,
    ]);

    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    expect(start.status).toBe(303);
    const authorize = new URL(start.headers.get("location") ?? "");
    // The authorization request must name the configured client, not origin:.
    expect(authorize.searchParams.get("client_id")).toBe(upstream.clientId);

    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    const res = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/auth/");

    const seen = upstream.tokenClientSeen();
    expect(seen.id).toBe(upstream.clientId);
    expect(seen.secret).toBe(upstream.clientSecret);
    // T10: a confidential exchange must NOT claim a browser origin. The
    // reference IdP answers `origin_cors_denied` to one that does, so the
    // 303 above already proves it — this pins the intent.
    expect(upstream.tokenOriginSeen()).toBeUndefined();
  }, 30_000);
});

/**
 * `response_mode=form_post` (D3, T4).
 *
 * The reference IdP is started in `formPost` mode, so its authorize endpoint
 * answers with a real auto-submitting HTML form — the wire behavior Apple
 * exhibits — instead of a redirect. The browser side of that is driven here,
 * and the callback POST is sent **cookie-less** on purpose: that is what a
 * genuine cross-site form POST looks like, and it is the only way to prove the
 * 303 re-materialization actually carries the flow.
 */
describe("federated leg, form_post callback", () => {
  let upstream: ReferenceIdp;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    upstream = await startReferenceIdp({ formPost: true });
    started = await startControlPlane(upstream.issuer, await reservePort());
    base = `http://127.0.0.1:${started.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await upstream.close();
    resetFederatedDiscoveryCache();
  });

  async function startLeg(): Promise<{ jar: Jar; uid: string; form: URL }> {
    const jar = new Jar();
    const { challenge } = pkce();
    const authRes = await req(
      base,
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
    const location = authRes.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    const html = await (await req(base, jar, location)).text();
    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    expect(start.status).toBe(303);
    return { jar, uid, form: new URL(start.headers.get("location") ?? "") };
  }

  it("completes a sign-in whose response arrives as a cookie-less POST", async () => {
    const subject = `apple-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(subject);
    const { jar, uid, form } = await startLeg();

    // The IdP answers the authorization request with an HTML form, not a 303.
    const authorizeRes = await fetch(form, { redirect: "manual" });
    expect(authorizeRes.status).toBe(200);
    const posted = parseAutoSubmitForm(await authorizeRes.text());
    expect(posted.action).toBe(
      `${base}/interaction/${uid}/federated/callback`,
    );
    expect(posted.fields.code).toBeTruthy();

    // A cross-site POST carries NO SameSite=Lax cookies. Sending the jar here
    // would prove nothing, so the POST goes out bare.
    const rematerialized = await fetch(posted.action, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(posted.fields),
    });
    expect(rematerialized.status).toBe(303);
    const target = new URL(
      rematerialized.headers.get("location") ?? "",
      base,
    );
    expect(target.pathname).toBe(`/interaction/${uid}/federated/callback`);
    expect(target.searchParams.get("code")).toBe(posted.fields.code);
    // Nothing was completed here: no session, no interaction result.
    expect(rematerialized.headers.getSetCookie()).toEqual([]);

    // The top-level GET the 303 produces DOES carry the cookies, and that is
    // the request that finishes the sign-in.
    const completed = await req(base, jar, `${target.pathname}${target.search}`);
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toContain("/auth/");
    expect(jar.get("os_provisional")).toBeTruthy();
  }, 30_000);

  it("copies only the four authorization-response parameters", async () => {
    const { uid } = await startLeg();
    const res = await fetch(
      `${base}/interaction/${uid}/federated/callback`,
      {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: "c1",
          state: "s1",
          error: "e1",
          error_description: "d1",
          // Apple posts this on first consent; it is not ours to forward.
          user: '{"name":{"firstName":"A"}}',
          id_token: "not.a.token",
          // A parameter longer than the cap is dropped, not truncated.
          returnTo: "x".repeat(4096),
        }),
      },
    );
    expect(res.status).toBe(303);
    const target = new URL(res.headers.get("location") ?? "", base);
    expect([...target.searchParams.keys()].sort()).toEqual([
      "code",
      "error",
      "error_description",
      "state",
    ]);
  });

  it("drops an over-long code rather than reflecting it", async () => {
    const { uid } = await startLeg();
    const res = await fetch(
      `${base}/interaction/${uid}/federated/callback`,
      {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: "c".repeat(4096), state: "s1" }),
      },
    );
    expect(res.status).toBe(303);
    const target = new URL(res.headers.get("location") ?? "", base);
    expect(target.searchParams.get("code")).toBeNull();
    expect(target.searchParams.get("state")).toBe("s1");
  });
});
