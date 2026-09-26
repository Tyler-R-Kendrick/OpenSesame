import { describe, expect, it } from "vitest";
import { ecdsaRawToDer, randomSerial, toHex } from "./certificate.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("ecdsaRawToDer", () => {
  it("wraps r and s as minimal positive INTEGERs", () => {
    const raw = new Uint8Array(64);
    raw.fill(0x11, 0, 32);
    raw.fill(0x22, 32, 64);
    expect(hex(ecdsaRawToDer(raw))).toBe(
      `30440220${"11".repeat(32)}0220${"22".repeat(32)}`,
    );
  });

  it("pads a high-bit component and trims leading zeros", () => {
    const raw = new Uint8Array(64);
    raw.fill(0x80, 0, 32);
    raw[32] = 0;
    raw[33] = 0;
    raw.fill(0x01, 34, 64);
    expect(hex(ecdsaRawToDer(raw))).toBe(
      `3043022100${"80".repeat(32)}021e${"01".repeat(30)}`,
    );
  });

  it("refuses a signature that is not 64 bytes", () => {
    expect(() => ecdsaRawToDer(new Uint8Array(63))).toThrow(RangeError);
    expect(() => ecdsaRawToDer(new Uint8Array(72))).toThrow(RangeError);
  });
});

describe("randomSerial", () => {
  it("is 16 bytes, positive and minimal every time", () => {
    for (let round = 0; round < 512; round += 1) {
      const serial = randomSerial();
      expect(serial).toHaveLength(16);
      const first = serial[0] ?? 0;
      expect(first & 0x80).toBe(0);
      expect(first).not.toBe(0);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(
      Array.from({ length: 256 }, () => toHex(randomSerial())),
    );
    expect(seen.size).toBe(256);
  });
});

describe("toHex", () => {
  it("prints upper-case, zero-padded hex", () => {
    expect(toHex(Uint8Array.of(0x01, 0xab, 0x00))).toBe("01AB00");
  });
});
