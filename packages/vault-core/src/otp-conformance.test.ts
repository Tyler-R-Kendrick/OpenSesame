import { describe, expect, it } from "vitest";
import cases from "../../../spec/conformance/otp-cases.json" with {
  type: "json",
};
import { hotpCode, parseHotp, parseTotp, totpCode } from "./totp.js";

// ADR 0139: the same cases crates/authenticator-core runs.

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("otp conformance: parseTotp", () => {
  for (const c of cases.parseTotp) {
    it(c.name, () => {
      if (!("expect" in c) || c.expect === undefined) {
        expect(() => parseTotp(c.input)).toThrow();
        return;
      }
      const config = parseTotp(c.input);
      expect({ ...config, secret: hex(config.secret) }).toEqual({
        secret: c.expect.secretHex,
        digits: c.expect.digits,
        period: c.expect.period,
        algorithm: c.expect.algorithm,
      });
    });
  }
});

describe("otp conformance: parseHotp", () => {
  for (const c of cases.parseHotp) {
    it(c.name, () => {
      if (!("expect" in c) || c.expect === undefined) {
        expect(() => parseHotp(c.input)).toThrow();
        return;
      }
      const config = parseHotp(c.input);
      expect({ ...config, secret: hex(config.secret) }).toEqual({
        secret: c.expect.secretHex,
        digits: c.expect.digits,
        counter: c.expect.counter,
        algorithm: c.expect.algorithm,
      });
    });
  }
});

describe("otp conformance: codes", () => {
  for (const c of cases.codes) {
    it(c.name, async () => {
      const code =
        c.kind === "hotp"
          ? await hotpCode(parseHotp(c.uri), c.counter)
          : await totpCode(parseTotp(c.uri), (c.atSeconds ?? 0) * 1000);
      expect(code).toBe(c.code);
    });
  }
});
