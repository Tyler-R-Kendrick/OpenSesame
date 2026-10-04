/**
 * Seams a module exports for its one owner and for tests, and nothing else may
 * import (ADR 0160 §5a). Pure functions over a file map, so they are tested
 * without a checkout; scripts/quality/app-core-boundary.mjs lists the
 * candidate files and prints the report.
 *
 * The vault store does not hand out its body: it registers a port with
 * `store-device-key.ts` once, and the device identity key reads and writes the
 * body through the carrier installed there. `bodyPortOf`, `registerBodyPort`
 * and `installDeviceKeyCarrier` are how that wiring is done, and a caller
 * outside it holds the whole sealed body, so they are not for a module that
 * merely wants the identity key (it asks `device-identity-key.ts`). A TypeScript
 * `export` cannot say "this module and tests only", so this gate does.
 */

import { posix } from "node:path";
import { TEST_FILE } from "./app-core-boundary.mjs";

/**
 * @typedef {{
 *   module: string,
 *   names: string[],
 *   owners: string[],
 *   why: string,
 * }} RestrictedSeam
 */

/** @type {RestrictedSeam[]} */
export const RESTRICTED_SEAMS = [
  {
    module: "packages/app-core/src/lib/vault/store-device-key",
    names: ["bodyPortOf", "registerBodyPort", "installDeviceKeyCarrier"],
    owners: [
      // The module itself and the store that registers and installs.
      "packages/app-core/src/lib/vault/store-device-key.ts",
      "packages/app-core/src/lib/vault/store.ts",
      // The golden-vector generator builds its own store and installs a carrier.
      "apps/pages/scripts/vault-vectors/emit.ts",
    ],
    why: "they hand out the open vault's body; ask the device identity key instead",
  },
];

const EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const IMPORT_SPECIFIERS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\bvi\.(?:mock|doMock|importActual)\(\s*["']([^"']+)["']/g,
];
const APP_CORE_PREFIX = "@opensesame/app-core/";

/** The repo path (no extension) a specifier names from `from`, or null when it names none. */
export function resolveSpecifier(from, specifier) {
  const bare = specifier.replace(/[?#].*$/, "");
  const resolved = bare.startsWith(".")
    ? posix.join(posix.dirname(from), bare)
    : bare.startsWith(APP_CORE_PREFIX)
      ? posix.join("packages/app-core/src", bare.slice(APP_CORE_PREFIX.length))
      : null;
  return resolved === null ? null : resolved.replace(EXTENSION, "");
}

function specifiersOf(source) {
  const found = [];
  for (const pattern of IMPORT_SPECIFIERS) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/** Does `source` use `name` as a word anywhere? Any mention counts. */
function mentions(source, name) {
  return new RegExp(`\\b${name}\\b`).test(source);
}

/**
 * Every file that imports a restricted seam's module and uses one of its
 * restricted names (or re-exports the module whole), without being its owner
 * or a test.
 *
 * @param {Map<string, string>} files  repo-relative path -> source
 * @param {RestrictedSeam[]} [seams]
 * @returns {{ file: string, module: string, names: string[] }[]}
 */
export function findRestrictedImports(files, seams = RESTRICTED_SEAMS) {
  const violations = [];
  for (const [file, source] of files) {
    if (TEST_FILE.test(file)) continue;
    for (const seam of seams) {
      if (seam.owners.includes(file)) continue;
      const imports = specifiersOf(source).some(
        (specifier) => resolveSpecifier(file, specifier) === seam.module,
      );
      if (!imports) continue;
      const reExported = new RegExp(
        `export\\s+\\*\\s+from\\s*["'][^"']*${posix.basename(seam.module)}`,
      ).test(source);
      const names = seam.names.filter((name) => mentions(source, name));
      if (reExported || names.length > 0) {
        violations.push({
          file,
          module: seam.module,
          names: reExported ? ["*", ...names] : names,
        });
      }
    }
  }
  return violations;
}
