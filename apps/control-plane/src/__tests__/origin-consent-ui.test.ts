import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { startServer } from "../server.js";
import {
  collectConsentScopes,
  renderConsentPage,
} from "../ui/interaction-pages.js";

type Started = Awaited<ReturnType<typeof startServer>>;

const ORIGIN = "http://127.0.0.1:4101";
const CLIENT_ID = `origin:${ORIGIN}`;
const REDIRECT_URI = `${ORIGIN}/opensesame/callback`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authUrl(
  port: number,
  challenge: string,
  overrides: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid",
    state: "s-1",
    nonce: "n-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...overrides,
  });
  return `/auth?${params.toString()}`;
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

  header(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }
}

async function startOriginServer(): Promise<Started> {
  const { startServer: start } = await import("../server.js");
  return start({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicUrl: "http://127.0.0.1:0",
      issuer: "http://127.0.0.1:0",
    },
    processEnv: {
      ...process.env,
      OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
    },
  });
}

async function stop(started: Started): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    started.server.close((err) => (err ? reject(err) : resolve()));
  });
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("not a jwt");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function extractCsrf(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error("no csrf token in page");
  return match[1];
}

async function req(
  started: Started,
  jar: Jar,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith("http")
    ? path
    : `http://127.0.0.1:${started.port}${path}`;
  const res = await fetch(url, {
    redirect: "manual",
    ...init,
    headers: { ...jar.header(), ...(init.headers as Record<string, string>) },
  });
  jar.absorb(res);
  return res;
}

function postForm(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  };
}

