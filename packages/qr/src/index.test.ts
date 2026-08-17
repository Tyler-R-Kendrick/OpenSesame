import { describe, expect, it } from "vitest";
import {
  QrEncodeError,
  encodeQrSize,
  encodeQrSvg,
  encodeQrTerminal,
} from "./index.js";

describe("encodeQrSvg", () => {
  it("rejects an empty payload", () => {
    expect(() => encodeQrSvg("")).toThrow(QrEncodeError);
    expect(() => encodeQrSvg("   ")).toThrow(/empty/u);
  });

  it("returns a deterministic SVG for a fixed payload", () => {
    const a = encodeQrSvg("https://example.test/device?user_code=ABCD-EFGH", {
      pixelSize: 4,
      border: 2,
    });
    const b = encodeQrSvg("https://example.test/device?user_code=ABCD-EFGH", {
      pixelSize: 4,
      border: 2,
    });
    expect(a).toBe(b);
    expect(a.startsWith("<svg")).toBe(true);
    expect(a).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(a).toContain("#000000");
  });
});

describe("encodeQrTerminal", () => {
  it("returns a multi-line Unicode block QR", () => {
    const text = encodeQrTerminal("ABCD-EFGH");
    expect(text.split("\n").length).toBeGreaterThan(4);
    expect(encodeQrSize("ABCD-EFGH")).toBeGreaterThan(10);
  });
});
