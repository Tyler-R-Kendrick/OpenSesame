/**
 * Shipped Pages UI must not surface the ownership-claim ceremony copy.
 * `/claim` is drop-receive only; token plumbing may stay in URLs/tests.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const BANNED = [
  "Accept a claim",
  "Open a claim",
  "Paste a claim",
  "Accept claim",
  "Claim accepted",
  "Claim waiting",
  "Claim to review",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (/\.(tsx|ts|css)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("drop-receive contract", () => {
  it("ships no Accept-a-claim / ownership-claim ceremony copy in Pages UI", () => {
    const hits: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      // Stub comment may name the removed screen once.
      if (file.endsWith("ClaimOpen.tsx")) continue;
      const text = readFileSync(file, "utf8");
      for (const phrase of BANNED) {
        if (text.includes(phrase)) hits.push(`${file}: ${phrase}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
