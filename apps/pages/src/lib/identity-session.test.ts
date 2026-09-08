import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST,
  IDENTITY,
  jsonResponse,
  provisionalBody,
  stubBasic,
  stubFetch,
} from "./__tests__/identity-session-support.js";
import { loopbackProfileEligible } from "./__tests__/loopback-profile.js";
import { browserPairingSeams } from "./browser-pairing.js";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  HostSessionError,
  IdentityError,
  adoptToken,
  clearHostSession,
  clearSession,
  connectProvisional,
  currentSession,
  endSession,
  ensureHostSession,
  ensureIdentitySession,
  fetchPrincipal,
  hostFetch,
  hostRoutedViaDaemon,
  identityFetch,
  identityJson,
  noteUnauthorized,
  probeHost,
  probeIdentity,
  probeOrphanSession,
} from "./identity.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";
import { loadSettings, saveSettings } from "./settings.js";
const networkEligible = localNetworkFetchSeams.eligible;

beforeEach(() => {
  localNetworkFetchSeams.eligible = loopbackProfileEligible;
  clearSession();
  clearHostSession();
  saveSettings({
    hostApi: HOST,
    identityApi: IDENTITY,
    daemonApi: "http://127.0.0.1:18790",
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
});

afterEach(() => {
  localNetworkFetchSeams.eligible = networkEligible;
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("session lifecycle", () => {
  it("mints a provisional session and drops it on expiry", async () => {
    stubBasic();
    const session = await connectProvisional();
    expect(session.principalId).toBe("principal_1");
    expect(session.issuerOrigin).toBe(new URL(IDENTITY).origin);
    expect(currentSession()?.accessToken).toBe("identity_tok");
    // A second caller reuses the live session instead of minting again.
    await expect(ensureIdentitySession()).resolves.toBe(session);
  });

  it("forgets a session whose expiry has passed", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) return jsonResponse({}, 401);
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse(provisionalBody());
      }
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 500);
    });
    await connectProvisional();

    // Time-travel past the session horizon.
    const now = Date.now();
    vi.setSystemTime(new Date("2100-01-01T00:00:00Z"));
    try {
      expect(currentSession()).toBeNull();
    } finally {
      vi.setSystemTime(now);
    }
  });

  it("revokes the session server-side with the bearer it forgets", async () => {
    const spy = stubBasic();
    await connectProvisional();

    endSession();

    expect(currentSession()).toBeNull();
    await vi.waitFor(() => {
      const revoke = spy.mock.calls.find(([url]) =>
        String(url).endsWith("/provisional/revoke"),
      );
      expect(revoke).toBeTruthy();
      expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
        "Bearer identity_tok",
      );
      expect(revoke?.[1]?.method).toBe("POST");
    });
  });

  it("flags an orphan cookie when the revoke is refused but the cookie still acts", async () => {
    let meResponds = (): Response => jsonResponse({}, 401);
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) return meResponds();
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse(provisionalBody());
      }
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        return jsonResponse({ error: "nope" }, 500);
      }
      return jsonResponse({}, 500);
    });
    await connectProvisional();
    meResponds = () => jsonResponse({ id: "principal_1" });

    endSession();

    await vi.waitFor(async () => {
      await expect(probeOrphanSession()).resolves.toBe(true);
    });
  });

  it("reports no orphan when the cookie alone does not authenticate", async () => {
    stubBasic();
    await expect(probeOrphanSession()).resolves.toBe(false);
  });

  it("reports no orphan while a session is live, without probing", async () => {
    const spy = stubBasic();
    await connectProvisional();
    const calls = spy.mock.calls.length;
    await expect(probeOrphanSession()).resolves.toBe(false);
    expect(spy.mock.calls.length).toBe(calls);
  });

  it("surfaces a refused provisional mint with the API's message", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) return jsonResponse({}, 401);
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return jsonResponse({ message: "provisioning disabled" }, 403);
      }
      return jsonResponse({}, 500);
    });
    const error = await connectProvisional().catch((caught) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect(overlapCast(error).status).toBe(403);
    expect(overlapCast(error).message).toBe("provisioning disabled");
  });

  it("throws away a session minted after the user ended it", async () => {
    let release!: (response: Response) => void;
    const spy = stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) return jsonResponse({}, 401);
      if (url === `${IDENTITY}/v1/principals/provisional`) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url === `${IDENTITY}/v1/principals/provisional/revoke`) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 500);
    });

    const pending = connectProvisional();
    await vi.waitFor(() => {
      expect(
        spy.mock.calls.some(
          ([url]) => url === `${IDENTITY}/v1/principals/provisional`,
        ),
      ).toBe(true);
    });
    // The user locks while the mint is in flight.
    clearSession();
    release(jsonResponse(provisionalBody("late_token")));

    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect(overlapCast(error).status).toBe(409);
    expect(currentSession()).toBeNull();
    // The orphaned credential is revoked rather than left to live out its TTL.
    await vi.waitFor(() => {
      const revoke = spy.mock.calls.find(([url]) =>
        String(url).endsWith("/provisional/revoke"),
      );
      expect(new Headers(revoke?.[1]?.headers).get("authorization")).toBe(
        "Bearer late_token",
      );
    });
  });

  it("resumes from the HttpOnly cookie without inventing a bearer", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({ id: "principal_cookie" });
      }
      return jsonResponse({}, 500);
    });
    const session = await connectProvisional();
    expect(session).toMatchObject({
      principalId: "principal_cookie",
      cookieOnly: true,
    });
    expect(session.accessToken).toBe("cookie:principal_cookie");
  });

  it("mints fresh when the cookie answer carries no principal id", async () => {
    const spy = stubBasic();
    await connectProvisional();
    expect(
      spy.mock.calls.some(
        ([url]) => url === `${IDENTITY}/v1/principals/provisional`,
      ),
    ).toBe(true);
  });

  it("treats an unreachable Identity as no cookie session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === `${IDENTITY}/v1/principals/provisional`) {
          return Promise.resolve(jsonResponse(provisionalBody()));
        }
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );
    const session = await connectProvisional();
    expect(session.principalId).toBe("principal_1");
  });
});

