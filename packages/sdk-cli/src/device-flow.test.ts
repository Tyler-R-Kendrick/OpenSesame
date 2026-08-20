import { describe, expect, it, vi } from "vitest";
import { DeviceFlowClient, redactSecrets } from "./device-flow.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

describe("DeviceFlowClient", () => {
  it("starts and polls with authorization_pending then success", async () => {
    let polls = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
      },
    );

    const client = new DeviceFlowClient({
      issuer: "http://127.0.0.1:8788",
      clientId: "opensesame-cli",
      fetchImpl: overlapCast(fetchImpl),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const start = await client.start();
    expect(start.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(start)).not.toContain("SECRET_DEVICE_CODE");
    expect(client.formatInstructions(start)).not.toContain(
      "SECRET_DEVICE_CODE",
    );
    expect(client.formatInstructions(start)).toContain("ABCD-EFGH");
    expect(client.formatInstructions(start)).toContain("shortcode");
    expect(client.formatInstructions(start, { qr: false })).not.toMatch(
      /█|▀|▄/u,
    );
    const withQr = client.formatInstructions(start, { qr: true });
    expect(withQr.split("\n").length).toBeGreaterThan(
      client.formatInstructions(start).split("\n").length,
    );
    expect(withQr).toMatch(/█|▀|▄/u);

    const pending = await client.pollOnce();
    expect(pending.status).toBe("authorization_pending");

    const slow = await client.pollOnce();
    expect(slow.status).toBe("slow_down");
    if (slow.status === "slow_down") {
      expect(slow.intervalSeconds).toBe(10);
    }

    polls = 0;
    const client2 = new DeviceFlowClient({
      issuer: "http://127.0.0.1:8788",
      clientId: "opensesame-cli",
      fetchImpl: overlapCast(fetchImpl),
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

describe("DeviceFlowClient refusals", () => {
  const base = (
    over: JsonObject,
    device: JsonObject = {},
  ) =>
    overlapCast(vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "http://127.0.0.1:8788",
            token_endpoint: "http://127.0.0.1:8788/token",
            device_authorization_endpoint: "http://127.0.0.1:8788/device",
            ...over,
          }),
        );
      }
      if (url.endsWith("/device")) {
        return new Response(
          JSON.stringify({
            device_code: "dc",
            user_code: "ABCD-EFGH",
            verification_uri: "http://127.0.0.1:5173/device",
            expires_in: 600,
            interval: 1,
            ...device,
          }),
        );
      }
      if (url.endsWith("/token")) {
        return new Response(
          JSON.stringify({ error: "authorization_pending" }),
          { status: 400 },
        );
      }
      throw new Error(url);
    }));

  const client = (fetchImpl: typeof fetch) =>
    new DeviceFlowClient({
      issuer: "http://127.0.0.1:8788",
      clientId: "opensesame-cli",
      fetchImpl,
      sleep: async () => undefined,
    });

  it("refuses a discovery document that names another issuer", async () => {
    await expect(
      client(base({ issuer: "https://idp.evil" })).start(),
    ).rejects.toThrow(/issuer/i);
  });

  it("refuses to send a person to a page it cannot vouch for", async () => {
    await expect(
      client(
        base({}, { verification_uri: "http://phish.example/device" }),
      ).start(),
    ).rejects.toThrow(/verification_uri/);
    await expect(
      client(
        base(
          {},
          {
            verification_uri_complete:
              "http://phish.example/device?user_code=X",
          },
        ),
      ).start(),
    ).rejects.toThrow(/verification_uri_complete/);
  });

  it("refuses a cleartext issuer outright", () => {
    expect(
      () =>
        new DeviceFlowClient({ issuer: "http://idp.example", clientId: "cli" }),
    ).toThrow(/https/i);
  });

  it("stops polling once the device code the server issued has expired", async () => {
    const c = client(base({}, { expires_in: 0 }));
    await c.start();
    await expect(c.pollUntilComplete()).rejects.toThrow(/expired_token/);
  });

  it("does not let a server push the poll interval up without bound", async () => {
    const c = client(base({}, { interval: 900 }));
    const start = await c.start();
    expect(start.intervalSeconds).toBe(60);
    for (let i = 0; i < 20; i += 1) {
      const r = await c.pollOnce();
      if (r.status === "slow_down")
        expect(r.intervalSeconds).toBeLessThanOrEqual(60);
    }
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

  it("refuses a remote issuer that points the CLI at this machine", async () => {
    // The document decides where the device code and the poll are sent. Cleartext
    // on loopback is right for a value this machine configured and wrong for one a
    // remote issuer supplies.
    const client = new DeviceFlowClient({
      issuer: "https://idp.example",
      clientId: "cli",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            issuer: "https://idp.example",
            authorization_endpoint: "https://idp.example/auth",
            token_endpoint: "http://127.0.0.1:9000/token",
            device_authorization_endpoint: "https://idp.example/device",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(client.start()).rejects.toThrow(/private or loopback host/u);
  });

  it("leaves a loopback issuer's loopback endpoints alone", async () => {
    // Local development: both ends are on this machine, so nothing is crossed.
    const client = new DeviceFlowClient({
      issuer: "http://127.0.0.1:8788",
      clientId: "cli",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("openid-configuration")) {
          return new Response(
            JSON.stringify({
              issuer: "http://127.0.0.1:8788",
              authorization_endpoint: "http://127.0.0.1:8788/auth",
              token_endpoint: "http://127.0.0.1:8788/token",
              device_authorization_endpoint: "http://127.0.0.1:8788/device",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            device_code: "dc",
            user_code: "ABCD",
            verification_uri: "http://127.0.0.1:8788/activate",
            expires_in: 600,
            interval: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(client.start()).resolves.toMatchObject({ userCode: "ABCD" });
  });

  it("redacts the other things a CLI would otherwise print", () => {
    const out = redactSecrets({
      code_verifier: "v",
      client_assertion: "a",
      operator_token: "o",
      authorization: "Bearer x",
      apiKey: "k",
      password: "p",
      token_type: "Bearer",
      user_code: "ABCD",
    });
    expect(out).toEqual({
      code_verifier: "[redacted]",
      client_assertion: "[redacted]",
      operator_token: "[redacted]",
      authorization: "[redacted]",
      apiKey: "[redacted]",
      password: "[redacted]",
      // Not secrets — a redaction that eats these is one nobody keeps on.
      token_type: "Bearer",
      user_code: "ABCD",
    });
  });
});
