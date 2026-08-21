import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { sealDevOnly } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — client-core sealed store", () => {
  it("sealDevOnly is production-forbidden before XOR", () => {
    assertSourceOrder(readFileSync(join(here, "index.ts"), "utf8"), [
      "export function sealDevOnly",
      "if (!isDevOrTestEnv())",
      "sealDevOnly is forbidden",
    ]);
    expect(readFileSync(join(here, "index.ts"), "utf8")).not.toMatch(
      /getSecret\s*\(/,
    );
  });

  it("chaos: production-like env never XORs", () => {
    // SAFETY: tests only access the optional process env seam on the Node global.
    const g = globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    };
    const prev = g.process?.env?.NODE_ENV;
    if (g.process?.env) g.process.env.NODE_ENV = "production";
    try {
      expect(() =>
        sealDevOnly(new Uint8Array([1]), new Uint8Array([2])),
      ).toThrow(/forbidden outside dev\/test/);
    } finally {
      if (g.process?.env && prev !== undefined) g.process.env.NODE_ENV = prev;
    }
  });
});
