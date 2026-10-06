import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");

async function load(env) {
  vi.resetModules();
  if (env === undefined)
    Reflect.deleteProperty(process.env, "PAGES_EXPECT_TIMEOUT_MS");
  else process.env.PAGES_EXPECT_TIMEOUT_MS = env;
  return import("./expect-timeout.mjs");
}

afterEach(() => {
  Reflect.deleteProperty(process.env, "PAGES_EXPECT_TIMEOUT_MS");
});

describe("expect timeout", () => {
  it("is thirty seconds unless a local run shortens it", async () => {
    expect((await load(undefined)).EXPECT_TIMEOUT_MS).toBe(30_000);
    expect((await load("2500")).EXPECT_TIMEOUT_MS).toBe(2500);
  });

  it("ignores a value that is not a positive number", async () => {
    for (const bad of ["", "abc", "0", "-5"]) {
      expect((await load(bad)).EXPECT_TIMEOUT_MS, bad).toBe(30_000);
    }
  });
});

const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

/** The script's relative-import closure, as paths under scripts/. */
function closure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let text;
    try {
      text = readFileSync(join(scripts, file), "utf8");
    } catch {
      continue;
    }
    for (const [, spec] of text.matchAll(IMPORT)) {
      if (spec.startsWith(".")) {
        queue.push(normalize(join(dirname(file), spec)));
      }
    }
  }
  return seen;
}

describe("every verify script that asserts with Playwright", () => {
  const entries = readdirSync(scripts).filter((name) =>
    /^verify-.*(?<!\.test)\.mjs$/.test(name),
  );

  it("is under the one expect timeout", () => {
    const missing = [];
    for (const entry of entries) {
      const files = [...closure(entry)];
      const usesExpect = files.some((file) => {
        try {
          const text = readFileSync(join(scripts, file), "utf8");
          return /@playwright\/test/.test(text) && /\bexpect\b/.test(text);
        } catch {
          return false;
        }
      });
      if (usesExpect && !files.includes(join("lib", "expect-timeout.mjs"))) {
        missing.push(entry);
      }
    }
    expect(missing).toEqual([]);
  });
});
