/**
 * Audit harness only — locks code facts cited in
 * `docs/audits/2026-10-07-persona-findings-validation.md`.
 * Not a product behavior change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

describe("persona findings validation (Oct 2026) — code anchors", () => {
  it("shareOnce is documented as not creating a vault record", () => {
    const drop = readFileSync(
      join(ROOT, "packages/app-core/src/lib/vault/drop.ts"),
      "utf8",
    );
    expect(drop).toMatch(/A one-time share of text already stored on an item\. No vault record\./);
  });

  it("local drop claims cap wrong codes at five attempts", () => {
    const claims = readFileSync(
      join(ROOT, "packages/app-core/src/lib/vault/local-drop-claims.ts"),
      "utf8",
    );
    expect(claims).toMatch(/MAX_ATTEMPTS = 5/);
    expect(claims).toMatch(/too_many_attempts/);
  });

  it("household sharing runtime registers no UI", () => {
    const household = readFileSync(
      join(ROOT, "apps/pages/src/modules/sharing.household/runtime.ts"),
      "utf8",
    );
    expect(household).toMatch(/registers nothing/);
    expect(household).not.toMatch(/activation\.register/);
  });
});