describe("adopted tokens", () => {
  it("proves the pasted token with the cookie withheld", async () => {
    const spy = stubBasic((url, init) => {
      if (
        url === `${IDENTITY}/v1/principals/me` &&
        new Headers(init?.headers).get("authorization") ===
          "Bearer pasted_token"
      ) {
        return jsonResponse({ id: "principal_adopted" });
      }
      return undefined;
    });
    // A live session is ended before the token is adopted.
    await connectProvisional();

    await adoptToken("  pasted_token  ");

    const session = currentSession();
    expect(session).toMatchObject({
      principalId: "principal_adopted",
      accessToken: "pasted_token",
      adopted: true,
    });
    const probe = spy.mock.calls.find(
      ([url, init]) =>
        url === `${IDENTITY}/v1/principals/me` &&
        new Headers(init?.headers).get("authorization") ===
          "Bearer pasted_token",
    );
    expect(probe?.[1]?.credentials).toBe("omit");
    // The old session was revoked first.
    expect(
      spy.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
    ).toBe(true);

    // An adopted token stands alone: no cookie rides along on API calls.
    await identityFetch("/v1/principals/me");
    const call = spy.mock.calls.at(-1);
    expect(call?.[1]?.credentials).toBe("omit");
  });

  it("rejects a token the API refuses, with its message", async () => {
    stubFetch((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({ message: "token expired" }, 401);
      }
      return jsonResponse({}, 500);
    });
    const error = await adoptToken("bad").catch((caught) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect(overlapCast(error).message).toBe("token expired");
    expect(currentSession()).toBeNull();
  });

  it("falls back to the status when the refusal is not JSON", async () => {
    stubFetch(() => new Response("nope", { status: 403 }));
    await expect(adoptToken("bad")).rejects.toThrow(/Request failed \(403\)/);
  });
});

