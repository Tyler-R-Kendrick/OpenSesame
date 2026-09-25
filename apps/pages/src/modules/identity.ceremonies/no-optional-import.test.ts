/**
 * The always-on ceremonies module carries the recipient's side of a drop and
 * nothing of the sender's (ADR 0140 D2, ADR 0130): nothing in this directory
 * imports the `sharing.drops` module, the sealing and claim-session code in
 * `lib/vault/drop*` or the device-native claim plane, statically or lazily.
 * Opening goes through `lib/claims/drop-open.ts`, which is core.
 * `verify:capability-graph` proves the same of the built chunks; this names
 * the rule where it would break.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** Import specifiers, with comments (which name the rule) left out. */
function specifiers(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("identity.ceremonies imports no drop-sending code", () => {
  const files = readdirSync(here).filter(
    (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
  );

  it("sweeps every source file of the module", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "ClaimRoute.tsx",
        "DropClaimScreen.tsx",
        "runtime.ts",
      ]),
    );
  });

  it.each(files)("%s", (name) => {
    const found = specifiers(readFileSync(join(here, name), "utf8"));
    for (const specifier of found) {
      expect(specifier).not.toMatch(
        /sharing\.drops|lib\/vault\/drop|local-drop-claims/,
      );
    }
  });
});
