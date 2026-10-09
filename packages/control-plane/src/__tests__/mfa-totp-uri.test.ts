import { overlapCast } from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { base32Encode } from "../routes/mfa.js";

type App = ReturnType<typeof createControlPlane>["app"];

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Independent decoder: the test must not reuse the implementation's tables. */
function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

describe("base32Encode", () => {
  // RFC 4648 §10 test vectors, padding stripped (the Key URI Format is unpadded).
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("encodes %j as %j", (input, expected) => {
    expect(base32Encode(Buffer.from(input, "utf8"))).toBe(expected);
  });

  it("round-trips arbitrary byte strings", () => {
    for (let length = 0; length <= 32; length += 1) {
      const bytes = Buffer.from(
        Array.from({ length }, (_unused, index) => (index * 37 + 11) % 256),
      );
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it("round-trips arbitrary byte strings (property)", () => {
    // The vector cases above pin the encoding; this covers the lengths and
    // bit-boundary alignments no hand-written fixture enumerates.
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 128 }), (bytes) => {
        const encoded = base32Encode(bytes);
        expect(encoded).toMatch(/^[A-Z2-7]*$/u);
        expect(base32Decode(encoded)).toEqual(Buffer.from(bytes));
      }),
    );
  });

  it("emits only RFC 4648 alphabet characters", () => {
    const bytes = Buffer.from(
      Array.from({ length: 20 }, (_unused, index) => (index * 91) % 256),
    );
    expect(base32Encode(bytes)).toMatch(/^[A-Z2-7]+$/u);
  });
});

describe("TOTP enrollment URI", () => {
  it("publishes the secret as base32 that decodes to the stored key", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);

    const res = await app.request("/v1/mfa/totp/enroll", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = overlapCast(await res.json());

    const secretParam = new URL(
      String(body.otpauthUrl).replace("otpauth://", "https://"),
    ).searchParams.get("secret");
    expect(secretParam).toBeTruthy();

    // Authenticator apps base32-decode this parameter verbatim. It must yield
    // exactly the bytes the verify path checks against, or every code mismatches.
    const stored = Buffer.from(String(body.secret), "base64");
    expect(base32Decode(String(secretParam))).toEqual(stored);
    expect(secretParam).toMatch(/^[A-Z2-7]+$/u);

    // The same bytes are what the server retained for verification.
    const principalId = String(owner.principalId ?? owner.id);
    const retained = ctx.stores.totpSecrets.get(principalId);
    if (retained) {
      expect(Buffer.from(retained, "base64")).toEqual(stored);
    }
  });
});
