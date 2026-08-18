import { describe, expect, it } from "vitest";
import { assertSourceOrder } from "@opensesame/testing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QrEncodeError, encodeQrTerminal } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — QR payload fence", () => {
  it("adversarial: empty payload is refused before encode", () => {
    assertSourceOrder(readFileSync(join(here, "index.ts"), "utf8"), [
      "function assertPayload",
      "if (!trimmed)",
      "throw new QrEncodeError",
    ]);
    expect(() => encodeQrTerminal("")).toThrow(QrEncodeError);
  });
});
