/**
 * Round 8 install-profile evidence: the trees and the dists.
 *
 * A before build is a detached worktree under WT_ROOT with the main
 * checkout's node_modules mirrored in, so a months-old commit builds with
 * today's pinned toolchain. Each profile dist is `security-profile.mjs`
 * then `vite build` with `VITE_BASE=/OpenSesame/`, shared per buildKey —
 * `default` and `custom` are the stock build.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dependencyRoot } from "./dependency-root.mjs";
import { REPO, WT_ROOT, log } from "./round8-profile-plan.mjs";
import { buildDist, resolveWalks } from "./verification-checklist-profiles.mjs";

export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function tipSha() {
  return git(REPO, ["rev-parse", "HEAD"]);
}

export function listNodeModules(root) {
  const out = execFileSync(
    "find",
    [root, "-name", "node_modules", "-prune", "-print"],
    { encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

/**
 * Where Node resolves `name` (through `specifier`) from apps/pages in `root`,
 * as a real path, or null. A hoisted install puts both at the root, pnpm's in
 * apps/pages; either way this is what the build in that tree will load.
 */
function pagesResolves(root, name, specifier = name) {
  try {
    return fs.realpathSync(
      dependencyRoot(
        path.join(root, "apps/pages/package.json"),
        name,
        specifier,
      ),
    );
  } catch {
    return null;
  }
}

function inside(root, target) {
  const relative = target ? path.relative(fs.realpathSync(root), target) : "..";
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function mirrorNodeModules(fromRoot, toRoot) {
  if (inside(toRoot, pagesResolves(toRoot, "vite"))) {
    log(`node_modules present in ${toRoot}`);
    return;
  }
  log(`mirror node_modules → ${toRoot}`);
  for (const abs of listNodeModules(fromRoot)) {
    const rel = path.relative(fromRoot, abs);
    if (rel.startsWith("..")) continue;
    const dest = path.join(toRoot, rel);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    // Symlinks stay symlinks so workspace packages resolve inside this tree.
    execFileSync("cp", ["-a", `${abs}/.`, dest]);
  }
  const appCore = pagesResolves(
    toRoot,
    "@opensesame/app-core",
    "@opensesame/app-core/host.js",
  );
  if (appCore !== fs.realpathSync(path.join(toRoot, "packages/app-core"))) {
    throw new Error(
      `workspace packages must resolve inside ${toRoot}: @opensesame/app-core is ${appCore}`,
    );
  }
}

export function ensureTree(sha) {
  if (sha === tipSha()) return REPO;
  const dir = path.join(WT_ROOT, sha.slice(0, 12));
  if (fs.existsSync(path.join(dir, ".git"))) {
    const at = git(dir, ["rev-parse", "HEAD"]);
    if (at !== sha) throw new Error(`${dir} is ${at}, want ${sha}`);
  } else {
    fs.mkdirSync(WT_ROOT, { recursive: true });
    log(`worktree ${sha.slice(0, 12)}`);
    execFileSync("git", ["worktree", "add", "--detach", dir, sha], {
      cwd: REPO,
      stdio: "inherit",
    });
  }
  mirrorNodeModules(REPO, dir);
  return dir;
}

function restoreSecurityProfile(tree) {
  execFileSync(
    "git",
    ["checkout", "--", "apps/pages/public/security-profile.json"],
    { cwd: tree, stdio: "inherit" },
  );
}

export function buildsFor(tree) {
  const appRoot = path.join(tree, "apps/pages");
  const scriptsDir = path.join(appRoot, "scripts");
  const profilesDir = path.join(appRoot, "capability-profiles");
  const walks = resolveWalks(profilesDir);
  const dists = new Map();
  const seen = new Set();
  try {
    for (const walk of walks) {
      if (seen.has(walk.buildKey)) continue;
      seen.add(walk.buildKey);
      const outDir = path.join(
        appRoot,
        "dist-profiles",
        `round8-${walk.buildKey}`,
      );
      log(
        `build ${walk.buildKey} @ ${git(tree, ["rev-parse", "--short", "HEAD"])}`,
      );
      buildDist({
        appRoot,
        scriptsDir,
        outDir,
        capabilityProfile: walk.capabilityProfile,
      });
      if (!fs.existsSync(path.join(outDir, "index.html"))) {
        throw new Error(`build produced no index.html at ${outDir}`);
      }
      dists.set(walk.buildKey, outDir);
    }
  } finally {
    restoreSecurityProfile(tree);
  }
  return { walks, dists };
}
