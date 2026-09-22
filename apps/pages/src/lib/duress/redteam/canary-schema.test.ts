/**
 * REDTEAM canary schema integrity.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCanaryEnrollment } from "../canary/schema.js";

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../canary/schema.ts",
);

describe("REDTEAM canary schema integrity", () => {
  it("regression: Number.isInteger used (RT-CANARY-002 closed)", () => {
    const src = readFileSync(schemaPath, "utf8");
    expect(src).not.toMatch(/Number\.isIntegereger/);
    expect(src).toMatch(/Number\.isInteger/);
  });

  it("parses enrollment with valid receiver without TypeError", () => {
    expect(() =>
      parseCanaryEnrollment({
        version: 1,
        canaryId: "canary-ok-01",
        kind: "honeytoken_open",
        tokenFingerprint: "a".repeat(32),
        enrolledAt: new Date().toISOString(),
        routeRevoked: false,
        receiver: {
          routeRef: "route-alert-1",
          templateRef: "tpl-1",
          maxRetries: 3,
          expiryMs: 60_000,
          retainOutboxAcrossRemoval: false,
        },
      }),
    ).not.toThrow();
  });
});
