import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { totpCode } from "../routes/mfa.js";

// ADR 0139: the dev TOTP factor computes the same codes as every other
// implementation (spec/conformance/otp-cases.json). It is SHA-1 only.
const cases = JSON.parse(
  readFileSync(
    new URL("../../../../spec/conformance/otp-cases.json", import.meta.url),
    "utf8",
  ),
);

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Bytes(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

type Sha1Case = {
  name: string;
  secret: string;
  digits: number;
  period: number;
  at: number;
  code: string;
};

function sha1Totp(c: {
  name: string;
  kind: string;
  uri: string;
  atSeconds?: number;
  code: string;
}): Sha1Case | null {
  if (c.kind !== "totp" || c.atSeconds === undefined) return null;
  if (!c.uri.includes(":")) {
    return { ...c, secret: c.uri, digits: 6, period: 30, at: c.atSeconds };
  }
  const url = new URL(c.uri);
  if ((url.searchParams.get("algorithm") ?? "SHA1") !== "SHA1") return null;
  return {
    name: c.name,
    code: c.code,
    secret: url.searchParams.get("secret") ?? "",
    digits: Number(url.searchParams.get("digits") ?? 6),
    period: Number(url.searchParams.get("period") ?? 30),
    at: c.atSeconds,
  };
}

describe("dev TOTP conformance", () => {
  const usable: Sha1Case[] = cases.codes
    .map(sha1Totp)
    .filter((c: Sha1Case | null): c is Sha1Case => c !== null);

  it("has cases to check", () => {
    expect(usable.length).toBeGreaterThan(3);
  });

  for (const c of usable) {
    it(c.name, () => {
      const secret = base32Bytes(c.secret.replace(/\s/g, "")).toString(
        "base64",
      );
      expect(totpCode(secret, c.period, c.digits, c.at * 1000)).toBe(c.code);
    });
  }
});