describe("identityFetch and readers", () => {
  it("attaches the bearer and defaults the content type for bodies", async () => {
    const spy = stubBasic((url, init) => {
      if (
        url === `${IDENTITY}/v1/principals/me` &&
        new Headers(init?.headers).get("authorization") ===
          "Bearer identity_tok"
      ) {
        return jsonResponse({
          id: "principal_1",
          state: "active",
          assurance: "provisional",
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
          version: 1,
          identities: [],
        });
      }
      return undefined;
    });
    await connectProvisional();

    const principal = await fetchPrincipal();
    expect(principal.id).toBe("principal_1");
    const call = spy.mock.calls.at(-1);
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
      "Bearer identity_tok",
    );
    expect(call?.[1]?.credentials).toBe("include");

    await identityFetch("/v1/x", { method: "POST", body: "{}" });
    const post = spy.mock.calls.at(-1);
    expect(new Headers(post?.[1]?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("ends the session when the API refuses the bearer", async () => {
    stubBasic((url) => {
      if (url === `${IDENTITY}/v1/principals/me`) {
        return jsonResponse({ error: "revoked" }, 401);
      }
      return undefined;
    });
    await connectProvisional();

    const res = await identityFetch("/v1/principals/me");
    expect(res.status).toBe(401);
    expect(currentSession()).toBeNull();
  });

  it("noteUnauthorized is a no-op without a session", () => {
    expect(() => noteUnauthorized()).not.toThrow();
  });

  it("identityJson throws IdentityError with the server's message", async () => {
    stubBasic((url) => {
      if (url === `${IDENTITY}/v1/broken`) {
        return jsonResponse({ error: "bad_request_code" }, 400);
      }
      return undefined;
    });
    await connectProvisional();
    const error = await identityJson("/v1/broken").catch((caught) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect(overlapCast(error).message).toBe("bad_request_code");
    expect(overlapCast(error).status).toBe(400);
  });
});

describe("missing configuration", () => {
  beforeEach(() => {
    vi.stubGlobal("location", {
      hostname: "me.github.io",
      href: "https://me.github.io/OpenSesame/",
      origin: "https://me.github.io",
    });
    saveSettings({
      hostApi: "",
      identityApi: "",
      daemonApi: "",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        ...defaultCapabilityConnectors(),
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
  });

  it("refuses to connect with no Identity API configured", async () => {
    stubFetch(() => jsonResponse({}, 401));
    const error = await ensureIdentitySession().catch((caught) => caught);
    expect(error).toBeInstanceOf(IdentityError);
    expect(overlapCast(error).status).toBe(0);
    expect(overlapCast(error).message).toMatch(/No Identity API/);
  });

  it("refuses a provisional mint with no issuer", async () => {
    stubFetch(() => jsonResponse({}, 401));
    await expect(connectProvisional()).rejects.toThrow(
      /No Identity API is configured/,
    );
  });

  it("reports unconfigured planes as unreachable without fetching", async () => {
    const spy = stubFetch(() => jsonResponse({}, 500));
    await expect(probeIdentity()).resolves.toBe("unreachable");
    await expect(probeHost()).resolves.toBe("unreachable");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Host session authority", () => {
  it("requires explicit pairing and never calls a local or device mint endpoint", async () => {
    const fetcher = stubFetch(() => jsonResponse({}));
    await expect(ensureHostSession()).rejects.toBeInstanceOf(HostSessionError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not exchange an Identity session for an unbound browser bearer", async () => {
    stubBasic();
    await connectProvisional();
    const fetcher = stubFetch(() => jsonResponse({}));
    await expect(hostFetch("/api/v1/sync/pull")).rejects.toMatchObject({
      code: "setup_required",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("hostRoutedViaDaemon edge cases", () => {
  it("rejects empty and unparseable bases", () => {
    expect(hostRoutedViaDaemon("", "")).toBe(false);
    expect(hostRoutedViaDaemon("http://x/host", "")).toBe(false);
    expect(hostRoutedViaDaemon("::bad", "::also bad")).toBe(false);
  });
});

describe("plane probes", () => {
  it("calls a 200 without OpenSesame health JSON unreachable", async () => {
    stubFetch(() => new Response("<html>ok</html>", { status: 200 }));
    await expect(probeIdentity()).resolves.toBe("unreachable");
  });

  it("tries both Host health paths before giving up", async () => {
    const spy = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${HOST}/api/v1/health`) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      if (url === `${HOST}/health/live`) {
        return Promise.resolve(jsonResponse({ status: "ok" }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", spy);
    await expect(probeHost()).resolves.toBe("reachable");
  });
});

// Profile eligibility permits local health requests, never authenticated authority.
const originalPairingEligibility = browserPairingSeams.eligible;
beforeEach(() => {
  browserPairingSeams.eligible = loopbackProfileEligible;
});
afterEach(() => {
  browserPairingSeams.eligible = originalPairingEligibility;
});
