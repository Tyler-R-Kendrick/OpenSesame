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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { relayJoinPath, relayProcessGate } from "./ci-relay-join.mjs";
export { relayJoinPath };
/** The gates the bundle job's shards run, by shard name (`mobile-*` is one). */
export const SHARD_GATES = [
  "budgets",
  "keyboard",
  "sign-in",
  "static",
  "auth",
  "customer-crypto",
  "journeys",
  "mobile",
];
/** The gates that are jobs of their own. */
export const JOB_GATES = [
  "tutorials",
  "device-inbox",
  "device-identity",
  "push",
];
export const ALL_GATES = [...SHARD_GATES, ...JOB_GATES];

const everyGate = () => new Set(ALL_GATES);
const gates = (...names) => new Set(names);

/** A shard's gate: `mobile-390` is the `mobile` gate, `journeys-1` the `journeys` one. */
export function gateOfShard(shard) {
  if (shard.startsWith("mobile-")) return "mobile";
  return shard.startsWith("journeys-") ? "journeys" : shard;
}

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

// --- the driver scripts of apps/pages/scripts -----------------------------

// Each `verify-*.mjs` and the gate whose shard or job runs it. A driver that
// no CI job runs is `null`: changing it starts nothing. The contract test
// fails on a driver missing from this table, so a new one forces a decision.
export const DRIVER_GATES = {
  "verify-keyboard.mjs": ["keyboard"],
  "verify-siop.mjs": ["keyboard"],
  "verify-mobile.mjs": ["mobile"],
  "verify-local-iam.mjs": ["sign-in"],
  "verify-static-origin.mjs": ["static"],
  "verify-encrypted-search.mjs": ["static"],
  "verify-auth-flow.mjs": ["auth"],
  "verify-experience-journeys.mjs": ["journeys"],
  // Vault Share PAM + secret drops (static PWA; restores S5/S6).
  "verify-share-pam.mjs": ["journeys"],
  "verify-webmcp.mjs": ["budgets"],
  "verify-push-worker.mjs": ["budgets"],
  "verify-capability-graph.mjs": ["budgets"],
  "verify-device-identity.mjs": ["device-identity"],
  "verify-device-inbox.mjs": ["device-inbox"],
  "verify-tutorials.mjs": ["tutorials"],
  "verify-tutorials-profiles.mjs": ["tutorials"],
  "verify-push.mjs": ["push"],
  // The contract suite's vitest blocks run in the TypeScript job; its browser
  // half is the gates above.
  "verify-experience.mjs": null,
  // Password parity has its own workflow and is not a ci.yml shard.
  "verify-password-agent.mjs": null,
  // Not run by any job of ci.yml.
  "verify-access-pathbar.mjs": null,
  "verify-ambient-sso.mjs": null,
  "verify-browser-cert.mjs": null,
  "verify-browser-session-lifecycle.mjs": null,
  "verify-browser-sessions.mjs": null,
  "verify-duress-browser.mjs": null,
  "verify-duress-offline.mjs": null,
  "verify-duress.mjs": null,
  "verify-live-join.mjs": null,
  // ADR 0181: the journeys shard runs the relay join walk.
  "verify-relay-join.mjs": ["journeys"],
  "verify-relay-join-live.mjs": ["journeys"],
  "verify-live-netns.mjs": null,
  "verify-mutations.mjs": null,
  "verify-tailnet-devices.mjs": null,
  "verify-tailnet-sync.mjs": null,
  "verify-transport.mjs": null,
};

const SCRIPTS = "apps/pages/scripts";
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;

/**
 * The gates a top-level script of apps/pages/scripts stands for. A driver is
 * its row of DRIVER_GATES; the evidence tooling is no gate; anything else is
 * part of the build every shard runs (`security-profile`, `build-workers`,
 * `build-profile`), so it stands for them all.
 */
function rootGates(name) {
  if (name.startsWith("verify-")) {
    // `null` is a driver no job runs (it stands for nothing); a driver with no
    // row at all is unknown, and stands for everything.
    return name in DRIVER_GATES ? (DRIVER_GATES[name] ?? []) : ALL_GATES;
  }
  if (name.startsWith("capture-")) return [];
  return ALL_GATES;
}

