import { describe, expect, it } from "vitest";
import { encodeQrSvg, QrEncodeError } from "@opensesame/qr";
import { assertSourceOrder } from "@opensesame/testing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { b64urlToBytes, bytesToB64url } from "./webauthn.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — mobile-mfa", () => {
  it("property: b64url round-trips and never emits + / =", () => {
    const original = new Uint8Array([1, 2, 250, 255, 0, 61]);
    const encoded = bytesToB64url(original);
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...b64urlToBytes(encoded)]).toEqual([...original]);
  });

  it("adversarial: empty QR payloads are refused", () => {
    expect(() => encodeQrSvg("")).toThrow(QrEncodeError);
    expect(() => encodeQrSvg("   ")).toThrow(QrEncodeError);
    assertSourceOrder(readFileSync(join(here, "QrCode.tsx"), "utf8"), [
      "const trimmed = value.trim()",
      "if (!trimmed) return null",
      "encodeQrSvg(trimmed",
    ]);
  });

  it("chaos: concurrent encodes of the same challenge are stable", async () => {
    const payload = "opensesame-mfa-challenge";
    const svgs = await Promise.all(
      Array.from({ length: 16 }, () => Promise.resolve(encodeQrSvg(payload))),
    );
    expect(new Set(svgs).size).toBe(1);
  });

  it("contract: webauthn helpers do not log assertion bytes", () => {
    const src = readFileSync(join(here, "webauthn.ts"), "utf8");
    expect(src).not.toMatch(/console\.(log|debug|info)/);
    expect(src).toContain("bytesToB64url");
  });
});
