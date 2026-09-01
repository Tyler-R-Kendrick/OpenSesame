import { createHash, randomBytes } from "node:crypto";
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
import { onFreePort } from "./free-port.js";
import { hopUrl } from "./upstream-hop.js";

type Started = Awaited<ReturnType<typeof startServer>>;
/** The fields the hosted login page's federated forms actually post. */
type FederatedStartForm = {
  _csrf: string;
  /** Registry id (C10) — wins over `issuer` when both are present. */
  provider?: string;
  issuer?: string;
};
type FederatedTestEnvironment = {
  OPENSESAME_UPSTREAM_ISSUER?: string;
  OPENSESAME_UPSTREAM_CLIENT_ID?: string;
  OPENSESAME_UPSTREAM_CLIENT_SECRET?: string;
};
type LoginPageResult = { jar: Jar; uid: string; html: string };
/** The parsed `form_post` response body: where it posts, and what it carries. */
type AutoSubmitForm = { action: string; fields: FormPostFields };
type FormPostFields = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
};
type SignInOutcome = { principalId: string; cookie: string };
type StartedLeg = { jar: Jar; uid: string; form: URL };

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
function parseAutoSubmitForm(html: string): AutoSubmitForm {
  const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1] ?? "";
  const fields: FormPostFields = {};
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
      // Honest: the broker is named beside the account kind it fronts.
      label: "Google (via shoo.dev)",
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
      Buffer.from(JSON.stringify({ ...pending, kind: "saml" })).toString(
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

  it("folds everything but the hinted provider behind a script-free collapse", () => {
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
    const details = html.indexOf('<details class="more-options">');
    expect(details).toBeGreaterThan(-1);
    expect(html).toContain("<summary>More sign-in options</summary>");
    // The hinted provider is the page; everything else waits inside.
    expect(html.indexOf("Sign in with Google")).toBeLessThan(details);
    expect(html.indexOf("Sign in with a local test account")).toBeGreaterThan(
      details,
    );
    expect(html.indexOf("Start a session")).toBeGreaterThan(details);
  });

  it("keeps the full page, banner first, after an upstream refusal", () => {
    const html = renderLoginPage({
      ...base,
      error:
        "The provider reported: access was denied. Try again, or choose another way in.",
      federated: {
        startAction: "/interaction/u1/federated/start",
        upstreams: [
          { issuer: "http://127.0.0.1:9090", label: "a local test account" },
          { issuer: "https://shoo.dev", label: "Google" },
        ],
        preferredIssuer: "https://shoo.dev",
      },
    });
    // A person choosing again needs every exit visible: no focused collapse —
    // each method stands as its own named card instead of one giant form.
    expect(html).not.toContain('class="more-options"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("access was denied");
    expect(html.indexOf("access was denied")).toBeLessThan(
      html.indexOf("Sign in with Google"),
    );
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
    started = await onFreePort((port) =>
      startControlPlane(upstream.issuer, port),
    );
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
    const target = new URL(await hopUrl(res));
    expect(target.origin).toBe(upstream.issuer);
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("state")).toBeTruthy();
    expect(target.searchParams.get("nonce")).toBeTruthy();
    expect(target.searchParams.get("client_id")).toBe(`origin:${base}`);
    // The stable, deployment-wide callback (ADR 0055) — a registry provider's
    // redirect URI is registered once and matched byte for byte, so it cannot
    // name an interaction. The uid rides in `state` instead, which is how the
    // shared callback hands the browser back to this interaction.
    expect(target.searchParams.get("redirect_uri")).toBe(
      `${base}/v1/federated/callback`,
    );
    expect(target.searchParams.get("state")).toMatch(
      new RegExp(`^${uid}\\..+`),
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
    expect(new URL(await hopUrl(res)).origin).toBe(upstream.issuer);
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

  it("sends a refusal back to the login page, named as a coded banner", async () => {
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
    // The code (never the upstream's free text) rides along so the page can
    // say what happened instead of silently looking like a broken button.
    expect(res.headers.get("location")).toBe(
      `/interaction/${uid}?fed_error=access_denied`,
    );
    const page = await req(
      base,
      jar,
      `/interaction/${uid}?fed_error=access_denied`,
    );
    const body = await page.text();
    expect(body).toContain('role="alert"');
    expect(body).toContain("access was denied");
  });

  it("rejects a callback whose state does not match the pending cookie", async () => {
    const { jar, uid, html } = await loginPage();
    const start = await req(
      base,
      jar,
      `/interaction/${uid}/federated/start`,
      postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
    );
    const authorize = new URL(await hopUrl(start));
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
    const authorize = new URL(await hopUrl(start));
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
    const authorize = new URL(await hopUrl(start));
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
    const authorize = new URL(await hopUrl(start));
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

    async function signIn(): Promise<SignInOutcome> {
      const { jar, uid, html } = await loginPage();
      const start = await req(
        base,
        jar,
        `/interaction/${uid}/federated/start`,
        postForm({ _csrf: extractCsrf(html), issuer: upstream.issuer }),
      );
      const authorize = new URL(await hopUrl(start));
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
    started = await onFreePort((port) =>
      startControlPlane(upstream.issuer, port),
    );
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
    const authorize = new URL(await hopUrl(start));
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
  /**
   * A tenant IdP shaped like a real one: it issues client credentials, refuses
   * an `origin:` client id outright, and matches its registered redirect URIs
   * byte for byte. Okta, Entra, Google Workspace and Auth0 all behave this way
   * and none of them accept the origin-profile mode a broker does.
   */
  let enterpriseIdp: ReferenceIdp;
  let started: Started;
  let base: string;
  const organizationId = "org_jit_test";
  const enterpriseOrgId = "org_enterprise_test";

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    allowlisted = await startReferenceIdp();
    tenantIdp = await startReferenceIdp();
    enterpriseIdp = await startReferenceIdp({ clientMode: "confidential" });
    started = await onFreePort((port) =>
      startControlPlane(allowlisted.issuer, port),
    );
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
    await started.ctx.stores.organizations.set(enterpriseOrgId, {
      id: enterpriseOrgId,
      slug: "enterprise",
      displayName: "Enterprise",
      state: "active",
      createdBy: "prn_seed_owner",
      createdAt: now,
      updatedAt: now,
      ssoIssuer: enterpriseIdp.issuer,
      ssoClientId: enterpriseIdp.clientId,
      ssoClientSecret: enterpriseIdp.clientSecret,
    });
    // One registered redirect URI, set once and never touched again — exactly
    // what a tenant admin types into their console.
    enterpriseIdp.setRedirectUris([`${base}/v1/federated/callback`]);
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await allowlisted.close();
    await tenantIdp.close();
    await enterpriseIdp.close();
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
    // The organization is what vouched for this issuer, and the cookie says so.
    expect(decodePending(jar.get(`os.fed.${uid}`))?.orgId).toBe(organizationId);

    const authorize = new URL(await hopUrl(start));
    // A tenant admin registers one redirect URI in their IdP's console, and
    // Okta, Entra and Google Workspace match it byte for byte. It must
    // therefore name no interaction (ADR 0055).
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${base}/v1/federated/callback`,
    );
    expect(authorize.searchParams.get("state")).toMatch(
      new RegExp(`^${uid}\\..+`),
    );

    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    expect(back.pathname).toBe("/v1/federated/callback");

    // Followed as a browser would: the shared callback hands back to a
    // top-level GET under /interaction/<uid>, and that request finishes.
    const handBack = await req(base, jar, `${back.pathname}${back.search}`);
    expect(handBack.status).toBe(303);
    const res = await req(base, jar, handBack.headers.get("location") ?? "");
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

  /**
   * Enterprise SSO against an IdP that behaves like a real one.
   *
   * This is the test that was missing, and both defects it covers were live:
   * the leg presented an `origin:` client id no enterprise IdP has ever heard
   * of, and it redirected to a URI naming the interaction, which such an IdP
   * matches byte for byte and would only ever have seen once. Nothing caught
   * either, because the permissive reference IdP accepted both.
   *
   * Signing in TWICE is the point. One sign-in passes under a per-interaction
   * URI if the IdP is told about it; the second is the one a tenant admin
   * would have hit on day one, having registered exactly one URI.
   */
  it("signs a tenant in through their own IdP, twice, on registered credentials", async () => {
    const subject = `ent-${randomBytes(4).toString("hex")}`;
    enterpriseIdp.setSubject(subject);

    // Inferred rather than annotated: the shape is one helper's own.
    async function signIn() {
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
        postForm({ _csrf: extractCsrf(html), issuer: enterpriseIdp.issuer }),
      );
      const authorize = new URL(await hopUrl(start));

      // The credentials the tenant registered, not our origin profile.
      expect(authorize.searchParams.get("client_id")).toBe(
        enterpriseIdp.clientId,
      );
      expect(authorize.searchParams.get("client_id")).not.toContain("origin:");
      expect(authorize.searchParams.get("redirect_uri")).toBe(
        `${base}/v1/federated/callback`,
      );

      // A 302 is this IdP accepting both. It answers `invalid_client` to an
      // origin-profile client id and `invalid_redirect_uri` to any URI outside
      // the one registered above, so reaching here proves both.
      const upstream = await fetch(authorize, { redirect: "manual" });
      expect(upstream.status).toBe(302);
      const back = new URL(upstream.headers.get("location") ?? "");
      const handBack = await req(base, jar, `${back.pathname}${back.search}`);
      expect(handBack.status).toBe(303);
      const completed = await req(
        base,
        jar,
        handBack.headers.get("location") ?? "",
      );
      expect(completed.status).toBe(303);
      expect(completed.headers.get("location")).toContain("/auth/");
      return uid;
    }

    const firstUid = await signIn();
    const secondUid = await signIn();
    expect(secondUid).not.toBe(firstUid);

    // A confidential client sees the IdP's canonical subject, and both
    // sign-ins landed on the one principal and the one membership.
    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
      issuer: enterpriseIdp.issuer,
      subject,
    });
    expect(identity).toBeTruthy();
    const membership = await started.ctx.stores.organizationMemberships.find(
      enterpriseOrgId,
      identity?.principalId ?? "",
    );
    expect(membership?.role).toBe("member");
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
    first = await onFreePort((port) =>
      startControlPlane(upstream.issuer, port),
    );
    second = await onFreePort((port) =>
      startControlPlane(upstream.issuer, port),
    );
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
    const authorize = new URL(await hopUrl(start));
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
    started = await onFreePort((port) => {
      // What an operator registers in a provider console: ONE redirect URI, for
      // the whole deployment, matched byte for byte (ADR 0055). Nothing here
      // names an interaction, and nothing is re-registered between sign-ins.
      //
      // Registered inside the retry: a port lost between probing and binding
      // takes its callback URI with it, and re-registering the old one would
      // point the upstream at a server that is not there.
      upstream.setRedirectUris([
        `http://127.0.0.1:${port}/v1/federated/callback`,
      ]);
      return startControlPlane(upstream.issuer, port, {
        OPENSESAME_UPSTREAM_ISSUER: upstream.issuer,
        OPENSESAME_UPSTREAM_CLIENT_ID: upstream.clientId,
        OPENSESAME_UPSTREAM_CLIENT_SECRET: upstream.clientSecret,
      });
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

  /**
   * One complete sign-in, through the callback a real provider would have.
   *
   * The browser is followed the whole way — authorize, the upstream's redirect
   * to the STABLE callback, the 303 hand-back, and the top-level GET under
   * `/interaction/:uid` that carries the interaction cookie — rather than
   * short-cutting to the interaction callback, because the hand-back is the
   * part that makes one registered URI serve every interaction.
   */
  async function signInOnce() {
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
    const authorize = new URL(await hopUrl(start));
    // The authorization request must name the configured client, not origin:.
    expect(authorize.searchParams.get("client_id")).toBe(upstream.clientId);
    // The registered URI, not this interaction's path.
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${base}/v1/federated/callback`,
    );
    expect(authorize.searchParams.get("state")).toMatch(
      new RegExp(`^${uid}\\..+`),
    );

    // A 302 is the IdP accepting the redirect URI as registered; an exact-match
    // provider handed a per-interaction path answers 400 here instead.
    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    expect(upstreamRes.status).toBe(302);
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    expect(back.pathname).toBe("/v1/federated/callback");

    const handBack = await req(base, jar, `${back.pathname}${back.search}`);
    expect(handBack.status).toBe(303);
    const resume = handBack.headers.get("location") ?? "";
    expect(resume.startsWith(`/interaction/${uid}/federated/callback?`)).toBe(
      true,
    );

    const res = await req(base, jar, resume);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/auth/");
    return { uid, jar };
  }

  it("authenticates with the configured secret, not a derived origin", async () => {
    upstream.setSubject(`conf-${randomBytes(4).toString("hex")}`);
    await signInOnce();

    const seen = upstream.tokenClientSeen();
    expect(seen.id).toBe(upstream.clientId);
    expect(seen.secret).toBe(upstream.clientSecret);
    // T10: a confidential exchange must NOT claim a browser origin. The
    // reference IdP answers `origin_cors_denied` to one that does, so the
    // 303 above already proves it — this pins the intent.
    expect(upstream.tokenOriginSeen()).toBeUndefined();
  }, 30_000);

  /**
   * The reason the callback moved (ADR 0055).
   *
   * Google, Entra and Apple match a registered redirect URI byte for byte, and
   * a URI is registered once. Two sign-ins on two different interactions
   * against ONE registered URI is therefore the whole claim: with the callback
   * under `/interaction/:uid` the second `/authorize` here answers 400
   * `invalid_redirect_uri`, and no amount of retrying fixes it.
   */
  it("completes twice across two interactions against one registered URI", async () => {
    const subject = `conf-reentry-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(subject);

    const first = await signInOnce();
    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
      issuer: upstream.issuer,
      subject,
    });
    expect(identity?.assurance).toBe("verified");

    const second = await signInOnce();
    expect(second.uid).not.toBe(first.uid);

    // The same human, one principal — the second visit found the identity row
    // rather than minting a second account beside it.
    const after = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
      issuer: upstream.issuer,
      subject,
    });
    expect(after?.principalId).toBe(identity?.principalId);
    // A returning identity gets no fresh provisional session (T6).
    expect(second.jar.get("os_provisional")).toBeFalsy();
  }, 45_000);
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
    started = await onFreePort((port) =>
      startControlPlane(upstream.issuer, port),
    );
    base = `http://127.0.0.1:${started.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await upstream.close();
    resetFederatedDiscoveryCache();
  });

  async function startLeg(): Promise<StartedLeg> {
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
    return { jar, uid, form: new URL(await hopUrl(start)) };
  }

  it("completes a sign-in whose response arrives as a cookie-less POST", async () => {
    const subject = `apple-${randomBytes(4).toString("hex")}`;
    upstream.setSubject(subject);
    const { jar, uid, form } = await startLeg();

    // The IdP answers the authorization request with an HTML form, not a 303.
    const authorizeRes = await fetch(form, { redirect: "manual" });
    expect(authorizeRes.status).toBe(200);
    const posted = parseAutoSubmitForm(await authorizeRes.text());
    // Apple posts to the REGISTERED redirect URI, which is the stable one
    // (ADR 0055) — its console would not accept a path naming an interaction.
    expect(posted.action).toBe(`${base}/v1/federated/callback`);
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
    const target = new URL(rematerialized.headers.get("location") ?? "", base);
    expect(target.pathname).toBe(`/interaction/${uid}/federated/callback`);
    expect(target.searchParams.get("code")).toBe(posted.fields.code);
    // Nothing was completed here: no session, no interaction result.
    expect(rematerialized.headers.getSetCookie()).toEqual([]);

    // The top-level GET the 303 produces DOES carry the cookies, and that is
    // the request that finishes the sign-in.
    const completed = await req(
      base,
      jar,
      `${target.pathname}${target.search}`,
    );
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toContain("/auth/");
    expect(jar.get("os_provisional")).toBeTruthy();
  }, 30_000);

  /**
   * The stable callback is one unauthenticated URL serving every interaction,
   * so what it does with a `state` it cannot place is the whole of its
   * security: it must refuse, not guess.
   */
  describe("the stable callback", () => {
    it.each([
      ["no state at all", ""],
      ["a state naming no interaction", "state=nointeractionhere"],
      ["a state whose prefix is not an interaction id", "state=..%2Fevil.abc"],
      ["an empty uid prefix", "state=.abc"],
    ])("refuses %s", async (_label, query) => {
      const res = await fetch(`${base}/v1/federated/callback?${query}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.getSetCookie()).toEqual([]);
    });

    it("hands back only to the interaction the state names", async () => {
      const res = await fetch(
        `${base}/v1/federated/callback?state=someoneelse.abc&code=c1`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(303);
      const target = new URL(res.headers.get("location") ?? "", base);
      expect(target.pathname).toBe(
        "/interaction/someoneelse/federated/callback",
      );
      // And that interaction does not exist, so the flow dies there rather
      // than falling through to whatever interaction this browser last had.
      const followed = await fetch(target, { redirect: "manual" });
      expect(followed.status).toBe(404);
    });

    it("copies only the allowlisted response parameters", async () => {
      const res = await fetch(`${base}/v1/federated/callback`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          state: "someoneelse.abc",
          code: "c1",
          error: "e1",
          error_description: "d1",
          iss: "https://idp.example",
          // Apple posts this on first consent; it is not ours to forward.
          user: '{"name":{"firstName":"A"}}',
          id_token: "not.a.token",
          // Longer than the cap: dropped, not truncated.
          returnTo: "x".repeat(4096),
        }),
      });
      expect(res.status).toBe(303);
      const target = new URL(res.headers.get("location") ?? "", base);
      expect([...target.searchParams.keys()].sort()).toEqual([
        "code",
        "error",
        "error_description",
        "iss",
        "state",
      ]);
      // Nothing was completed here: no session, no interaction result.
      expect(res.headers.getSetCookie()).toEqual([]);
    });
  });

  it("copies only the four authorization-response parameters", async () => {
    const { uid } = await startLeg();
    const res = await fetch(`${base}/interaction/${uid}/federated/callback`, {
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
    });
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
    const res = await fetch(`${base}/interaction/${uid}/federated/callback`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: "c".repeat(4096), state: "s1" }),
    });
    expect(res.status).toBe(303);
    const target = new URL(res.headers.get("location") ?? "", base);
    expect(target.searchParams.get("code")).toBeNull();
    expect(target.searchParams.get("state")).toBe("s1");
  });
});