/** Drive /auth to the login interaction page. */
async function beginAuth(
  started: Started,
  jar: Jar,
  challenge: string,
  overrides: Record<string, string> = {},
): Promise<{ uid: string; html: string }> {
  const res = await req(
    started,
    jar,
    authUrl(started.port, challenge, overrides),
  );
  expect(res.status).toBe(303);
  const location = res.headers.get("location") ?? "";
  expect(location).toMatch(/^\/interaction\//);
  const uid = location.slice("/interaction/".length);
  const page = await req(started, jar, location);
  expect(page.status).toBe(200);
  const html = await page.text();
  return { uid, html };
}

/** From the login page: start a provisional session and land on the consent page. */
async function loginAndConsent(
  started: Started,
  jar: Jar,
  uid: string,
  loginHtml: string,
): Promise<{ uid: string; html: string }> {
  const csrf = extractCsrf(loginHtml);
  const login = await req(
    started,
    jar,
    `/interaction/${uid}/login`,
    postForm({ _csrf: csrf, action: "start" }),
  );
  expect(login.status).toBe(303);
  const resume = login.headers.get("location") ?? "";
  expect(resume).toContain("/auth/");

  const resumed = await req(started, jar, resume);
  expect(resumed.status).toBe(303);
  const consentLocation = resumed.headers.get("location") ?? "";
  // Consent is a fresh interaction with its own uid.
  expect(consentLocation).toMatch(/\/interaction\//);
  const consentUid = consentLocation.split("/interaction/")[1] ?? "";

  const page = await req(started, jar, consentLocation);
  expect(page.status).toBe(200);
  return { uid: consentUid, html: await page.text() };
}

/** From the consent page: confirm and follow to the client's redirect_uri. */
async function confirmAndCode(
  started: Started,
  jar: Jar,
  uid: string,
  consentHtml: string,
): Promise<string> {
  const csrf = extractCsrf(consentHtml);
  const confirm = await req(
    started,
    jar,
    `/interaction/${uid}/confirm`,
    postForm({ _csrf: csrf }),
  );
  expect(confirm.status).toBe(303);
  const resume = confirm.headers.get("location") ?? "";
  const done = await req(started, jar, resume);
  expect(done.status).toBe(303);
  const final = done.headers.get("location") ?? "";
  expect(final).not.toContain("/interaction/");
  return final;
}

describe("origin consent UI (ADR 0050 slice 3c, F6)", () => {
  it("runs the full login + consent flow and issues a code from the exact origin", async () => {
    const started = await startOriginServer();
    try {
      const jar = new Jar();
      const { verifier, challenge } = pkce();

      // GET /auth → 303 → login page (no session yet).
      const { uid, html: loginHtml } = await beginAuth(started, jar, challenge);
      expect(loginHtml).toContain("Start a session");

      // POST login → consent page: exact canonical origin + F6 badge.
      const consent = await loginAndConsent(started, jar, uid, loginHtml);
      expect(consent.html).toContain(`<code>${ORIGIN}</code>`);
      expect(consent.html).toContain("Automatically admitted application");
      expect(consent.html).toContain('role="status"');
      expect(consent.html).toContain("<code>openid</code>");

      // POST confirm → code redirect.
      const final = await confirmAndCode(
        started,
        jar,
        consent.uid,
        consent.html,
      );
      const finalUrl = new URL(final);
      expect(finalUrl.origin).toBe(ORIGIN);
      expect(finalUrl.pathname).toBe("/opensesame/callback");
      expect(finalUrl.searchParams.get("state")).toBe("s-1");
      const code = finalUrl.searchParams.get("code");
      expect(code).toBeTruthy();

      // Consent is remembered durably for the minted principal.
      const token = jar.get("os_provisional");
      expect(token).toBeTruthy();
      const sessionId = started.ctx.stores.provisionalTokens.get(token ?? "");
      const principalId = sessionId
        ? started.ctx.stores.provisionalSessions.get(sessionId)?.principalId
        : undefined;
      expect(principalId).toBeTruthy();
      const remembered = await started.ctx.stores.consents.findActive(
        principalId ?? "",
        CLIENT_ID,
      );
      expect(remembered?.scopes).toEqual(["openid"]);
      expect(remembered?.revokedAt).toBeUndefined();

      // The code exchanges from the exact persisted origin (F3) with a
      // truthful pairwise sub for the session's account.
      const tokenRes = await fetch(`http://127.0.0.1:${started.port}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: code ?? "",
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      });
      expect(tokenRes.status).toBe(200);
      const tokens = (await tokenRes.json()) as { id_token: string };
      const payload = decodeJwtPayload(tokens.id_token);
      expect(payload.aud).toBe(CLIENT_ID);
      expect(payload.sub).not.toBe(principalId);
    } finally {
      await stop(started);
    }
  });

  it("continues with an existing session instead of minting a new principal", async () => {
    const started = await startOriginServer();
    try {
      // An authenticated browser: provisional session from the public route.
      const provisional = await started.app.request(
        "/v1/principals/provisional",
        {
          method: "POST",
        },
      );
      expect(provisional.status).toBe(201);
      const { accessToken, principalId } = (await provisional.json()) as {
        accessToken: string;
        principalId: string;
      };

      const jar = new Jar();
      jar.absorb(
        new Response(null, {
          headers: { "set-cookie": `os_provisional=${accessToken}; Path=/` },
        }),
      );

      const { challenge } = pkce();
      const { uid, html } = await beginAuth(started, jar, challenge);
      expect(html).toContain(`Signed in as <code>${principalId}</code>`);

      // Cookie-authenticated POSTs must also carry the deployment's Origin.
      const csrf = extractCsrf(html);
      const loginInit = postForm({ _csrf: csrf, action: "continue" });
      const login = await req(started, jar, `/interaction/${uid}/login`, {
        ...loginInit,
        headers: {
          ...(loginInit.headers as Record<string, string>),
          origin: "http://127.0.0.1:0",
        },
      });
      expect(login.status).toBe(303);

      const consent = await (async () => {
        const resumed = await req(
          started,
          jar,
          login.headers.get("location") ?? "",
        );
        const consentLocation = resumed.headers.get("location") ?? "";
        const page = await req(started, jar, consentLocation);
        return {
          uid: consentLocation.split("/interaction/")[1] ?? "",
          html: await page.text(),
        };
      })();
      const final = await confirmAndCode(
        started,
        jar,
        consent.uid,
        consent.html,
      );
      expect(new URL(final).searchParams.get("code")).toBeTruthy();

      // Consent landed on the pre-existing principal, not a new one.
      const remembered = await started.ctx.stores.consents.findActive(
        principalId,
        CLIENT_ID,
      );
      expect(remembered?.scopes).toEqual(["openid"]);
    } finally {
      await stop(started);
    }
  });

  it("redirects aborts back to the client with access_denied", async () => {
    const started = await startOriginServer();
    try {
      const jar = new Jar();
      const { challenge } = pkce();
      const { uid, html: loginHtml } = await beginAuth(started, jar, challenge);
      const consent = await loginAndConsent(started, jar, uid, loginHtml);

      const csrf = extractCsrf(consent.html);
      const abort = await req(
        started,
        jar,
        `/interaction/${consent.uid}/abort`,
        postForm({ _csrf: csrf }),
      );
      expect(abort.status).toBe(303);
      const done = await req(started, jar, abort.headers.get("location") ?? "");
      expect(done.status).toBe(303);
      const final = new URL(done.headers.get("location") ?? "");
      expect(final.origin).toBe(ORIGIN);
      expect(final.searchParams.get("error")).toBe("access_denied");
      expect(final.searchParams.get("state")).toBe("s-1");
      expect(final.searchParams.get("code")).toBeNull();
    } finally {
      await stop(started);
    }
  });

  it("rejects interaction POSTs without a valid CSRF token", async () => {
    const started = await startOriginServer();
    try {
      const jar = new Jar();
      const { challenge } = pkce();
      const res = await req(started, jar, authUrl(started.port, challenge));
      const location = res.headers.get("location") ?? "";
      const uid = location.slice("/interaction/".length);

      for (const verb of ["login", "confirm", "abort"]) {
        const noToken = await req(
          started,
          jar,
          `/interaction/${uid}/${verb}`,
          postForm({ action: "start" }),
        );
        expect(noToken.status).toBe(403);
        const wrongToken = await req(
          started,
          jar,
          `/interaction/${uid}/${verb}`,
          postForm({ _csrf: "forged", action: "start" }),
        );
        expect(wrongToken.status).toBe(403);
      }
    } finally {
      await stop(started);
    }
  });

  it("answers 401 login_required for an unauthenticated continue", async () => {
    const started = await startOriginServer();
    try {
      const jar = new Jar();
      const { challenge } = pkce();
      const { uid, html } = await beginAuth(started, jar, challenge);
      const csrf = extractCsrf(html);
      const res = await req(
        started,
        jar,
        `/interaction/${uid}/login`,
        postForm({ _csrf: csrf, action: "continue" }),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "login_required" });
    } finally {
      await stop(started);
    }
  });

  it("shows no auto-admitted badge for claimed origin or pre_registered clients", async () => {
    const started = await startOriginServer();
    try {
      // Claimed origin client: admit it, then flip ownership status as the
      // F5 claim flow would (3b) — store-level to keep the test focused.
      const jar = new Jar();
      const { challenge } = pkce();
      const first = await req(started, jar, authUrl(started.port, challenge));
      expect(first.status).toBe(303);
      const record = await started.ctx.oauth.clientStore.findById(CLIENT_ID);
      expect(record).toBeDefined();
      if (record) {
        await started.ctx.oauth.clientStore.update({
          ...record,
          ownershipStatus: "claimed",
        });
      }
      const { uid, html: loginHtml } = await beginAuth(started, jar, challenge);
      const { html: consentHtml } = await loginAndConsent(
        started,
        jar,
        uid,
        loginHtml,
      );
      expect(consentHtml).toContain(`<code>${ORIGIN}</code>`);
      expect(consentHtml).not.toContain("Automatically admitted application");

      // Pre_registered client: no origin, no badge.
      const preRegisteredId = "preregistered-rp";
      await started.ctx.oauth.clientStore.insertAtomic({
        id: preRegisteredId,
        admissionMode: "pre_registered",
        displayName: "Registered RP",
        redirectUris: ["http://127.0.0.1:5173/callback"],
        sectorIdentifier: "https://registered-rp.example",
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        allowedScopes: ["openid"],
        allowedResources: [],
        state: "active",
      });
      const jar2 = new Jar();
      const second = await beginAuth(started, jar2, challenge, {
        client_id: preRegisteredId,
        redirect_uri: "http://127.0.0.1:5173/callback",
      });
      const consent2 = await loginAndConsent(
        started,
        jar2,
        second.uid,
        second.html,
      );
      expect(consent2.html).toContain("Registered RP");
      expect(consent2.html).not.toContain("Automatically admitted application");
    } finally {
      await stop(started);
    }
  });

  it("remembers consent, skips the prompt, and re-prompts on widened scope", async () => {
    const started = await startOriginServer();
    try {
      const clientId = "widening-rp";
      const redirectUri = "http://127.0.0.1:5173/callback";
      await started.ctx.oauth.clientStore.insertAtomic({
        id: clientId,
        admissionMode: "pre_registered",
        displayName: "Widening RP",
        redirectUris: [redirectUri],
        sectorIdentifier: "https://widening-rp.example",
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        allowedScopes: ["openid", "profile"],
        allowedResources: [],
        state: "active",
      });

      // First flow: consent to openid.
      const jar = new Jar();
      const { challenge } = pkce();
      const first = await beginAuth(started, jar, challenge, {
        client_id: clientId,
        redirect_uri: redirectUri,
      });
      const consent1 = await loginAndConsent(
        started,
        jar,
        first.uid,
        first.html,
      );
      const final1 = await confirmAndCode(
        started,
        jar,
        consent1.uid,
        consent1.html,
      );
      expect(new URL(final1).searchParams.get("code")).toBeTruthy();

      // Second /auth, same covered scope: no interaction at all.
      const second = await req(
        started,
        jar,
        authUrl(started.port, challenge, {
          client_id: clientId,
          redirect_uri: redirectUri,
          nonce: "n-2",
        }),
      );
      expect(second.status).toBe(303);
      const secondLocation = second.headers.get("location") ?? "";
      expect(secondLocation).not.toContain("/interaction/");
      expect(secondLocation.startsWith(redirectUri)).toBe(true);
      expect(new URL(secondLocation).searchParams.get("code")).toBeTruthy();

      // Widened scope: the consent prompt re-appears and lists the new scope.
      const third = await req(
        started,
        jar,
        authUrl(started.port, challenge, {
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "openid profile",
          nonce: "n-3",
        }),
      );
      expect(third.status).toBe(303);
      const thirdLocation = third.headers.get("location") ?? "";
      expect(thirdLocation).toMatch(/^\/interaction\//);
      const uid = thirdLocation.slice("/interaction/".length);
      const page = await req(started, jar, thirdLocation);
      const html = await page.text();
      expect(html).toContain("<code>profile</code>");

      const final3 = await confirmAndCode(started, jar, uid, html);
      expect(new URL(final3).searchParams.get("code")).toBeTruthy();

      // The durable record widened rather than duplicated.
      const sessionId = started.ctx.stores.provisionalTokens.get(
        jar.get("os_provisional") ?? "",
      );
      const principalId = sessionId
        ? started.ctx.stores.provisionalSessions.get(sessionId)?.principalId
        : undefined;
      const remembered = await started.ctx.stores.consents.findActive(
        principalId ?? "",
        clientId,
      );
      expect(remembered?.scopes).toEqual(["openid", "profile"]);
      expect(remembered?.version).toBe(2);
    } finally {
      await stop(started);
    }
  });
});

describe("interaction pages", () => {
  it("escapes the origin and omits the badge when not auto-admitted", () => {
    const html = renderConsentPage({
      uid: "u1",
      csrfToken: "t",
      confirmAction: "/interaction/u1/confirm",
      abortAction: "/interaction/u1/abort",
      origin: 'https://"><script>alert(1)</script>',
      showAutoAdmitted: false,
      scopes: ["openid"],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("Automatically admitted application");
  });

  it("collects scopes from params and missingOIDCScope", () => {
    expect(collectConsentScopes("openid profile", ["email"])).toEqual([
      "email",
      "openid",
      "profile",
    ]);
  });
});
