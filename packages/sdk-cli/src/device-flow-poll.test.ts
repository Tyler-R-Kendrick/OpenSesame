import { describe, expect, it, vi } from "vitest";
import { DeviceFlowClient, redactSecrets } from "./device-flow.js";

const ISSUER = "http://127.0.0.1:8788";

function discoveryDoc(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`,
    device_authorization_endpoint: `${ISSUER}/device`,
    ...overrides,
  };
}

function deviceResponse(overrides: Record<string, unknown> = {}) {
  return {
    device_code: "dc",
    user_code: "ABCD-EFGH",
    verification_uri: `${ISSUER}/activate`,
    expires_in: 600,
    interval: 1,
    ...overrides,
  };
}

type Handlers = {
  discovery?: Response | (() => Response);
  device?: Response | (() => Response);
  token?: Response | (() => Response);
};

function fetchWith(handlers: Handlers, seen?: RequestInit[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init) seen?.push(init);
    const url = String(input);
    const pick = (v: Response | (() => Response) | undefined): Response => {
      if (!v) throw new Error(`unexpected ${url}`);
      return typeof v === "function" ? v() : v;
    };
    if (url.includes("openid-configuration")) return pick(handlers.discovery);
    if (url.endsWith("/device")) return pick(handlers.device);
    if (url.endsWith("/token")) return pick(handlers.token);
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientWith(
  fetchImpl: typeof fetch,
  extra: Record<string, unknown> = {},
) {
  return new DeviceFlowClient({
    issuer: ISSUER,
    clientId: "cli",
    fetchImpl,
    sleep: async () => undefined,
    ...extra,
  });
}

async function startedClient(
  fetchImpl: typeof fetch,
): Promise<DeviceFlowClient> {
  const c = clientWith(fetchImpl);
  await c.start();
  return c;
}

describe("DeviceFlowClient discovery and start failures", () => {
  it("surfaces a discovery failure with the status", async () => {
    const c = clientWith(fetchWith({ discovery: json({}, 500) }));
    await expect(c.start()).rejects.toThrow(/discovery failed: 500/u);
  });

  it("refuses an issuer that does not advertise a device endpoint", async () => {
    const doc = discoveryDoc();
    (
      doc as { device_authorization_endpoint?: string | undefined }
    ).device_authorization_endpoint = undefined;
    const c = clientWith(fetchWith({ discovery: json(doc) }));
    await expect(c.start()).rejects.toThrow(/device_authorization_endpoint/u);
  });

  it("surfaces a device-authorize failure with the status", async () => {
    const c = clientWith(
      fetchWith({ discovery: json(discoveryDoc()), device: json({}, 400) }),
    );
    await expect(c.start()).rejects.toThrow(/device authorize failed: 400/u);
  });
});

describe("DeviceFlowClient pollOnce", () => {
  it("refuses to poll before the flow has started", async () => {
    const c = clientWith(fetchWith({}));
    await expect(c.pollOnce()).rejects.toThrow(/not started/u);
  });

  it("maps access_denied and expired_token without touching the interval", async () => {
    for (const error of ["access_denied", "expired_token"] as const) {
      const fetchImpl = fetchWith({
        discovery: json(discoveryDoc()),
        device: json(deviceResponse()),
        token: json({ error }, 400),
      });
      const c = await startedClient(fetchImpl);
      const result = await c.pollOnce();
      expect(result).toEqual({ status: error });
    }
  });

  it("returns the description when the server supplies one", async () => {
    const fetchImpl = fetchWith({
      discovery: json(discoveryDoc()),
      device: json(deviceResponse()),
      token: json(
        { error: "invalid_grant", error_description: "code already used" },
        400,
      ),
    });
    const c = await startedClient(fetchImpl);
    await expect(c.pollOnce()).resolves.toEqual({
      status: "error",
      error: "invalid_grant",
      description: "code already used",
    });
  });

  it("omits the description when the server supplies none", async () => {
    const fetchImpl = fetchWith({
      discovery: json(discoveryDoc()),
      device: json(deviceResponse()),
      token: json({ error: "temporarily_unavailable" }, 400),
    });
    const c = await startedClient(fetchImpl);
    await expect(c.pollOnce()).resolves.toEqual({
      status: "error",
      error: "temporarily_unavailable",
    });
  });

  it("reports an unknown error when the body carries no error field", async () => {
    const fetchImpl = fetchWith({
      discovery: json(discoveryDoc()),
      device: json(deviceResponse()),
      token: json({}, 500),
    });
    const c = await startedClient(fetchImpl);
    await expect(c.pollOnce()).resolves.toEqual({
      status: "error",
      error: "unknown",
    });
  });
});

describe("DeviceFlowClient pollUntilComplete", () => {
  it("throws access_denied when the user refuses", async () => {
    const fetchImpl = fetchWith({
      discovery: json(discoveryDoc()),
      device: json(deviceResponse()),
      token: json({ error: "access_denied" }, 400),
    });
    const c = await startedClient(fetchImpl);
    await expect(c.pollUntilComplete()).rejects.toThrow(/access_denied/u);
  });

  it("throws expired_token when the server retires the code", async () => {
    const fetchImpl = fetchWith({
      discovery: json(discoveryDoc()),
      device: json(deviceResponse()),
      token: json({ error: "expired_token" }, 400),
    });
    const c = await startedClient(fetchImpl);
    await expect(c.pollUntilComplete()).rejects.toThrow(/expired_token/u);
  });

  it("throws the server's description on a bare error", async () => {
    const fetchImpl = fetchWith({
      discovery: json(discoveryDoc()),
      device: json(deviceResponse()),
      token: json({ error: "invalid_grant", error_description: "used" }, 400),
    });
    const c = await startedClient(fetchImpl);
    await expect(c.pollUntilComplete()).rejects.toThrow(/^used$/u);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchImpl = fetchWith({
      discovery: json(discoveryDoc()),
      device: json(deviceResponse()),
      token: () => {
        controller.abort();
        return json({ error: "authorization_pending" }, 400);
      },
    });
    const c = clientWith(fetchImpl, { signal: controller.signal });
    await c.start();
    await expect(c.pollUntilComplete()).rejects.toThrow(/aborted/u);
  });

  it("threads the caller's abort signal into every request", async () => {
    const seen: RequestInit[] = [];
    const controller = new AbortController();
    const fetchImpl = fetchWith(
      {
        discovery: json(discoveryDoc()),
        device: json(deviceResponse()),
        token: json({ access_token: "at", token_type: "Bearer" }),
      },
      seen,
    );
    const c = clientWith(fetchImpl, { signal: controller.signal });
    await c.start();
    await c.pollOnce();
    // Discovery is a GET with no init; the device and token POSTs carry the signal.
    const posts = seen.filter((init) => init.method === "POST");
    expect(posts).toHaveLength(2);
    for (const init of posts) {
      expect(init.signal).toBe(controller.signal);
    }
  });

  it("uses the default sleep when none is injected", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const fetchImpl = fetchWith({
        discovery: json(discoveryDoc()),
        device: json(deviceResponse()),
        token: () => {
          polls += 1;
          return polls === 1
            ? json({ error: "authorization_pending" }, 400)
            : json({ access_token: "at", token_type: "Bearer" });
        },
      });
      // No sleep injected: the client falls back to real timers, which the fake
      // clock stands in for here.
      const c = new DeviceFlowClient({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl,
      });
      await c.start();
      const done = c.pollUntilComplete();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(done).resolves.toMatchObject({ access_token: "at" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("redactSecrets", () => {
  it("redacts secrets inside arrays", () => {
    const out = redactSecrets({
      attempts: [{ device_code: "dc" }, { user_code: "ABCD" }],
    });
    expect(out).toEqual({
      attempts: [{ device_code: "[redacted]" }, { user_code: "ABCD" }],
    });
  });

  it("passes scalars through untouched", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
  });
});
