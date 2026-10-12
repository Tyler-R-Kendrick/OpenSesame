/**
 * Which checklist profiles to build, and how each dist is produced.
 *
 * Same two steps as `build-profile.mjs`: `security-profile.mjs`, then
 * `vite build` with `VITE_BASE=/OpenSesame/`. A name that has a file in
 * `capability-profiles/` is that fixture (`minimal-local`, `full`).
 * `default` and `custom` have none, so both are the stock build.
 * `custom` stays on the stock build: its setup choice is the capabilities
 * ceremony, and there is no `custom.json`. The capability-graph gate is
 * not repeated here — this walk is UI evidence.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
export function buildDist({ appRoot, scriptsDir, outDir, capabilityProfile }) {
  if (
    process.env.VERIFY_SKIP_BUILD === "1" &&
    existsSync(path.join(outDir, "index.html"))
  ) {
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
  run(appRoot, path.join(scriptsDir, "security-profile.mjs"), [], env);
  const viteBin = path.join(
    path.dirname(require.resolve("vite/package.json")),
    "bin/vite.js",
  );
  mkdirSync(path.dirname(outDir), { recursive: true });
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