function readIfThere(root, path) {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function resolveRelative(from, spec) {
  const parts = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** Which drivers reach each script module, by following relative imports. */
export function driverReach(root) {
  const dirs = [SCRIPTS, `${SCRIPTS}/lib`];
  const files = dirs.flatMap((dir) => {
    const at = join(root, dir);
    return existsSync(at)
      ? readdirSync(at)
          .filter((name) => name.endsWith(".mjs"))
          .map((name) => `${dir}/${name}`)
      : [];
  });
  const edges = new Map();
  for (const file of files) {
    const targets = [];
    for (const match of readIfThere(root, file).matchAll(IMPORT)) {
      targets.push(resolveRelative(file, match[1]));
    }
    edges.set(file, targets);
  }
  // file -> the gates of every top-level script that reaches it.
  const reach = new Map();
  const roots = files.filter(
    (file) => file.startsWith(`${SCRIPTS}/`) && !file.includes("/lib/"),
  );
  for (const start of roots) {
    const stands = rootGates(start.slice(SCRIPTS.length + 1));
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const next = queue.pop();
      for (const target of edges.get(next) ?? []) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    for (const file of seen) {
      if (!reach.has(file)) reach.set(file, new Set());
      for (const gate of stands) reach.get(file).add(gate);
    }
  }
  // A module some script imports but that stands for no gate is still known.
  for (const file of files) if (!reach.has(file)) reach.set(file, new Set());
  return reach;
}

/** The gates a changed script of apps/pages/scripts can change. */
function scriptGates(path, reach) {
  const name = path.slice(SCRIPTS.length + 1);
  // A driver this table has no row for runs everything until it gets one.
  if (name.startsWith("verify-") && !(name in DRIVER_GATES)) return everyGate();
  const reached = reach.get(path);
  if (reached === undefined) {
    // Not a module of the scripts' import graph (a JSON file, a new file the
    // graph did not read): unknown.
    return /\.m?js$/.test(path) ? gates() : everyGate();
  }
  return new Set(reached);
}

// --- the rules ------------------------------------------------------------

const PAGES_SRC = "apps/pages/src";
// What a component imports to give the tutorial registry one of its elements.
const GUIDE_TARGET =
  /useGuideTarget|useOptionalGuideTarget|tutorial\/registry\/react/;
const CORE_SRC = "packages/app-core/src";

const startsWithAny = (text, prefixes) =>
  prefixes.some((prefix) => text.startsWith(prefix));

/** Files of apps/pages/src/lib, by the first thing their name says. */
function pagesLib(path) {
  const rest = path.slice(`${PAGES_SRC}/lib/`.length);
  // AGENTS.md: "Changes to boot, routing, shell, controls or focus require
  // verify:keyboard". The journeys walk navigation by key.
  if (startsWithAny(rest, ["keymap", "pane-escape", "focus"])) {
    // keymap-targets.ts is the selectors `typing()` reads; no tutorial teaches
    // those. The rest of the keymap binds the keys the keyboard tutorials teach.
    if (rest.startsWith("keymap-targets")) {
      return gates("keyboard", "journeys", "budgets");
    }
    return gates("keyboard", "journeys", "budgets", "tutorials");
  }
  // AGENTS.md: "A phone is not a narrow desktop": touch input is verify:mobile.
  if (startsWithAny(rest, ["gesture", "use-gestures", "tab-swipe", "strip"])) {
    return gates("mobile", "keyboard", "budgets");
  }
  // AGENTS.md: "Changes to the bootstrap, a module, a worker or the build run
  // build:profile and verify:capability-graph", which the budgets shard runs.
  if (startsWithAny(rest, ["capabilities/"])) return gates("budgets");
  return everyGate();
}

function pagesSection(path) {
  const rest = path.slice(`${PAGES_SRC}/sections/`.length);
  const section = rest.split("/")[0];
  // A file straight under sections/ is a section's root or a helper the
  // sections share: it lays out panes and takes keys.
  if (!rest.includes("/")) return gates("budgets", "journeys", "keyboard");
  // AGENTS.md: "Browser-local IAM must prove an actual application sign-in",
  // for "local identity sessions, application grants, popup transport or
  // consent". Application registration feeds all of them.
  if (section === "identity" || section === "access") {
    return gates("budgets", "journeys", "sign-in");
  }
  // AGENTS.md: unlock methods and second steps are verify:auth; the device as
  // the Identity plane is verify:device-identity.
  if (path.startsWith(`${PAGES_SRC}/sections/settings/security/`)) {
    return gates("budgets", "journeys", "auth", "device-identity");
  }
  return gates("budgets", "journeys");
}

function pagesSource(path) {
  const rest = path.slice(`${PAGES_SRC}/`.length);
  // AGENTS.md: "A phone ... any block under (pointer: coarse) require[s]
  // verify:mobile". A stylesheet is not told apart from one; it is a stylesheet.
  if (path.endsWith(".css")) return gates("budgets", "mobile");
  // The bootstrap, the worker and the entry points are the boot path
  // (verify:static) and everything stands on them.
  if (
    /^(main|app-root|App|sw|sw-push|vite-env)\.[a-z.]+$/.test(rest) ||
    underAny(rest, ["bootstrap", "host", "sw"])
  ) {
    return everyGate();
  }
  if (rest.startsWith("lib/")) return pagesLib(path);
  if (rest.startsWith("sections/")) return pagesSection(path);
  // The shell and its shared controls: keys, touch, the walk of every tutorial.
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
  // AGENTS.md: "Changes to a tutorial, the Support sheet, the tutorial card or
  // the target registry require verify:tutorials".
  if (under(rest, "tutorial")) return gates("budgets", "tutorials");
  if (under(rest, "webmcp")) return gates("budgets");
  return everyGate();
}

function coreSource(path) {
  const rest = path.slice(`${CORE_SRC}/`.length);
  if (under(rest, "tutorial")) return gates("budgets", "tutorials");
  if (under(rest, "webmcp")) return gates("budgets");
  // The settings view-models decide which rows a tour can point at.
  if (under(rest, "sections")) return gates("budgets", "journeys", "tutorials");
  if (under(rest, "lib/keymap")) {
    return gates("keyboard", "journeys", "budgets", "tutorials");
  }
  // Settings as files and the configuration the journeys save and reload.
  if (under(rest, "lib/configuration")) return gates("budgets", "journeys");
  return everyGate();
}

function pagesOther(path, reach) {
  if (path.startsWith(`${SCRIPTS}/`)) return scriptGates(path, reach);
  // The relay's own tests run `node --test`, in the TypeScript job.
  if (under(path, "apps/pages/server")) return gates();
  if (under(path, "apps/pages/capability-profiles")) return gates("budgets");
  return everyGate();
}

/**
 * The gates one changed path can reach, given it is in the Pages build's area.
 * @param {string} path
 * @param {Map<string, Set<string>>} reach `driverReach(root)`
 * @param {(path: string) => string} read the file's text, "" when it is gone
 */
export function gatesForPath(path, reach, read = () => "") {
  const out = gatesByPath(path, reach);
  // A file that mounts a guide target is a control a tutorial points at: a
  // change to it can leave a tour with nothing to light.
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
  // The workflow is every job's definition: an edit to one job is proved only
  // by running it, so it starts them all.
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

/**
 * The gates a diff has to run.
 * @param {string[]} paths changed paths that are added, modified or renamed
 *   to (a deletion selects nothing), already known to be in the bundle area
 * @param {Map<string, Set<string>>} reach `driverReach(root)`
 */
export function gatesForPaths(paths, reach, read = () => "") {
  const out = gates();
  for (const path of paths) {
    for (const gate of gatesForPath(path, reach, read)) out.add(gate);
  }
  return out;
}

/**
 * The bundle job's matrix legs for a set of gates, in the order of
 * `ci-bundle-shards.json`.
 * @param {Iterable<string>} wanted
 * @param {{ shard: string, sizes?: string }[]} shards
 */
export function bundleMatrix(wanted, shards) {
  const set = new Set(wanted);
  return shards.filter((leg) => set.has(gateOfShard(leg.shard)));
}

/** The shard list the workflow's matrix and these rules share. */
export function loadShards(root) {
  return JSON.parse(
    readFileSync(join(root, "scripts/lib/ci-bundle-shards.json"), "utf8"),
  );
}
