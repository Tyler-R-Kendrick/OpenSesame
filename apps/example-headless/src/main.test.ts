import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockFetch, runHeadlessDeviceLogin } from "./main.js";

const ISSUER = "http://127.0.0.1:8788";

const savedEnv: Record<string, string | undefined> = {};

/** `delete process.env.X` trips lint/performance/noDelete; this is the same unset. */
function unsetEnv(key: string): void {
  Reflect.deleteProperty(process.env, key);
}

beforeEach(() => {
  for (const key of [
    "MOCK_DEVICE_FLOW",
    "OPENSESAME_ISSUER",
    "OPENSESAME_CLIENT_ID",
  ]) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      unsetEnv(key);
    } else {
      process.env[key] = value;
    }
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Discovery/device/token responder whose device payload can be shaped per test. */
function deviceFlowFetch(devicePayload: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          device_authorization_endpoint: `${ISSUER}/device`,
          jwks_uri: `${ISSUER}/jwks`,
        }),
      );
    }
    if (url.endsWith("/device") && init?.method === "POST") {
      return new Response(JSON.stringify(devicePayload));
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

describe("createMockFetch", () => {
  it("serves a discovery document pointing at the issuer endpoints", async () => {
    const mockFetch = createMockFetch();
    const res = await mockFetch(`${ISSUER}/.well-known/openid-configuration`);
    const doc = (await res.json()) as Record<string, string>;
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.device_authorization_endpoint).toBe(`${ISSUER}/device`);
    expect(doc.token_endpoint).toBe(`${ISSUER}/token`);
  });

  it("issues a device authorization with the demo user code", async () => {
    const mockFetch = createMockFetch();
    const res = await mockFetch(`${ISSUER}/device`, { method: "POST" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.user_code).toBe("HEAD-LESS");
    expect(body.device_code).toBe("DO_NOT_PRINT");
    expect(body.expires_in).toBe(600);
  });

  it("answers pending on the first token poll and success on the second", async () => {
    const mockFetch = createMockFetch();
    const first = await mockFetch(`${ISSUER}/token`, { method: "POST" });
    expect(first.status).toBe(400);
    expect(((await first.json()) as { error: string }).error).toBe(
      "authorization_pending",
    );
    const second = await mockFetch(`${ISSUER}/token`, { method: "POST" });
    const tokens = (await second.json()) as Record<string, unknown>;
    expect(tokens.access_token).toBe("mock-access");
    expect(tokens.token_type).toBe("Bearer");
  });

  it("rejects requests to URLs the flow never makes", async () => {
    const mockFetch = createMockFetch();
    await expect(mockFetch(`${ISSUER}/userinfo`)).rejects.toThrow(/unexpected/);
  });

  it("ignores non-POST calls to the device endpoint", async () => {
    const mockFetch = createMockFetch();
    await expect(mockFetch(`${ISSUER}/device`)).rejects.toThrow(/unexpected/);
  });
});

describe("runHeadlessDeviceLogin", () => {
  it("completes mock device login without printing device_code", async () => {
    process.env.MOCK_DEVICE_FLOW = "1";
    const result = await runHeadlessDeviceLogin({
      sleep: async () => undefined,
    });
    expect(result.userCode).toBe("HEAD-LESS");
    expect(result.accessTokenPresent).toBe(true);
  });

  it("falls back to the built-in mock fetch and default sleep", async () => {
    vi.useFakeTimers();
    process.env.MOCK_DEVICE_FLOW = "1";
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const pending = runHeadlessDeviceLogin();
    // The mock polls once as pending; the default sleep waits one clamped
    // interval (5s floor) before the successful poll.
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result).toEqual({
      userCode: "HEAD-LESS",
      accessTokenPresent: true,
    });
    const output = writes.join("");
    expect(output).toContain("Waiting for approval");
    expect(output).toContain("Device login complete");
    expect(output).not.toContain("DO_NOT_PRINT");
    writeSpy.mockRestore();
  });

  it("uses the global fetch when the mock flow is not enabled", async () => {
    unsetEnv("MOCK_DEVICE_FLOW");
    const fetchSpy = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      runHeadlessDeviceLogin({ sleep: async () => undefined }),
    ).rejects.toThrow("offline");
    expect(fetchSpy).toHaveBeenCalledWith(
      `${ISSUER}/.well-known/openid-configuration`,
    );
  });

  it("honors OPENSESAME_ISSUER and OPENSESAME_CLIENT_ID from the environment", async () => {
    process.env.OPENSESAME_ISSUER = "http://127.0.0.1:9999";
    process.env.OPENSESAME_CLIENT_ID = "custom-client";
    vi.resetModules();
    const seen: Array<{ url: string; body: string | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, body: init?.body?.toString() });
      if (url.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "http://127.0.0.1:9999",
            token_endpoint: "http://127.0.0.1:9999/token",
            device_authorization_endpoint: "http://127.0.0.1:9999/device",
          }),
        );
      }
      if (url.endsWith("/device")) {
        return new Response(
          JSON.stringify({
            device_code: "DO_NOT_PRINT",
            user_code: "CUST-OM01",
            verification_uri: "http://127.0.0.1:5173/device",
            expires_in: 600,
            interval: 1,
          }),
        );
      }
      return new Response(
        JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
      );
    }) as typeof fetch;

    const fresh = (await import("./main.js")) as typeof import("./main.js");
    const result = await fresh.runHeadlessDeviceLogin({
      fetchImpl,
      sleep: async () => undefined,
    });

    expect(result.userCode).toBe("CUST-OM01");
    expect(seen[0]?.url).toBe(
      "http://127.0.0.1:9999/.well-known/openid-configuration",
    );
    // The device authorization request carries the configured client id.
    expect(seen[1]?.body).toContain("client_id=custom-client");
  });

  it("refuses to continue when instructions would print the device code marker", async () => {
    await expect(
      runHeadlessDeviceLogin({
        fetchImpl: deviceFlowFetch({
          device_code: "secret-device-code",
          user_code: "DO_NOT_PRINT",
          verification_uri: "http://127.0.0.1:5173/device",
          expires_in: 600,
          interval: 1,
        }),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("device_code leaked into user instructions");
  });

  it("refuses to continue when instructions name the device_code field", async () => {
    await expect(
      runHeadlessDeviceLogin({
        fetchImpl: deviceFlowFetch({
          device_code: "secret-device-code",
          user_code: "enter-device_code-here",
          verification_uri: "http://127.0.0.1:5173/device",
          expires_in: 600,
          interval: 1,
        }),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("device_code leaked into user instructions");
  });

  it("reports a missing access token as absent", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            token_endpoint: `${ISSUER}/token`,
            device_authorization_endpoint: `${ISSUER}/device`,
          }),
        );
      }
      if (url.endsWith("/device") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            device_code: "DO_NOT_PRINT",
            user_code: "NO-TOKEN1",
            verification_uri: "http://127.0.0.1:5173/device",
            expires_in: 600,
            interval: 1,
          }),
        );
      }
      // A 200 whose access_token is the empty string still completes the
      // flow, but the demo must report the token as absent.
      return new Response(
        JSON.stringify({ access_token: "", token_type: "Bearer" }),
      );
    }) as typeof fetch;

    const result = await runHeadlessDeviceLogin({
      fetchImpl,
      sleep: async () => undefined,
    });
    expect(result.userCode).toBe("NO-TOKEN1");
    expect(result.accessTokenPresent).toBe(false);
  });
});
