import { isString, overlapCast } from "@opensesame/os-domain";
import { createHostedClient } from "@opensesame/static-auth";
import { decodeJwt } from "jose";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";
import { hopUrl } from "./upstream-hop.js";

type Started = Awaited<ReturnType<typeof startServer>>;
const RP_ORIGIN = "http://127.0.0.1:4101";
const CALLBACK = `${RP_ORIGIN}/opensesame/callback`;
const CLIENT_ID = `origin:${RP_ORIGIN}`;
const wireFetch = globalThis.fetch;

class BrowserStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

/** Cookies belong only to the Identity navigation, never the SDK token call. */
class IdentityNavigation {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set(
      "cookie",
      [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    );
    const response = await wireFetch(new URL(path, this.base), {
      ...init,
      redirect: "manual",
      headers,
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    return response;
  }
}

function form(html: string, action?: string): RequestInit {
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("Expected real interaction CSRF field");
  const body = new URLSearchParams({ _csrf: csrf });
  if (action) body.set("action", action);
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  };
}

async function pageAfterRedirect(nav: IdentityNavigation, response: Response) {
  expect(response.status).toBe(303);
  const path = response.headers.get("location");
  expect(path).toMatch(/\/interaction\//);
  if (!path) throw new Error("Missing interaction redirect");
  const page = await nav.request(path);
  expect(page.status).toBe(200);
  return { path, html: await page.text() };
}

/** Real first-party guest login and human consent, with no provider model seams. */
async function authorize(base: string, authorizationUrl: string) {
  const nav = new IdentityNavigation(base);
  const login = await pageAfterRedirect(
    nav,
    await nav.request(authorizationUrl),
  );
  const started = await nav.request(
    `${login.path}/login`,
    form(login.html, "start"),
  );
  const consent = await pageAfterRedirect(
    nav,
    await nav.request(await hopUrl(started)),
  );
  expect(consent.html).toContain(`<code>${RP_ORIGIN}</code>`);
  const confirmed = await nav.request(
    `${consent.path}/confirm`,
    form(consent.html),
  );
  const redirect = await nav.request(await hopUrl(confirmed));
  expect(redirect.status).toBe(303);
  const callback = new URL(redirect.headers.get("location") ?? "");
  expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK);
  expect(callback.searchParams.get("code")).toBeTruthy();
  return callback;
}

function browserClient(base: string) {
  const storage = new BrowserStorage();
  const location = {
    origin: RP_ORIGIN,
    href: CALLBACK,
    assign: vi.fn((url: string) => {
      location.href = url;
    }),
  };
  const history = {
    replaceState: vi.fn((_state: null, _unused: string, url: string) => {
      location.href = url;
    }),
  };
  const client = createHostedClient(
    {
      profile: "hosted_identity",
      issuer: base,
      clientId: CLIENT_ID,
      redirectUri: CALLBACK,
      authorizationEndpoint: `${base}/auth`,
      tokenEndpoint: `${base}/token`,
      jwksUri: `${base}/jwks`,
    },
    overlapCast({ location, history }),
    storage,
  );
  return { client, storage, location, history };
}

function browserTransport(base: string) {
  const calls: { path: string; status: number }[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(base);
      expect(["/token", "/jwks"]).toContain(url.pathname);
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      headers.set("origin", RP_ORIGIN);
      const response = await wireFetch(input, { ...init, headers });
      calls.push({ path: url.pathname, status: response.status });
      if (url.pathname === "/token" && response.ok) {
        const tokens = await response.clone().json();
        if (!isString(tokens.id_token))
          throw new Error("Missing Identity ID token");
        const claims = decodeJwt(tokens.id_token);
        expect(claims.aud).toBe(CLIENT_ID);
        expect(claims.iss).toBe(base);
        expect(isString(claims.nonce)).toBe(true);
      }
      // Node fetch does not implement CORS: enforce the browser response boundary.
      expect(response.headers.get("access-control-allow-origin")).toBe(
        RP_ORIGIN,
      );
      return response;
    },
  );
  return calls;
}

describe("hosted static SDK against real Identity HTTP and signing", () => {
  let started: Started;
  let base: string;
  beforeAll(async () => {
    const { startServer: start } = await import("../server.js");
    started = await onFreePort((port) =>
      start({
        config: {
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
        processEnv: {
          ...process.env,
          OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;
  }, 30000);
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (!started) return;
    await new Promise<void>((resolve, reject) =>
      started.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("completes RP-audienced code+S256+nonce verification and refuses server code replay", async () => {
    const browser = browserClient(base);
    await browser.client.begin();
    const authorization = new URL(browser.location.href);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const callback = await authorize(base, authorization.href);
    expect(callback.searchParams.get("state")).toBe(
      authorization.searchParams.get("state"),
    );
    expect(callback.searchParams.get("iss")).toBe(base);
    const pending = [...browser.storage.values];
    const calls = browserTransport(base);
    browser.location.href = callback.href;
    const session = await browser.client.complete();
    expect(session?.subject).toBeTruthy();
    expect(session?.expiresAt).toBeGreaterThan(Date.now());
    expect(calls).toEqual([
      { path: "/token", status: 200 },
      { path: "/jwks", status: 200 },
    ]);
    expect(browser.location.href).toBe(CALLBACK);
    expect(browser.storage.values.size).toBe(0);
    // Restore only the RP transaction to independently exercise Identity's spent code.
    for (const [key, value] of pending) browser.storage.setItem(key, value);
    browser.location.href = callback.href;
    await expect(browser.client.complete()).rejects.toThrow(
      "verification_failed",
    );
    expect(calls.at(-1)).toEqual({ path: "/token", status: 400 });
  });

  it("rejects a real signed ID token carrying the wrong transaction nonce", async () => {
    const browser = browserClient(base);
    await browser.client.begin();
    const authorization = new URL(browser.location.href);
    authorization.searchParams.set("nonce", "wrong-transaction-nonce");
    const callback = await authorize(base, authorization.href);
    const calls = browserTransport(base);
    browser.location.href = callback.href;
    await expect(browser.client.complete()).rejects.toThrow("invalid_claims");
    expect(calls).toEqual([
      { path: "/token", status: 200 },
      { path: "/jwks", status: 200 },
    ]);
    expect(browser.storage.values.size).toBe(0);
    expect(browser.location.href).toBe(CALLBACK);
  });

  it.each(["iss", "state"])(
    "refuses a wrong callback %s before token exchange",
    async (parameter) => {
      const browser = browserClient(base);
      await browser.client.begin();
      const callback = await authorize(base, browser.location.href);
      callback.searchParams.set(parameter, "https://wrong.example");
      const calls = browserTransport(base);
      browser.location.href = callback.href;
      await expect(browser.client.complete()).rejects.toThrow(
        "invalid_callback",
      );
      expect(calls).toEqual([]);
      expect(browser.storage.values.size).toBe(0);
      expect(browser.location.href).toBe(CALLBACK);
    },
  );
});
