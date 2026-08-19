import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { QrEncodeError, encodeQrSize, encodeQrTerminal } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — QR payload fence", () => {
  it("adversarial: empty payload is refused before encode", () => {
    assertSourceOrder(readFileSync(join(here, "index.ts"), "utf8"), [
      "function assertPayload",
      "if (!trimmed)",
      "throw new QrEncodeError",
    ]);
    expect(() => encodeQrTerminal("")).toThrow(QrEncodeError);
    expect(() => encodeQrTerminal("   ")).toThrow(QrEncodeError);
  });

  it("property: the same payload encodes to a stable matrix size", () => {
    const sizes = Array.from({ length: 16 }, () => encodeQrSize("opensesame"));
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeGreaterThan(0);
  });

  it("chaos: concurrent encodes of one payload stay identical", async () => {
    const rows = await Promise.all(
      Array.from({ length: 16 }, () =>
        Promise.resolve(encodeQrTerminal("opensesame")),
      ),
    );
    expect(new Set(rows).size).toBe(1);
  });

  it("contract: QrEncodeError is the only public encode failure", () => {
    try {
      encodeQrTerminal("");
    } catch (e) {
      expect(e).toBeInstanceOf(QrEncodeError);
      expect((e as Error).name).toBe("QrEncodeError");
    }
  });
});
