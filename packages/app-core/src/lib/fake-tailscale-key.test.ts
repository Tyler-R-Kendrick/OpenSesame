import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  fakeTailscaleApiKey,
  fakeTailscaleAuthKey,
  fakeTailscaleClientKey,
} from "./fake-tailscale-key.js";
import { TOKEN as TOKEN_PATTERN } from "./native-tailscale-api.js";

const libRoot = fileURLToPath(new URL(".", import.meta.url));
const generatorBasename = "fake-tailscale-key.ts";

/** Matches committed Tailscale credential literals secret scanning would flag. */
const LITERAL = /tskey-(?:api|client|auth)-[A-Za-z0-9][A-Za-z0-9_-]{7,299}/;

const ALLOWED_LINE = (line: string): boolean => {
  if (line.includes("…")) return true;
  if (/\^tskey-/.test(line)) return true;
  if (/startsWith\s*\(\s*["']tskey-/.test(line)) return true;
  if (/\.not\.toContain\s*\(\s*["']tskey-/.test(line)) return true;
  if (/tskey-(?:api|client|auth)-["']\s*\)/.test(line)) return true;
  if (/LITERAL\s*=/.test(line)) return true;
  return false;
};

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === "__tests__") continue;
      files.push(...walkTsFiles(path));
      continue;
    }
    if (name.endsWith(".ts")) files.push(path);
  }
  return files;
}

it("mints fake Tailscale keys that satisfy the production format check", () => {
  for (const value of [
    fakeTailscaleApiKey(),
    fakeTailscaleClientKey(),
    fakeTailscaleAuthKey(),
  ]) {
    expect(value).toMatch(TOKEN_PATTERN);
    expect(value).toContain("FAKE0TEST");
  }
});

it("keeps Tailscale tskey literals out of committed app-core lib sources", () => {
  const violations: string[] = [];
  for (const path of walkTsFiles(libRoot)) {
    if (path.endsWith(generatorBasename)) continue;
    const rel = relative(libRoot, path);
    const lines = readFileSync(path, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (ALLOWED_LINE(line)) continue;
      if (LITERAL.test(line)) {
        violations.push(`${rel}:${index + 1}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
