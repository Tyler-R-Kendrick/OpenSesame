import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { DeviceFlowClient } from "./device-flow.js";

/**
 * Finding S12 / T-34 (RFC 8628 device flow, ADR 0086).
 *
 * The server creates the canonical interaction: it mints the device_code, the
 * user_code a person types, the verification URI, and — once approved — the
 * tokens that name a subject. The CLI device-flow client is a courier for
 * those values and nothing more. It may never invent a shortcode, a subject
 * id, a principal id, or an approval proof; doing so would let a headless
 * caller manufacture the very thing the human ceremony exists to obtain.
 *
 * These tests lock that on two levels: the client echoes exactly what the
 * server issued (behavioural), and the client module contains no machinery for
 * minting identity or proof material (source pact).
 */

const ISSUER = "http://127.0.0.1:8788";
const here = dirname(fileURLToPath(import.meta.url));

function discoveryDoc(): JsonObject {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`,
    device_authorization_endpoint: `${ISSUER}/device`,
  };
}

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fetchWith(device: JsonObject, token: JsonObject): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("openid-configuration")) return json(discoveryDoc());
    if (url.endsWith("/device")) return json(device);
    if (url.endsWith("/token")) return json(token);
    throw new Error(`unexpected ${url}`);
  });
}

function client(fetchImpl: typeof fetch): DeviceFlowClient {
  return new DeviceFlowClient({
    issuer: ISSUER,
    clientId: "cli",
    fetchImpl,
    sleep: async () => undefined,
  });
}

describe("device flow — the server owns the canonical interaction", () => {
  it("echoes exactly the server-issued shortcode and URIs, inventing none", async () => {
    const device = {
      device_code: "server-device-code",
      user_code: "WXYZ-1234",
      verification_uri: `${ISSUER}/activate`,
      verification_uri_complete: `${ISSUER}/activate?code=WXYZ-1234`,
      expires_in: 600,
      interval: 1,
    };
    const start = await client(
      fetchWith(device, { error: "authorization_pending" }),
    ).start();
    // Every user-facing value is the server's, byte for byte.
    expect(start.userCode).toBe(device.user_code);
    expect(start.verificationUri).toBe(device.verification_uri);
    expect(start.verificationUriComplete).toBe(
      device.verification_uri_complete,
    );
    // The safe view carries no device_code and no subject/principal fields —
    // there is nothing here the client could have minted.
    expect(Object.keys(start).sort()).toEqual([
      "expiresIn",
      "intervalSeconds",
      "userCode",
      "verificationUri",
      "verificationUriComplete",
    ]);
  });

  it("returns the server's tokens untouched, adding no subject or proof", async () => {
    const tokens = {
      access_token: "server-access-token",
      token_type: "Bearer",
      id_token: "server-id-token",
      expires_in: 3600,
    };
    const c = client(
      fetchWith(
        {
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: `${ISSUER}/activate`,
          expires_in: 600,
          interval: 1,
        },
        tokens,
      ),
    );
    await c.start();
    const result = await c.pollUntilComplete();
    // The subject is whatever the server's token names; the client neither
    // reads a principal id from a form nor stamps one of its own.
    expect(result).toEqual(tokens);
    for (const forbidden of [
      "subject",
      "subjectId",
      "principalId",
      "boundDigest",
      "approvalProof",
    ]) {
      expect(forbidden in result).toBe(false);
    }
  });
});

describe("device flow client — no identity or proof minting (source pact)", () => {
  const source = readFileSync(join(here, "device-flow.ts"), "utf8");

  it("imports no randomness source", () => {
    for (const token of [
      "node:crypto",
      "randomBytes",
      "randomUUID",
      "getRandomValues",
      "Math.random",
    ]) {
      expect(
        source.includes(token),
        `device-flow.ts must not use ${token}`,
      ).toBe(false);
    }
  });

  it("constructs no interaction subject or approval proof", () => {
    for (const token of [
      "subjectId",
      "principalId",
      "boundDigest",
      "ApprovalProof",
      "approvalProof",
    ]) {
      expect(
        source.includes(token),
        `device-flow.ts must not construct ${token}`,
      ).toBe(false);
    }
  });
});
