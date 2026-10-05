import { describe, expect, it } from "vitest";
import { bundleMatrix, deepForPaths } from "./ci-changed-areas.mjs";

/**
 * Whether a diff is deep decides whether the browser gates for identity,
 * sign-in, storage and the device's inbox are started at all. A wrong "not
 * deep" skips a gate a change needed, so each case is a path and why.
 */
describe("a diff that stays inside the UI-local regions", () => {
  it.each([
    [
      "a control",
      "apps/pages/src/components/context-menu/context-menu-input.ts",
    ],
    ["a style", "apps/pages/src/sections/vault.css"],
    ["the vault's own screens", "apps/pages/src/sections/vault/NewItemFab.tsx"],
    ["a tutorial", "apps/pages/src/tutorial/registry/react.tsx"],
    [
      "the tutorial library",
      "packages/app-core/src/tutorial/registry/goals.ts",
    ],
    ["the keymap", "packages/app-core/src/lib/keymap/gestures.ts"],
    ["a gesture helper", "apps/pages/src/lib/tab-swipe.ts"],
    [
      "the source classification",
      "apps/pages/src/lib/capabilities/classification-lib.ts",
    ],
    ["a test anywhere", "apps/pages/src/lib/vault/store.test.ts"],
    ["the quality tooling", "scripts/quality/design-lint.mjs"],
    ["a ledger", "tools/quality/design-radius-baseline.json"],
    ["the phone walk's steps", "apps/pages/scripts/lib/phone-vault.mjs"],
    ["the evidence tooling", "apps/pages/scripts/lib/capture-hold-steps.mjs"],
    ["a doc", "DESIGN.md"],
  ])("is not deep: %s", (_, path) => {
    expect(deepForPaths([path])).toBe(false);
  });

  it("is not deep when every path is one of them", () => {
    expect(
      deepForPaths([
        "apps/pages/src/sections/vault/add-slide.ts",
        "apps/pages/src/sections/vault/add-slide.css",
        "docs/evidence/2026-10-05-add-button-slide/README.md",
      ]),
    ).toBe(false);
    expect(deepForPaths([])).toBe(false);
  });
});

describe("a diff that can reach identity, sign-in, storage or boot", () => {
  it.each([
    ["the boot path", "apps/pages/src/app-root.tsx"],
    ["the unlock screen", "apps/pages/src/screens/UnlockScreen.tsx"],
    ["the vault store", "apps/pages/src/lib/vault/store.ts"],
    ["app-core's storage", "packages/app-core/src/lib/at-rest/cipher.ts"],
    ["the vault format", "packages/vault-core/src/index.ts"],
    ["the Identity API", "packages/control-plane/src/app.ts"],
    ["a Rust crate", "crates/sealed-store/src/lib.rs"],
    ["the workflow itself", ".github/workflows/ci.yml"],
    ["the classifier itself", "scripts/lib/ci-changed-areas.mjs"],
    ["a gate's own script", "apps/pages/scripts/verify-auth-flow.mjs"],
    ["a path nobody classified", "ops/compose/docker-compose.yml"],
    ["a lockfile", "pnpm-lock.yaml"],
  ])("is deep: %s", (_, path) => {
    expect(deepForPaths([path])).toBe(true);
  });

  it("is deep when one path of many is", () => {
    expect(
      deepForPaths([
        "apps/pages/src/sections/vault/add-slide.ts",
        "apps/pages/src/lib/vault/store.ts",
      ]),
    ).toBe(true);
  });
});

describe("the bundle job's matrix for a diff", () => {
  const names = (deep) => bundleMatrix(deep).include.map((leg) => leg.shard);

  it("has every leg when the diff is deep", () => {
    expect(names(true)).toEqual([
      "budgets",
      "keyboard",
      "sign-in",
      "static",
      "auth",
      "customer-crypto",
      "journeys",
      "mobile-320",
      "mobile-390",
      "mobile-430",
      "mobile-landscape",
    ]);
  });

  it("leaves out exactly the identity and crypto legs when it is not", () => {
    const left = names(true).filter((name) => !names(false).includes(name));
    expect(left).toEqual(["sign-in", "auth", "customer-crypto"]);
    // The gates that guard the shell itself still run for a UI-local diff.
    for (const kept of [
      "budgets",
      "keyboard",
      "static",
      "journeys",
      "mobile-390",
    ]) {
      expect(names(false)).toContain(kept);
    }
  });

  it("keeps the mobile legs' sizes", () => {
    const phone = bundleMatrix(false).include.find(
      (leg) => leg.shard === "mobile-320",
    );
    expect(phone.sizes).toBe("320,tablet-portrait,tablet-landscape");
  });
});
