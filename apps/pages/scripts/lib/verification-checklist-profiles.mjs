/**
 * Which checklist profiles to build, and how each dist is produced.
 *
 * Stock builds use `security-profile.mjs`, then Vite with
 * `VITE_BASE=/OpenSesame/`. The Tailnet shard uses `stamped-build.mjs` for
 * the dedicated origin and restores the tracked profile afterwards. A name
 * that has a file in `capability-profiles/` is that fixture (`minimal-local`, `full`).
 * `default` and `custom` have none, so both are the stock build.
 * `custom` stays on the stock build: its setup choice is the capabilities
 * ceremony, and there is no `custom.json`. The capability-graph gate is
 * not repeated here — this walk is UI evidence.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEDICATED_ORIGIN } from "./live-dedicated.mjs";

const require = createRequire(import.meta.url);

export const WALK_NAMES = Object.freeze([
  "minimal-local",
  "default",
  "custom",
  "full",
]);

const SETUP_CHOICE = Object.freeze({
  "minimal-local": "Minimal",
  default: "Default",
  custom: "Custom",
  full: "Full",
});

export function resolveWalks(profilesDir, names = WALK_NAMES) {
  const walks = [];
  for (const name of names) {
    const fixture = path.join(profilesDir, `${name}.json`);
    const hasFixture = existsSync(fixture);
    const setupChoice = SETUP_CHOICE[name] ?? "Minimal";
    if (!hasFixture) {
      const note =
        name === "default"
          ? "no capability-profiles/default.json; stock build, setup choice Default"
          : `no capability-profiles/${name}.json; setup choice ${setupChoice} on the stock build`;
      walks.push({
        name,
        setupChoice,
        capabilityProfile: null,
        buildKey: "stock",
        note,
      });
      continue;
    }
    walks.push({
      name,
      setupChoice,
      capabilityProfile: fixture,
      buildKey: name,
      note: "",
    });
  }
  return walks;
}

function run(appRoot, file, args, env) {
  execFileSync(process.execPath, [file, ...args], {
    cwd: appRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: "--max-old-space-size=8192",
      ...env,
    },
  });
}

/** Build one dist. Reuses it when `VERIFY_SKIP_BUILD=1` and index.html is there. */
export function buildDist({
  appRoot,
  scriptsDir,
  outDir,
  capabilityProfile,
  dedicated = false,
}) {
  if (
    process.env.VERIFY_SKIP_BUILD === "1" &&
    existsSync(path.join(outDir, "index.html"))
  ) {
    if (dedicated) {
      const stamped = JSON.parse(
        readFileSync(path.join(outDir, "security-profile.json"), "utf8"),
      );
      if (
        stamped.profile !== "dedicated_origin" ||
        stamped.canonicalOrigin !== DEDICATED_ORIGIN
      ) {
        throw new Error(
          `${outDir} is not the dedicated-origin build; rerun without VERIFY_SKIP_BUILD`,
        );
      }
    }
    console.error(`[checklist] reuse ${outDir}`);
    return;
  }
  const env = { VITE_BASE: "/OpenSesame/" };
  if (capabilityProfile) {
    env.OPENSESAME_CAPABILITY_PROFILE = capabilityProfile;
    env.OPENSESAME_BUILD_MODE = "selective";
  }
  console.error(
    `[checklist] build ${capabilityProfile ?? "stock"} → ${outDir}`,
  );
  const viteBin = path.join(
    path.dirname(require.resolve("vite/package.json")),
    "bin/vite.js",
  );
  mkdirSync(path.dirname(outDir), { recursive: true });
  if (dedicated) {
    run(
      appRoot,
      path.join(scriptsDir, "stamped-build.mjs"),
      [`"${viteBin}" build --outDir "${outDir}" --emptyOutDir`],
      {
        ...env,
        PAGES_DEPLOYMENT_PROFILE: "dedicated_origin",
        PAGES_CANONICAL_ORIGIN: DEDICATED_ORIGIN,
        PAGES_HEADER_SECURITY: "1",
      },
    );
    return;
  }
  run(appRoot, path.join(scriptsDir, "security-profile.mjs"), [], env);
  run(appRoot, viteBin, ["build", "--outDir", outDir, "--emptyOutDir"], env);
}

export function appPaths() {
  const scriptsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const appRoot = path.resolve(scriptsDir, "..");
  return {
    scriptsDir,
    appRoot,
    profilesDir: path.join(appRoot, "capability-profiles"),
  };
}
