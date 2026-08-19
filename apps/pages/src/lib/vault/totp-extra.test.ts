import { describe, expect, it } from "vitest";
import {
  TotpParseError,
  decodeBase32,
  parseTotp,
  secondsRemaining,
  totpSetupUri,
} from "./totp.js";

describe("decodeBase32", () => {
  it("rejects empty and undecodable secrets", () => {
    expect(() => decodeBase32("")).toThrow(TotpParseError);
    expect(() => decodeBase32("   ")).toThrow(/empty/);
    expect(() => decodeBase32("====")).toThrow(/empty/);
    // One valid character carries five bits — not even a whole byte.
    expect(() => decodeBase32("A")).toThrow(/no bytes/);
    expect(() => decodeBase32("JBSWY3DP!")).toThrow(/unexpected character/);
  });

  it("tolerates lowercase, spaces, dashes, and padding", () => {
    const clean = decodeBase32("JBSWY3DPEHPK3PXP");
    expect(decodeBase32("jbsw y3dp-ehpk 3pxp==")).toEqual(clean);
  });
});

describe("parseTotp", () => {
  it("rejects blank input and otpauth URIs without a secret", () => {
    expect(() => parseTotp("   ")).toThrow(/empty/);
    expect(() => parseTotp("otpauth://totp/label")).toThrow(/no secret/);
  });

  it("reads algorithm, digits, and period parameters", () => {
    const sha256 = parseTotp(
      "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60",
    );
    expect(sha256.algorithm).toBe("SHA-256");
    expect(sha256.digits).toBe(8);
    expect(sha256.period).toBe(60);

    const sha512 = parseTotp(
      "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=sha-512",
    );
    expect(sha512.algorithm).toBe("SHA-512");

    const sha1 = parseTotp(
      "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1",
    );
    expect(sha1.algorithm).toBe("SHA-1");
  });

  it("rejects unknown algorithms", () => {
    expect(() =>
      parseTotp("otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=MD5"),
    ).toThrow(/unsupported hash algorithm/);
  });

  it("falls back to RFC defaults for out-of-range digits and periods", () => {
    const weird = parseTotp(
      "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&digits=4&period=0",
    );
    expect(weird.digits).toBe(6);
    expect(weird.period).toBe(30);

    const notNumbers = parseTotp(
      "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&digits=lots&period=soon",
    );
    expect(notNumbers.digits).toBe(6);
    expect(notNumbers.period).toBe(30);
  });

  it("treats a bare seed as SHA-1, 6 digits, 30 seconds", () => {
    const config = parseTotp("jbswy3dpehpk3pxp");
    expect(config.algorithm).toBe("SHA-1");
    expect(config.digits).toBe(6);
    expect(config.period).toBe(30);
  });
});

describe("totpSetupUri", () => {
  it("rejects empty input", () => {
    expect(() => totpSetupUri("  ")).toThrow(/empty/);
  });

  it("passes a valid otpauth URI through untouched", () => {
    const uri = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8";
    expect(totpSetupUri(uri)).toBe(uri);
  });

  it("validates the passthrough instead of trusting the scheme", () => {
    expect(() => totpSetupUri("otpauth://totp/x")).toThrow(TotpParseError);
  });

  it("builds an enrollment URI from a bare seed", () => {
    const uri = totpSetupUri("jbsw y3dp-ehpk 3pxp", {
      label: "Work vault",
      issuer: "OpenSesame",
    });
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.host).toBe("totp");
    expect(decodeURIComponent(parsed.pathname)).toBe("/Work vault");
    expect(parsed.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(parsed.searchParams.get("issuer")).toBe("OpenSesame");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
  });
});

describe("secondsRemaining", () => {
  it("counts down within the period", () => {
    expect(secondsRemaining(30, 0)).toBe(30);
    expect(secondsRemaining(30, 10_000)).toBe(20);
    expect(secondsRemaining(30, 29_000)).toBe(1);
    expect(secondsRemaining(30, 30_000)).toBe(30);
  });
});
