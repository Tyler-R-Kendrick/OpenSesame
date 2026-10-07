import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  coverageIncludePatterns,
  runtimeSourceInventory,
  validateRuntimeCoverage,
} from "./ts-coverage-scope.mjs";

test("actual extension and static RP layouts expand the source scope", () => {
  for (const name of [
    "apps/browser-extension",
    "apps/browser-extension-autofill",
  ]) {
    assert.deepEqual(coverageIncludePatterns(name), [
      "src/**/*.{ts,tsx}",
      "lib/**/*.{ts,tsx}",
      "runner/**/*.{ts,tsx}",
      "entrypoints/**/*.{ts,tsx}",
    ]);
  }
  assert.deepEqual(coverageIncludePatterns("examples/static-rp"), [
    "src/**/*.{ts,tsx}",
    "public/**/*.{ts,tsx}",
  ]);
  assert.deepEqual(coverageIncludePatterns("packages/app-core"), [
    "src/**/*.{ts,tsx}",
  ]);
});

test("inventory observes real production files, not declarations or test-only sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "ts-coverage-scope-"));
  try {
    for (const folder of ["src", "lib", "runner", "entrypoints"]) {
      mkdirSync(join(directory, folder));
    }
    for (const file of [
      "lib/secret.ts",
      "runner/write.ts",
      "entrypoints/background.tsx",
    ]) {
      writeFileSync(join(directory, file), "export const executed = true;");
    }
    writeFileSync(join(directory, "src/contracts.test.ts"), "test source");
    writeFileSync(
      join(directory, "src/contracts.d.ts"),
      "declare const value: string;",
    );
    const files = runtimeSourceInventory(directory, "apps/browser-extension");
    assert.equal(files.length, 3);
    assert.throws(
      () => validateRuntimeCoverage({}, files, "apps/browser-extension"),
      /No runtime instrumentation/u,
    );
    assert.deepEqual(
      runtimeSourceInventory(directory, "packages/app-core"),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("empty runtime reports cannot masquerade as denominator-zero passes", () => {
  assert.throws(
    () => validateRuntimeCoverage({}, ["src/main.ts"], "example"),
    /No runtime instrumentation/u,
  );
  assert.throws(
    () =>
      validateRuntimeCoverage(
        { "src/main.ts": { s: {}, f: {} } },
        ["src/main.ts"],
        "example",
      ),
    /No runtime instrumentation/u,
  );
  assert.deepEqual(validateRuntimeCoverage({}, [], "source-less"), {
    applicable: false,
    reason: "No TypeScript runtime sources.",
  });
});

test("instrumented zero-hit runtime remains measurable and fails its unchanged floor", () => {
  assert.deepEqual(
    validateRuntimeCoverage(
      { "src/main.ts": { s: { 0: 0 }, f: { 0: 0 } } },
      ["src/main.ts"],
      "example",
    ),
    { applicable: true },
  );
});

test("malformed top-level coverage is rejected", () => {
  for (const report of [null, [], "missing", 3]) {
    assert.throws(
      () => validateRuntimeCoverage(report, [], "example"),
      /Invalid TypeScript coverage report/u,
    );
  }
});

test("foreign instrumentation and malformed hit counts cannot admit the runtime report", () => {
  assert.throws(
    () =>
      validateRuntimeCoverage(
        {
          "other/main.ts": { s: { 0: 1 }, f: { 0: 1 } },
        },
        ["src/main.ts"],
        "example",
      ),
    /No runtime instrumentation/u,
  );
  for (const hits of [-1, "covered", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        validateRuntimeCoverage(
          {
            "src/main.ts": { s: { 0: hits }, f: { 0: 1 } },
          },
          ["src/main.ts"],
          "example",
        ),
      /Invalid runtime counters/u,
    );
  }
  assert.deepEqual(
    validateRuntimeCoverage(
      {
        "C:/example/src/main.ts": { s: { 0: 1 }, f: { 0: 1 } },
      },
      ["C:\\example\\src\\main.ts"],
      "example",
    ),
    { applicable: true },
  );
});
