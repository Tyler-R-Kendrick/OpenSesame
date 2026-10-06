// Whether a pull-request diff is `deep`, and the bundle job's legs for it.
//
// The browser gates that guard identity, sign-in, storage and the device's own
// inbox (sign-in, auth, customer-crypto, Web Push, device identity, device
// inbox) run only when a changed path can reach them. A diff that stays inside
// the UI-local regions below (a control, a style, a tutorial, the keymap, the
// quality tooling, a test) cannot, so those jobs are not started at all: each
// costs a runner for the minute and a half it takes to install and build before
// it walks anything. A path nobody classified is deep: a wrong skip is worse
// than one extra run.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  anyUnder,
  isDoc,
  normalizePath,
  repoRootFromHere,
} from "./ci-paths.mjs";

// Regions whose code a person sees and touches but which hold no identity,
// sign-in, storage or boot logic. A path outside every region (and outside the
// docs) makes the diff deep, so a path nobody classified runs everything.
const UI_LOCAL_DIRS = [
  "apps/pages/src/components",
  "apps/pages/src/tutorial",
  "apps/pages/src/sections/vault",
  "apps/pages/src/sections/settings/keybindings",
  "apps/pages/src/modules/vault.interop-formats",
  "packages/app-core/src/tutorial",
  "packages/app-core/src/lib/keymap",
  "scripts/quality",
  "tools/quality",
];
// Files of `apps/pages/src/lib` that are input and layout helpers.
const UI_LOCAL_LIB = [
  "gesture",
  "use-gestures",
  "tab-swipe",
  "strip",
  "keymap",
  "use-claimed-drags",
  "capabilities/classification",
];
// The phone walk's steps and the evidence tooling; the gates themselves
// (`verify-*.mjs`) are not here, so changing one runs everything.
const UI_LOCAL_PAGES_SCRIPTS = [
  "apps/pages/scripts/capture-evidence.mjs",
  "apps/pages/scripts/lib/capture-",
  "apps/pages/scripts/lib/phone-",
];

export function isUiLocal(path) {
  // A test runs in the unit suites and ships nothing.
  if (/\.test(-support)?\.[cm]?[jt]sx?$/.test(path)) return true;
  if (path.startsWith("apps/pages/src/") && path.endsWith(".css")) return true;
  if (anyUnder(path, UI_LOCAL_DIRS)) return true;
  if (path.startsWith("apps/pages/src/lib/")) {
    const rest = path.slice("apps/pages/src/lib/".length);
    if (UI_LOCAL_LIB.some((name) => rest.startsWith(name))) return true;
  }
  return UI_LOCAL_PAGES_SCRIPTS.some((prefix) => path.startsWith(prefix));
}

/**
 * Whether a diff can reach identity, sign-in, storage or the device's inbox:
 * any non-doc path outside the UI-local regions.
 * @param {string[]} paths
 */
export function deepForPaths(paths) {
  return paths.some((raw) => {
    const path = normalizePath(raw);
    return path !== "" && !isDoc(path) && !isUiLocal(path);
  });
}

/**
 * The bundle job's matrix legs for a diff (`ci-bundle-shards.json` is the one
 * list): every leg when the diff is deep, the others when it is not.
 */
export function bundleMatrix(deep, root = repoRootFromHere()) {
  const legs = JSON.parse(
    readFileSync(join(root, "scripts/lib/ci-bundle-shards.json"), "utf8"),
  );
  const include = legs
    .filter((leg) => deep || leg.deep !== true)
    .map(({ shard, sizes }) => (sizes ? { shard, sizes } : { shard }));
  return { include };
}
