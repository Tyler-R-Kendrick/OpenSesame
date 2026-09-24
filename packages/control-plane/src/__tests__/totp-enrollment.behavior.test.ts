import { createHmac } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

/**
 * Behaviour: a person enrols TOTP, their authenticator app reads the QR, and
 * the code it shows them is accepted.
 *
 * Given/When/Then without a second framework — same decision as
 * apps/pages guest-login and the ceremony journeys.
 *
 * This is the test that would have caught the hex-secret bug. The unit tests
 * around it check that base32 encoding is correct; this one checks the thing
 * the user actually cares about, by doing what a real authenticator does:
 * take only the otpauth:// URI, base32-decode its `secret`, derive a code from
 * that key alone, and submit it. Any encoding the server publishes that its
 * own verifier does not expect fails here, whatever the encoder does in
 * isolation.
 */

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** What an authenticator app does with the `secret` query parameter. */
function authenticatorReadsSecret(base32: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of base32.replace(/=+$/u, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`authenticator cannot read "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** RFC 6238, as an authenticator app computes it: 30s step, 6 digits. */
function authenticatorShowsCode(key: Buffer, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return (bin % 10 ** 6).toString().padStart(6, "0");
}

describe("TOTP enrolment journey", () => {
  it("Given a principal enrolling TOTP, When their authenticator reads the QR, Then the code it shows is accepted", async () => {
    // Given — a signed-in principal on a deployment with dev MFA available.
    const { app } = createControlPlane({ config: testConfig() });
    const provisionalRes = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    expect(provisionalRes.status).toBe(201);
    const owner = overlapCast(await provisionalRes.json());
    const auth = { authorization: `Bearer ${owner.accessToken}` };

    // When — they enrol, and their authenticator scans the published URI.
    // It is given nothing else: no response field, no server-side state.
    const enrollRes = await app.request("/v1/mfa/totp/enroll", {
      method: "POST",
      headers: auth,
    });
    expect(enrollRes.status).toBe(200);
    const enrolled = overlapCast(await enrollRes.json());

    const scanned = new URL(
      String(enrolled.otpauthUrl).replace("otpauth://", "https://"),
    ).searchParams.get("secret");
    expect(scanned).toBeTruthy();

    const key = authenticatorReadsSecret(String(scanned));
    const code = authenticatorShowsCode(key);

    // Then — the six digits on their phone verify against the server.
    const verifyRes = await app.request("/v1/mfa/totp/verify", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(verifyRes.status).toBe(200);
    expect(overlapCast(await verifyRes.json()).ok).toBe(true);
  });

  it("Given an enrolled principal, When a code from a different key is submitted, Then it is refused", async () => {
    // Given — an enrolled principal.
    const { app } = createControlPlane({ config: testConfig() });
    const provisionalRes = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const owner = overlapCast(await provisionalRes.json());
    const auth = { authorization: `Bearer ${owner.accessToken}` };
    await app.request("/v1/mfa/totp/enroll", { method: "POST", headers: auth });

    // When — a code derived from unrelated key material is presented. This is
    // what the user saw before the enrolment URI published base32: a
    // well-formed six-digit code from the wrong key.
    const code = authenticatorShowsCode(Buffer.alloc(20, 0x42));

    // Then — the server refuses it rather than accepting a plausible shape.
    const verifyRes = await app.request("/v1/mfa/totp/verify", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(verifyRes.status).toBe(401);
    expect(overlapCast(await verifyRes.json()).ok).toBe(false);
  });
});
