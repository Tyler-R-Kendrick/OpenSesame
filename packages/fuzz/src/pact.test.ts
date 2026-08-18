import { describe, expect, it } from "vitest";
import {
  assertDurableSurvivesPartition,
  assertNoSecretFields,
} from "@opensesame/testing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSecretFields as fuzzOracle } from "./oracles.js";
import { redactAuditMetadata } from "@opensesame/audit";
import { canTransitionClaim } from "@opensesame/os-domain";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — fuzz oracles", () => {
  it("property: terminal claims stay terminal across many pairs", () => {
    for (const from of ["completed", "revoked", "denied", "expired"] as const) {
      expect(canTransitionClaim(from, "pending")).toBe(false);
      expect(canTransitionClaim(from, "presented")).toBe(false);
    }
  });

  it("adversarial: secret fields must not survive redaction", () => {
    expect(() =>
      fuzzOracle({ action: "ok", access_token: "s", refresh_token: "r" }, (v) =>
        redactAuditMetadata(v as Record<string, unknown>),
      ),
    ).not.toThrow();
  });

  it("chaos: a throwing redact still leaves the oracle able to fail closed", async () => {
    await assertDurableSurvivesPartition(
      () => 1,
      async () => {
        throw new Error("oracle partition");
      },
    );
  });

  it("contract: oracles walk keys rather than string-searching token_type", () => {
    const src = readFileSync(join(here, "oracles.ts"), "utf8");
    expect(src).toContain("SECRET_NEEDLES");
    expect(src).toContain("function walk");
    expect(src).toContain("secret field");
    expect(src.indexOf("SECRET_NEEDLES")).toBeLessThan(src.indexOf("function walk"));
    assertNoSecretFields({ action: "ok" });
  });
});
