// Which browser gates a pull-request diff has to run.
//
// `ci-changed-areas.mjs` says whether the Pages build is in play at all (the
// `bundle` area). Inside it, this file says which of the gates run. A gate
// costs a runner for the minute and a half it takes to install and build
// before it walks anything, so a diff starts the gates its changed paths can
// reach and no others. The triggers are the ones AGENTS.md writes down for
// each gate ("Design rules that gate merges"); each rule below names its own.
//
// Two things keep a skip honest:
//   - A path nobody classified runs every gate. A wrong skip is worse than one
//     extra run, so a new directory costs a full run until a rule names it.
//   - A deleted path selects nothing. Whatever imported it changed in the same
//     diff (or the typecheck fails), and that change is classified itself.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { relayJoinPath, relayProcessGate } from "./ci-relay-join.mjs";
export { relayJoinPath };
export {
  ALL_GATES,
  DRIVER_GATES,
  JOB_GATES,
  SHARD_GATES,
  gateOfShard,
} from "./ci-gates-drivers.mjs";
export { driverReach, scriptGates } from "./ci-gates-reach.mjs";

import { ALL_GATES, gateOfShard } from "./ci-gates-drivers.mjs";
import { scriptGates } from "./ci-gates-reach.mjs";

const everyGate = () => new Set(ALL_GATES);
const gates = (...names) => new Set(names);

// --- paths ---------------------------------------------------------------

const DOC_ROOTS = ["docs", "skills", ".agents", ".claude"];

const under = (path, prefix) =>
  path === prefix || path.startsWith(`${prefix}/`);
const underAny = (path, prefixes) => prefixes.some((p) => under(path, p));

/** Prose never starts a gate. (Same set as ci-changed-areas.mjs.) */
export function isDocPath(path) {
  return (
    path.endsWith(".md") ||
    underAny(path, DOC_ROOTS) ||
    path.slice(path.lastIndexOf("/") + 1) === "LICENSE"
  );
}

/** A test runs in the unit suites and ships nothing a browser loads. */
export function isTestPath(path) {
  return (
    /\.(test|spec)(-support)?\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)__tests__\//.test(path) ||
    /\.fixture\.[cm]?[jt]sx?$/.test(path)
  );
}

const SCRIPTS = "apps/pages/scripts";

// --- the rules ------------------------------------------------------------

const PAGES_SRC = "apps/pages/src";
const GUIDE_TARGET =
  /useGuideTarget|useOptionalGuideTarget|tutorial\/registry\/react/;
const CORE_SRC = "packages/app-core/src";

const startsWithAny = (text, prefixes) =>
  prefixes.some((prefix) => text.startsWith(prefix));

function pagesLib(path) {
  const rest = path.slice(`${PAGES_SRC}/lib/`.length);
  if (startsWithAny(rest, ["keymap", "pane-escape", "focus"])) {
    if (rest.startsWith("keymap-targets")) {
      return gates("keyboard", "journeys", "budgets");
    }
    return gates("keyboard", "journeys", "budgets", "tutorials");
  }
  if (startsWithAny(rest, ["gesture", "use-gestures", "tab-swipe", "strip"])) {
    return gates("mobile", "keyboard", "budgets");
  }
  if (startsWithAny(rest, ["capabilities/"])) return gates("budgets");
  return everyGate();
}

function pagesSection(path) {
  const rest = path.slice(`${PAGES_SRC}/sections/`.length);
  const section = rest.split("/")[0];
  if (!rest.includes("/")) return gates("budgets", "journeys", "keyboard");
  if (section === "identity" || section === "access") {
    return gates("budgets", "journeys", "sign-in");
  }
  if (path.startsWith(`${PAGES_SRC}/sections/settings/security/`)) {
    return gates("budgets", "journeys", "auth", "device-identity");
  }
  return gates("budgets", "journeys");
}

function pagesSource(path) {
  const rest = path.slice(`${PAGES_SRC}/`.length);
  if (path.endsWith(".css")) return gates("budgets", "mobile");
  if (
    /^(main|app-root|App|sw|sw-push|vite-env)\.[a-z.]+$/.test(rest) ||
    underAny(rest, ["bootstrap", "host", "sw"])
  ) {
    return everyGate();
  }
  if (rest.startsWith("lib/")) return pagesLib(path);
  if (rest.startsWith("sections/")) return pagesSection(path);
  if (underAny(rest, ["components", "bindings"])) {
    return gates(
      "budgets",
      "keyboard",
      "mobile",
      "static",
      "journeys",
      "tutorials",
    );
  }
  if (under(rest, "tutorial")) return gates("budgets", "tutorials");
  if (under(rest, "webmcp")) return gates("budgets");
  return everyGate();
}

function coreSource(path) {
  const rest = path.slice(`${CORE_SRC}/`.length);
  if (under(rest, "tutorial")) return gates("budgets", "tutorials");
  if (under(rest, "webmcp")) return gates("budgets");
  if (under(rest, "sections")) return gates("budgets", "journeys", "tutorials");
  if (under(rest, "lib/keymap")) {
    return gates("keyboard", "journeys", "budgets", "tutorials");
  }
  if (under(rest, "lib/configuration")) return gates("budgets", "journeys");
  return everyGate();
}

function pagesOther(path, reach) {
  if (path.startsWith(`${SCRIPTS}/`)) return scriptGates(path, reach);
  if (under(path, "apps/pages/server")) return gates();
  if (under(path, "apps/pages/capability-profiles")) return gates("budgets");
  return everyGate();
}

export function gatesForPath(path, reach, read = () => "") {
  const out = gatesByPath(path, reach);
  if (
    out.size > 0 &&
    !out.has("tutorials") &&
    path.startsWith(`${PAGES_SRC}/`) &&
    /\.[cm]?[jt]sx?$/.test(path) &&
    GUIDE_TARGET.test(read(path))
  ) {
    out.add("tutorials");
  }
  return out;
}

function gatesByPath(path, reach) {
  if (isDocPath(path) || isTestPath(path)) return gates();
  if (relayProcessGate(path)) return gates("journeys");
  if (path === ".github/workflows/ci.yml") return everyGate();
  if (path === "tools/quality/bundle-budgets.json") return gates("budgets");
  if (path.startsWith(`${PAGES_SRC}/`)) return pagesSource(path);
  if (path.startsWith("apps/pages/")) return pagesOther(path, reach);
  if (path.startsWith(`${CORE_SRC}/`)) return coreSource(path);
  if (
    underAny(path, [
      "packages/guide-lang",
      "packages/guide-runtime",
      "packages/support-agent",
    ])
  ) {
    return gates("budgets", "tutorials");
  }
  if (under(path, "packages/webmcp")) return gates("budgets");
  return everyGate();
}

export function gatesForPaths(paths, reach, read = () => "") {
  const out = gates();
  for (const path of paths) {
    for (const gate of gatesForPath(path, reach, read)) out.add(gate);
  }
  return out;
}

export function bundleMatrix(wanted, shards) {
  const set = new Set(wanted);
  return shards.filter((leg) => set.has(gateOfShard(leg.shard)));
}

export function loadShards(root) {
  return JSON.parse(
    readFileSync(join(root, "scripts/lib/ci-bundle-shards.json"), "utf8"),
  );
}
