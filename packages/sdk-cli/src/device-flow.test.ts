import { describe, expect, it, vi } from "vitest";
import { DeviceFlowClient, redactSecrets } from "./device-flow.js";

describe("DeviceFlowClient", () => {
  it("starts and polls with authorization_pending then success", async () => {
    let polls = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "http://127.0.0.1:8788",
            authorization_endpoint: "http://127.0.0.1:8788/auth",
            token_endpoint: "http://127.0.0.1:8788/token",
            device_authorization_endpoint: "http://127.0.0.1:8788/device",
            jwks_uri: "http://127.0.0.1:8788/jwks",
          }),
        );
      }
      if (url.endsWith("/device") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            device_code: "SECRET_DEVICE_CODE",
            user_code: "ABCD-EFGH",
            verification_uri: "http://127.0.0.1:5173/device",
            verification_uri_complete:
              "http://127.0.0.1:5173/device?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 1,
          }),
        );
      }
      if (url.endsWith("/token")) {
        polls += 1;
        if (polls === 1) {
          return new Response(
            JSON.stringify({ error: "authorization_pending" }),
            { status: 400 },
          );
        }
        if (polls === 2) {
          return new Response(JSON.stringify({ error: "slow_down" }), {
            status: 400,
          });
        }
        return new Response(
          JSON.stringify({
            access_token: "at",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      }
      throw new Error(url);
    });

    const client = new DeviceFlowClient({
      issuer: "http://127.0.0.1:8788",
      clientId: "opensesame-cli",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const start = await client.start();
    expect(start.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(start)).not.toContain("SECRET_DEVICE_CODE");
    expect(client.formatInstructions(start)).not.toContain("SECRET_DEVICE_CODE");
    expect(client.formatInstructions(start)).toContain("ABCD-EFGH");

    const pending = await client.pollOnce();
    expect(pending.status).toBe("authorization_pending");

    const slow = await client.pollOnce();
    expect(slow.status).toBe("slow_down");
    if (slow.status === "slow_down") {
      expect(slow.intervalSeconds).toBe(6);
    }

    polls = 0;
    const client2 = new DeviceFlowClient({
      issuer: "http://127.0.0.1:8788",
      clientId: "opensesame-cli",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await client2.start();
    polls = 0;
    const tokens = await client2.pollUntilComplete();
    expect(tokens.access_token).toBe("at");
    expect(sleeps.length).toBeGreaterThan(0);
    expect(client.getDeviceCodeForTests()).toBe("SECRET_DEVICE_CODE");
  });
});

describe("redactSecrets", () => {
  it("redacts device_code and tokens", () => {
    const out = redactSecrets({
      user_code: "ABCD",
      device_code: "secret",
      nested: { access_token: "at", ok: true },
    });
    expect(out).toEqual({
      user_code: "ABCD",
      device_code: "[redacted]",
      nested: { access_token: "[redacted]", ok: true },
    });
  });
});
