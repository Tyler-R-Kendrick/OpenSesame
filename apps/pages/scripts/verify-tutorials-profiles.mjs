#!/usr/bin/env node
/**
 * Tutorial walks on the minimal and full capability profiles, with support
 * models unapproved (ADR 0163, ADR 0166).
 *
 * Builds Pages twice, the same two steps as `build-profile.mjs`, then runs
 * `verify-tutorials.mjs` against each dist. Minimal walks only what that
 * profile installed. Full turns every other capability on and then turns the
 * on-device and remote support models off.
 *
 * The default leg is shard 1/3 at desktop and phone width, including the
 * gate pass. The full library is the same command with
 * `TUTORIALS_PROFILES_FULL=1` (CI, when a runner can spend the time).
 *
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
 *     pnpm --filter @opensesame/pages verify:tutorials-profiles
 *
 *   TUTORIALS_PROFILES_FULL=1 \
 *     PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
 *     pnpm --filter @opensesame/pages verify:tutorials-profiles
 *
 * `VERIFY_SKIP_BUILD=1` reuses `dist-profiles/tutorials-<name>/` when
 * `index.html` is already there.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { appPaths, buildDist } from "./lib/verification-checklist-profiles.mjs";

const PROFILES = [
  { name: "minimal-local", enable: "installed" },
  { name: "full", enable: "except-ai" },
];

const { appRoot, scriptsDir, profilesDir } = appPaths();
const full = process.env.TUTORIALS_PROFILES_FULL === "1";
const shard = full
  ? (process.env.TUTORIALS_SHARD ?? "")
  : (process.env.TUTORIALS_SHARD ?? "1/3");

function runWalker(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(scriptsDir, "verify-tutorials.mjs")],
      { cwd: appRoot, env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`verify-tutorials stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

for (const profile of PROFILES) {
  const fixture = path.join(profilesDir, `${profile.name}.json`);
  const outDir = path.join(
    appRoot,
    "dist-profiles",
    `tutorials-${profile.name}`,
  );
  console.log(
    `\n[tutorials-profiles] ${profile.name} enable=${profile.enable} shard=${shard || "all"}`,
  );
  buildDist({
    appRoot,
    scriptsDir,
    outDir,
    capabilityProfile: fixture,
  });
  const env = { ...process.env };
  env.TUTORIALS_DEV_URL = undefined;
  env.TUTORIALS_DIST = outDir;
  env.TUTORIALS_ENABLE = profile.enable;
  env.TUTORIALS_AI = "off";
  env.VITE_BASE = "/OpenSesame/";
  env.TUTORIALS_OUT = `/tmp/opensesame-tutorials-${profile.name}`;
  if (shard) env.TUTORIALS_SHARD = shard;
  else env.TUTORIALS_SHARD = undefined;
  const code = await runWalker(env);
  if (code !== 0) process.exit(code);
}

console.log(
  "\n[tutorials-profiles] minimal-local and full passed with support models off.",
);
if (!full) {
  console.log(
    "[tutorials-profiles] shard 1/3. Full library: TUTORIALS_PROFILES_FULL=1 pnpm --filter @opensesame/pages verify:tutorials-profiles",
  );
}
