import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAge } from "./age-lib.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.|test-support/.test(name)
      ? [path]
      : [];
  });
}

describe("the age door", () => {
  it("loads the library once, and a second caller gets the same load", async () => {
    const first = loadAge();
    expect(loadAge()).toBe(first);
    expect((await first).Encrypter).toBeDefined();
  });

  it("is the only production module that names age-encryption, and only through import()", () => {
    const offenders = sources(SRC).filter((path) => {
      const text = readFileSync(path, "utf8");
      const named = /["']age-encryption["']/.test(text);
      if (!named) return false;
      if (path.endsWith("lib/age-lib.ts")) return false;
      return true;
    });
    expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
    const door = readFileSync(join(SRC, "lib/age-lib.ts"), "utf8");
    expect(door).not.toMatch(/^import .* from "age-encryption"/m);
  });
});
