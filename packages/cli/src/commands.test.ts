import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./run.js";

const ISSUER = "http://127.0.0.1:8788";
let dir = "";
let out = "";
let err = "";

const TOUCHED_ENV = [
  "OPENSESAME_STATE_DIR",
  "XDG_RUNTIME_DIR",
  "OPENSESAME_ISSUER",
  "OPENSESAME_API_URL",
] as const;

function captureStreams() {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
}

function sessionFile(): string {
  return join(dir, "identity-session.json");
}

async function writeSession(contents: JsonObject): Promise<void> {
  await writeFile(sessionFile(), JSON.stringify(contents), { mode: 0o600 });
  await chmod(sessionFile(), 0o600);
}

type Route = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response> | undefined;

/** Answers the first route that matches; anything else throws loudly. */
function routerFetch(...routes: Route[]): typeof fetch {
  return overlapCast(
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      for (const route of routes) {
        const res = await route(url, init);
        if (res) return res;
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
}

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const discoveryDoc = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  device_authorization_endpoint: `${ISSUER}/device`,
  jwks_uri: `${ISSUER}/jwks`,
};

/** Discovery + device endpoints that complete the device flow immediately. */
function deviceFlowFetch(): typeof fetch {
  return routerFetch((url) => {
    if (url.includes("openid-configuration")) return json(discoveryDoc);
    if (url.endsWith("/device")) {
      return json({
        device_code: "dc",
        user_code: "ABCD-EFGH",
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (url.endsWith("/token")) {
      return json({
        access_token: "at-device",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return undefined;
  });
}

const guestSessionBody = {
  principalId: "prn_guest",
  state: "provisional",
  assurance: "provisional",
  sessionId: "ps_1",
  accessToken: "pst_guest",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  tokenType: "Bearer",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opensesame-cli-cmd-"));
  process.env.OPENSESAME_STATE_DIR = dir;
  out = "";
  err = "";
  captureStreams();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of TOUCHED_ENV) {
    Reflect.deleteProperty(process.env, key);
  }
});

describe("runCli — help and parse failures", () => {
  it("prints help and exits 0", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(out).toContain("opensesame-id");
  });

  it("reports an unknown command on stderr and exits 1", async () => {
    expect(await runCli(["frobnicate"])).toBe(1);
    expect(err).toMatch(/Unknown command: frobnicate/);
  });

  it("reports a dispatch failure as a message, not a stack trace", async () => {
    const broken = overlapCast(
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const code = await runCli(["login", "--device", "--issuer", ISSUER], {
      fetchImpl: broken,
    });
    expect(code).toBe(1);
    expect(err).toMatch(/connection refused/);
  });
});

describe("runCli — login", () => {
  it("login --device --json prints machine-readable steps", async () => {
    const code = await runCli(
      ["login", "--device", "--json", "--issuer", ISSUER],
      { fetchImpl: deviceFlowFetch(), sleep: async () => undefined },
    );
    expect(code).toBe(0);
    expect(out).toContain('"userCode": "ABCD-EFGH"');
    expect(out).toContain('"authenticated": true');
    expect(JSON.parse(await readFile(sessionFile(), "utf8")).accessToken).toBe(
      "at-device",
    );
  });

  it("login --anonymous --json prints the guest envelope as JSON", async () => {
    const fetchImpl = routerFetch((url) =>
      url.endsWith("/v1/principals/provisional")
        ? json(guestSessionBody, 201)
        : undefined,
    );
    const code = await runCli(
      ["login", "--anonymous", "--json", "--issuer", ISSUER],
      { fetchImpl },
    );
    expect(code).toBe(0);
    expect(out).toContain('"principalId": "prn_guest"');
    expect(out).not.toContain("Signed in as guest");
  });

  it("login --anonymous tolerates an unparseable expiry", async () => {
    const fetchImpl = routerFetch((url) =>
      url.endsWith("/v1/principals/provisional")
        ? json({ ...guestSessionBody, expiresAt: "not-a-date" }, 201)
        : undefined,
    );
    const code = await runCli(["login", "--anonymous", "--issuer", ISSUER], {
      fetchImpl,
    });
    expect(code).toBe(0);
    const saved = JSON.parse(await readFile(sessionFile(), "utf8"));
    expect(saved.expiresAt).toBeUndefined();
  });

  it("login --loopback completes the code exchange over the loopback server", async () => {
    const fetchImpl = routerFetch((url, init) => {
      if (url.includes("openid-configuration")) return json(discoveryDoc);
      if (url.endsWith("/token") && init?.method === "POST") {
        return json({
          access_token: "at-loop",
          token_type: "Bearer",
          refresh_token: "rt-loop",
          id_token: "id-loop",
          expires_in: 3600,
        });
      }
      return undefined;
    });
    // Stand in for the browser: follow the authorization redirect straight back
    // to the loopback listener with a code and the state it was given.
    const openBrowser = async (url: string) => {
      const auth = new URL(url);
      const redirect = auth.searchParams.get("redirect_uri");
      const state = auth.searchParams.get("state");
      expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      await fetch(`${redirect}?code=authcode-1&state=${state}`);
    };
    const code = await runCli(["login", "--loopback", "--issuer", ISSUER], {
      fetchImpl,
      openBrowser,
    });
    expect(code).toBe(0);
    expect(out).toMatch(/Logged in via loopback/);
    const saved = JSON.parse(await readFile(sessionFile(), "utf8"));
    expect(saved.accessToken).toBe("at-loop");
    expect(saved.refreshToken).toBe("rt-loop");
    expect(saved.idToken).toBe("id-loop");
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("runCli — auth status", () => {
  it("reports authenticated with a live session", async () => {
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
    });
    const fetchImpl = routerFetch((url) =>
      url.endsWith("/v1/principals/me") ? json({ id: "p-1" }) : undefined,
    );
    const code = await runCli(["auth", "status", "--issuer", ISSUER], {
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(out).toMatch(/Authenticated\./);
  });

  it("reports not authenticated without a session, and never calls out", async () => {
    const fetchImpl = routerFetch();
    const code = await runCli(["auth", "status", "--issuer", ISSUER], {
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(out).toMatch(/Not authenticated\./);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("runCli — logout", () => {
  it("clears the local file even when there is no session to revoke", async () => {
    const fetchImpl = routerFetch();
    const code = await runCli(["logout", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(0);
    expect(out).toMatch(/Signed out\./);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears the local file even when the server-side revoke fails", async () => {
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
    });
    const fetchImpl = routerFetch((url) =>
      url.endsWith("/v1/principals/provisional/revoke")
        ? new Response("nope", { status: 500 })
        : undefined,
    );
    const code = await runCli(["logout", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(0);
    expect(out).toMatch(/Signed out\./);
    await expect(readFile(sessionFile(), "utf8")).rejects.toThrow();
  });
});

describe("runCli — whoami", () => {
  it("treats an unreadable session file as logged out", async () => {
    await writeFile(sessionFile(), "{ not json", { mode: 0o600 });
    await chmod(sessionFile(), 0o600);
    const fetchImpl = routerFetch();
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(1);
    expect(out).toMatch(/Not authenticated/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints the principal as redacted JSON", async () => {
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
    });
    const fetchImpl = routerFetch((url) =>
      url.endsWith("/v1/principals/me")
        ? json({ id: "p-1", access_token: "should-be-redacted" })
        : undefined,
    );
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(0);
    expect(out).toContain('"id": "p-1"');
    expect(out).not.toContain("should-be-redacted");
  });
});

describe("runCli — project create", () => {
  it("requires a session", async () => {
    const code = await runCli(
      ["project", "create", "--temporary", "--issuer", ISSUER],
      { fetchImpl: routerFetch() },
    );
    expect(code).toBe(1);
    expect(err).toMatch(/Login required/);
  });

  it("refuses non-temporary projects in this slice", async () => {
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
    });
    const code = await runCli(["project", "create", "--issuer", ISSUER], {
      fetchImpl: routerFetch(),
    });
    expect(code).toBe(1);
    expect(err).toMatch(/Only --temporary projects/);
  });

  it("creates a temporary project under the session's principal", async () => {
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
    });
    const seen: Array<{ auth: string | null; body: unknown }> = [];
    const fetchImpl = routerFetch((url, init) => {
      if (url.endsWith("/v1/projects/temporary")) {
        seen.push({
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return json({ id: "prj_1", name: "demo" }, 201);
      }
      return undefined;
    });
    const code = await runCli(
      [
        "project",
        "create",
        "--temporary",
        "--name",
        "demo",
        "--issuer",
        ISSUER,
      ],
      { fetchImpl },
    );
    expect(code).toBe(0);
    expect(out).toMatch(/Temporary project created/);
    expect(seen).toEqual([{ auth: "Bearer at-1", body: { name: "demo" } }]);
  });
});

describe("runCli — claim poll", () => {
  it("sends the claim bearer on the claim path only", async () => {
    const seen: Array<{ path: string; claim: string | null }> = [];
    const fetchImpl = routerFetch((url, init) => {
      if (url.includes("/v1/claims/")) {
        seen.push({
          path: new URL(url).pathname,
          claim: new Headers(init?.headers).get("x-claim-token"),
        });
        return json({ status: "pending" });
      }
      return undefined;
    });
    const code = await runCli(
      ["claim", "poll", "clm_1", "--token", "osc_clm_abc", "--issuer", ISSUER],
      { fetchImpl },
    );
    expect(code).toBe(0);
    expect(seen).toEqual([{ path: "/v1/claims/clm_1", claim: "osc_clm_abc" }]);
    expect(out).toContain('"status": "pending"');
  });

  it("works without a local session", async () => {
    const fetchImpl = routerFetch((url) =>
      url.includes("/v1/claims/") ? json({ status: "claimed" }) : undefined,
    );
    const code = await runCli(
      ["claim", "poll", "clm_2", "--token", "osc_clm_xyz", "--issuer", ISSUER],
      { fetchImpl },
    );
    expect(code).toBe(0);
    expect(out).toContain('"status": "claimed"');
  });
});

describe("runCli — agent init", () => {
  it("requires --anonymous in this slice", async () => {
    const code = await runCli(["agent", "init", "--issuer", ISSUER], {
      fetchImpl: routerFetch(),
    });
    expect(code).toBe(1);
    expect(err).toMatch(/Use --anonymous/);
  });

  it("mints a guest session, then registers the agent under it", async () => {
    const seen: Array<{ path: string; auth: string | null; body: unknown }> =
      [];
    const fetchImpl = routerFetch((url, init) => {
      const path = new URL(url).pathname;
      if (path === "/v1/principals/provisional") {
        seen.push({
          path,
          auth: new Headers(init?.headers).get("authorization"),
          body: undefined,
        });
        return json(guestSessionBody, 201);
      }
      if (path === "/v1/agents") {
        seen.push({
          path,
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return json({ agentId: "agt_1", claimSession: "cs_1" }, 201);
      }
      return undefined;
    });
    const code = await runCli(
      ["agent", "init", "--anonymous", "--name", "robo", "--issuer", ISSUER],
      { fetchImpl },
    );
    expect(code).toBe(0);
    expect(out).toMatch(/Anonymous agent registered/);
    expect(seen[0]).toEqual({
      path: "/v1/principals/provisional",
      auth: null,
      body: undefined,
    });
    expect(seen[1]?.path).toBe("/v1/agents");
    expect(seen[1]?.auth).toBe("Bearer pst_guest");
    expect(seen[1]?.body).toMatchObject({
      displayName: "robo",
      publicKeyJkt: expect.any(String),
    });
  });
});

describe("runCli — host health", () => {
  const HOST = "http://127.0.0.1:8787";

  it("reports host and daemon as up", async () => {
    const fetchImpl = routerFetch((url) => {
      if (url === `${HOST}/health/live`) return new Response("ok");
      if (url === "http://127.0.0.1:18790/health") return json({ ok: true });
      return undefined;
    });
    const code = await runCli(["host", "health", "--host", HOST], {
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(out).toMatch(/Host API up\. Daemon available\./);
  });

  it("reports an unreachable host with exit 1", async () => {
    const fetchImpl = routerFetch((url) => {
      if (url === `${HOST}/health/live`) {
        return new Response("nope", { status: 502 });
      }
      if (url === "http://127.0.0.1:18790/health") {
        return new Response("nope", { status: 502 });
      }
      return undefined;
    });
    const code = await runCli(["host", "health", "--host", HOST], {
      fetchImpl,
    });
    expect(code).toBe(1);
    expect(out).toMatch(/Host API unreachable/);
  });
});

describe("runCli — host discover", () => {
  const HOST = "http://127.0.0.1:8787";

  it("uses the protected-resource metadata when present", async () => {
    const fetchImpl = routerFetch((url) =>
      url === `${HOST}/.well-known/oauth-protected-resource`
        ? json({
            resource: HOST,
            dpop_bound: true,
            authorization_servers: ["https://idp.example.test"],
          })
        : undefined,
    );
    const code = await runCli(["host", "discover", "--host", HOST], {
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(out).toMatch(/Discovery source: prm/);
  });

  it("falls back to the readiness probe", async () => {
    const fetchImpl = routerFetch((url) => {
      if (url === `${HOST}/.well-known/oauth-protected-resource`) {
        return new Response("nope", { status: 404 });
      }
      if (url === `${HOST}/health/ready`) return new Response("ok");
      return undefined;
    });
    const code = await runCli(["host", "discover", "--host", HOST], {
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(out).toMatch(/Discovery source: ready/);
  });

  it("exits 1 when nothing discovers", async () => {
    const fetchImpl = routerFetch((url) => {
      if (
        url === `${HOST}/.well-known/oauth-protected-resource` ||
        url === `${HOST}/health/ready`
      ) {
        return new Response("nope", { status: 404 });
      }
      return undefined;
    });
    const code = await runCli(["host", "discover", "--host", HOST], {
      fetchImpl,
    });
    expect(code).toBe(1);
    expect(out).toMatch(/Discovery source: none/);
  });
});

describe("runCli — session refresh", () => {
  async function writeExpiredSession(): Promise<void> {
    await writeSession({
      accessToken: "at-old",
      refreshToken: "rt-old",
      issuer: ISSUER,
      clientId: "opensesame-cli",
      expiresAt: Date.now() - 1000,
    });
  }

  it("refreshes an expired session and uses the new token", async () => {
    await writeExpiredSession();
    const seen: Array<string | null> = [];
    const fetchImpl = routerFetch((url, init) => {
      if (url.includes("openid-configuration")) return json(discoveryDoc);
      if (url.endsWith("/token")) {
        return json({
          access_token: "at-new",
          refresh_token: "rt-new",
          expires_in: 3600,
        });
      }
      if (url.endsWith("/v1/principals/me")) {
        seen.push(new Headers(init?.headers).get("authorization"));
        return json({ id: "p-1" });
      }
      return undefined;
    });
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(0);
    expect(seen).toEqual(["Bearer at-new"]);
    const saved = JSON.parse(await readFile(sessionFile(), "utf8"));
    expect(saved.accessToken).toBe("at-new");
    expect(saved.refreshToken).toBe("rt-new");
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
  });

  it("keeps the old refresh token when the grant does not rotate it", async () => {
    await writeExpiredSession();
    const fetchImpl = routerFetch((url) => {
      if (url.includes("openid-configuration")) return json(discoveryDoc);
      if (url.endsWith("/token")) return json({ access_token: "at-new" });
      if (url.endsWith("/v1/principals/me")) return json({ id: "p-1" });
      return undefined;
    });
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(0);
    const saved = JSON.parse(await readFile(sessionFile(), "utf8"));
    expect(saved.refreshToken).toBe("rt-old");
    // No expires_in in the grant: the previous expiry is carried over.
    expect(saved.expiresAt).toBeLessThan(Date.now());
  });

  it("gives up when discovery fails", async () => {
    await writeExpiredSession();
    const fetchImpl = routerFetch((url) =>
      url.includes("openid-configuration")
        ? new Response("nope", { status: 500 })
        : undefined,
    );
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(1);
    expect(out).toMatch(/Not authenticated/);
  });

  it("gives up when discovery names no token endpoint", async () => {
    await writeExpiredSession();
    const fetchImpl = routerFetch((url) =>
      url.includes("openid-configuration")
        ? json({ issuer: ISSUER })
        : undefined,
    );
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(1);
    expect(out).toMatch(/Not authenticated/);
  });

  it("refuses a token endpoint on another origin", async () => {
    await writeExpiredSession();
    const fetchImpl = routerFetch((url) =>
      url.includes("openid-configuration")
        ? json({ token_endpoint: "https://evil.example.test/token" })
        : undefined,
    );
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(1);
    expect(out).toMatch(/Not authenticated/);
  });

  it("gives up when the refresh grant is rejected", async () => {
    await writeExpiredSession();
    const fetchImpl = routerFetch((url) => {
      if (url.includes("openid-configuration")) return json(discoveryDoc);
      if (url.endsWith("/token")) {
        return new Response("invalid_grant", { status: 400 });
      }
      return undefined;
    });
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(1);
    expect(out).toMatch(/Not authenticated/);
  });

  it("gives up when the refresh grant returns no access token", async () => {
    await writeExpiredSession();
    const fetchImpl = routerFetch((url) => {
      if (url.includes("openid-configuration")) return json(discoveryDoc);
      if (url.endsWith("/token")) return json({ token_type: "Bearer" });
      return undefined;
    });
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl });
    expect(code).toBe(1);
    expect(out).toMatch(/Not authenticated/);
  });
});

describe("runCli — environment defaults", () => {
  it("honours OPENSESAME_ISSUER when --issuer is absent", async () => {
    process.env.OPENSESAME_ISSUER = ISSUER;
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
    });
    const fetchImpl = routerFetch((url) =>
      url.endsWith("/v1/principals/me") ? json({ id: "p-1" }) : undefined,
    );
    expect(await runCli(["whoami"], { fetchImpl })).toBe(0);
  });

  it("honours OPENSESAME_API_URL over the issuer as API base", async () => {
    process.env.OPENSESAME_ISSUER = ISSUER;
    process.env.OPENSESAME_API_URL = "http://127.0.0.1:9999";
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
    });
    const seen: string[] = [];
    const fetchImpl = routerFetch((url) => {
      seen.push(url);
      if (url.endsWith("/v1/principals/me")) return json({ id: "p-1" });
      return undefined;
    });
    expect(await runCli(["whoami"], { fetchImpl })).toBe(0);
    expect(seen).toEqual(["http://127.0.0.1:9999/v1/principals/me"]);
  });

  it("stores the session under XDG_RUNTIME_DIR when no state dir is set", async () => {
    Reflect.deleteProperty(process.env, "OPENSESAME_STATE_DIR");
    process.env.XDG_RUNTIME_DIR = dir;
    const fetchImpl = routerFetch((url) =>
      url.endsWith("/v1/principals/provisional")
        ? json(guestSessionBody, 201)
        : undefined,
    );
    const code = await runCli(["login", "--anonymous", "--issuer", ISSUER], {
      fetchImpl,
    });
    expect(code).toBe(0);
    const saved = JSON.parse(await readFile(sessionFile(), "utf8"));
    expect(saved.accessToken).toBe("pst_guest");
  });
});
