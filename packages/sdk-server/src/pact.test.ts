import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertSourceOrder } from "@opensesame/testing";
import { createOpenSesameVerifier } from "./verifier.js";
import { DEFAULT_ALLOWED_ALGORITHMS } from "./verifier.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — resource-server verifier", () => {
  it("contract: default algorithms are asymmetric only", () => {
    expect(DEFAULT_ALLOWED_ALGORITHMS.some((alg) => alg.startsWith("HS"))).toBe(
      false,
    );
    expect(DEFAULT_ALLOWED_ALGORITHMS).not.toContain("none");
  });

  it("source: required claims include exp before verify", () => {
    assertSourceOrder(readFileSync(join(here, "verifier.ts"), "utf8"), [
      'const REQUIRED_CLAIMS = ["iss", "sub", "aud", "exp"]',
      "jwtVerify",
    ]);
  });

  it("chaos: discovery partition still rejects the token", async () => {
    const verifier = createOpenSesameVerifier({
      issuer: "http://127.0.0.1:8788",
      audience: "rp-alpha",
      fetchImpl: async () => {
        throw new Error("partition");
      },
    });
    await expect(verifier.verifyAccessToken("not.a.jwt")).rejects.toThrow();
  });
});
