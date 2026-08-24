import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { overlapCast } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodePending,
  encodePending,
  federatedUpstreams,
  matchUpstreamHint,
  resetFederatedDiscoveryCache,
} from "../interactions/federated.js";
import type { startServer } from "../server.js";
import { renderLoginPage } from "../ui/interaction-pages.js";

type Started = Awaited<ReturnType<typeof startServer>>;
type TokenClient = { id?: string; secret?: string };
type FederatedStartForm = { _csrf: string; issuer: string };
type FederatedTestEnvironment = {
  OPENSESAME_UPSTREAM_ISSUER?: string;
  OPENSESAME_UPSTREAM_CLIENT_ID?: string;
  OPENSESAME_UPSTREAM_CLIENT_SECRET?: string;
};
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

/**
 * A stand-in trusted broker. Deliberately enforces the two things the real
 * origin-profile contract enforces and that a server-side leg could silently
 * get wrong: PKCE S256, and an `Origin` header on /token byte-equal to the
 * origin inside the client id (see apps/mock-upstream-idp).
 */
type StubUpstream = {
  issuer: string;
  close: () => Promise<void>;
  /** Codes handed out by /authorize, keyed by code. */
  lastNonce: () => string | undefined;
  tokenOriginSeen: () => string | undefined;
  tokenClientSeen: () => { id?: string; secret?: string };
  setSubject: (sub: string) => void;
};

/** The secret the stub expects from a confidential client. */
const STUB_CLIENT_SECRET = "stub-upstream-secret";
const STUB_CLIENT_ID = "opensesame-upstream-test";

async function startStubUpstream(): Promise<StubUpstream> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = { ...(await exportJWK(publicKey)), kid: "stub-1", alg: "RS256" };
  const codes = new Map<
    string,
    { challenge: string; nonce: string; clientId: string }
  >();
  let lastNonce: string | undefined;
  let tokenOrigin: string | undefined;
  let tokenClient: TokenClient = {};
  let subject = "stub-user-1";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const issuer = `http://127.0.0.1:${port}`;

    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["pairwise"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }

    if (url.pathname === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }

    if (url.pathname === "/authorize") {
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const method = url.searchParams.get("code_challenge_method");
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";
      const clientId = url.searchParams.get("client_id") ?? "";
      if (method !== "S256" || !challenge) {
        res.writeHead(400).end("pkce_required");
        return;
      }
      lastNonce = nonce;
      const code = randomBytes(16).toString("hex");
      codes.set(code, { challenge, nonce, clientId });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      res.writeHead(303, { location: back.href }).end();
      return;
    }

    if (url.pathname === "/token" && req.method === "POST") {
      tokenOrigin = Array.isArray(req.headers.origin)
        ? req.headers.origin[0]
        : req.headers.origin;
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        void (async () => {
          const form = new URLSearchParams(body);
          const record = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          if (!record) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          tokenClient = {
            ...(form.get("client_id")
              ? { id: form.get("client_id") ?? undefined }
              : undefined),
            ...(form.get("client_secret")
              ? { secret: form.get("client_secret") ?? undefined }
              : undefined),
          };
          // Origin-profile clients carry no secret, so the Origin header is
          // the only caller binding the broker has.
          if (record.clientId.startsWith("origin:")) {
            if (tokenOrigin !== record.clientId.slice("origin:".length)) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "origin_cors_denied" }));
              return;
            }
          } else if (form.get("client_secret") !== STUB_CLIENT_SECRET) {
            // A confidential client is bound by its secret instead.
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
            return;
          }
          const verifier = form.get("code_verifier") ?? "";
          const computed = createHash("sha256")
            .update(verifier)
            .digest("base64url");
          if (computed !== record.challenge) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          const idToken = await new SignJWT({
            nonce: record.nonce,
            pairwise_sub: subject,
            email: "Person@Example.COM",
            email_verified: true,
            name: "Test Person",
          })
            .setProtectedHeader({ alg: "RS256", kid: "stub-1" })
            .setIssuer(issuer)
            .setSubject(`global-${subject}`)
            .setAudience(record.clientId)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: randomBytes(16).toString("hex"),
              token_type: "Bearer",
              expires_in: 300,
              id_token: idToken,
            }),
          );
        })();
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: server.listen established the runtime AddressInfo invariant.
  const port = (server.address() as AddressInfo).port;

  return {
    issuer: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    lastNonce: () => lastNonce,
    tokenOriginSeen: () => tokenOrigin,
    tokenClientSeen: () => tokenClient,
    setSubject: (sub: string) => {
      subject = sub;
    },
  };
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

describe("federated interaction leg", () => {
  let upstream: StubUpstream;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    upstream = await startStubUpstream();
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
      subject,
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
      subject,
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

    async function signIn(): Promise<string> {
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
      return jar.get("os_provisional") ?? "";
    }

    const first = await signIn();
    const second = await signIn();
    // A second mint would have issued a brand-new provisional token; the
    // identity lookup short-circuits that, so no new cookie is set.
    expect(first).toBeTruthy();
    expect(second).toBe("");
  }, 30_000);
});

/**
 * Confidential-client mode (federated-signin.md §7.4). A broker that cannot
 * serve the secret-less origin-profile contract is authenticated by a secret
 * configured *for that exact issuer* instead.
 */
describe("federated leg, confidential client", () => {
  let upstream: StubUpstream;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    upstream = await startStubUpstream();
    started = await startControlPlane(upstream.issuer, await reservePort(), {
      OPENSESAME_UPSTREAM_ISSUER: upstream.issuer,
      OPENSESAME_UPSTREAM_CLIENT_ID: STUB_CLIENT_ID,
      OPENSESAME_UPSTREAM_CLIENT_SECRET: STUB_CLIENT_SECRET,
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

    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    expect(start.status).toBe(303);
    const authorize = new URL(start.headers.get("location") ?? "");
    // The authorization request must name the configured client, not origin:.
    expect(authorize.searchParams.get("client_id")).toBe(STUB_CLIENT_ID);

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
    expect(seen.id).toBe(STUB_CLIENT_ID);
    expect(seen.secret).toBe(STUB_CLIENT_SECRET);
  }, 30_000);
});
