#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPinnedFile } from "../lib/read-pinned-file.mjs";

/** Reject paths that escape the checkout, including nested symlinks. */
function inside(root, path) {
  const name = relative(realpathSync(root), realpathSync(path));
  if (name.startsWith("..") || isAbsolute(name))
    throw new Error(`Skill path escapes repository: ${path}`);
}
function escapesCheckout(root, path) {
  try {
    inside(root, path);
    return false;
  } catch {
    return true;
  }
}
function files(root, directory) {
  const result = new Map();
  function visit(path, name) {
    const stat = lstatSync(path);
    // A dangling symlink (upstream removed the target in a latest
    // refresh) is stale install output, not a checker crash: record it
    // as null so sync can prune it.
    if (stat.isSymbolicLink() && !existsSync(path)) {
      result.set(name, null);
      return;
    }
    inside(root, path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort())
        visit(join(path, entry), name ? `${name}/${entry}` : entry);
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      const target = realpathSync(path);
      const actual = lstatSync(target);
      if (!actual.isFile()) throw new Error(`Unexpected skill link: ${path}`);
      result.set(name, readPinnedFile(target, actual));
    } else throw new Error(`Unexpected skill entry: ${path}`);
  }
  visit(realpathSync(directory), "");
  return result;
}
function same(left, right) {
  return (
    left &&
    right &&
    left.executable === right.executable &&
    left.bytes.equals(right.bytes)
  );
}

/** Preserve unique instructions, linking only identical payloads and modes. */
function syncSharedFiles({ root, source, mirror, original, installed, check }) {
  const changes = [];
  for (const [file, value] of installed) {
    if (value === null) {
      const stale = join(mirror, file);
      changes.push(relative(root, stale));
      if (!check) rmSync(stale, { force: true });
      continue;
    }
    if (!same(value, original.get(file))) continue;
    const destination = join(mirror, file);
    const expected = relative(dirname(destination), join(source, file));
    if (lstatSync(destination).isSymbolicLink()) {
      if (readlinkSync(destination) !== expected)
        throw new Error(`Unexpected shared skill alias: ${destination}`);
      continue;
    }
    changes.push(relative(root, destination));
    if (!check) {
      rmSync(destination);
      symlinkSync(expected, destination, "file");
    }
  }
  return changes;
}

/** Optional profiles from skills/profiles.json; absent in fixtures = legacy. */
export function loadProfiles(root) {
  const path = join(root, "skills/profiles.json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const core = new Set(parsed.profiles?.core?.skills ?? []);
  const optional = new Set();
  const seen = new Set(core);
  for (const [key, profile] of Object.entries(parsed.profiles ?? {})) {
    if (key === "core") continue;
    for (const name of Array.isArray(profile.skills) ? profile.skills : []) {
      if (seen.has(name))
        throw new Error(`Skill listed in multiple profiles: ${name}`);
      seen.add(name);
      optional.add(name);
    }
  }
  return { core, optional, all: seen };
}
function resolveCanonical(root, name) {
  for (const base of [".agents/skills", ".agents/skills-optional"]) {
    const candidate = join(root, base, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
function checkCore(root, profiles) {
  if (!profiles) return;
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return;
  // Only enforce on a real skills/ tree (has SKILL.md dirs), not fixtures.
  const dirs = readdirSync(skillsDir).filter((entry) => {
    const p = join(skillsDir, entry);
    return lstatSync(p).isDirectory();
  });
  if (!dirs.length && !profiles.core.size) return;
  for (const name of profiles.core) {
    if (!existsSync(join(skillsDir, name, "SKILL.md")))
      throw new Error(`Missing core skill: skills/${name}/SKILL.md`);
    const alias = join(root, ".agents/skills", name);
    if (!existsSync(join(root, ".agents/skills")))
      throw new Error(`Missing core alias root: .agents/skills/${name}`);
    if (!existsSync(alias))
      throw new Error(`Missing core alias: .agents/skills/${name}`);
    if (realpathSync(alias) !== realpathSync(join(skillsDir, name)))
      throw new Error(
        `Core alias does not resolve to skills/${name}: ${alias}`,
      );
  }
  for (const name of dirs) {
    if (!profiles.core.has(name))
      throw new Error(
        `skills/${name} is not listed in skills/profiles.json core`,
      );
  }
}

function syncMirror(root, agent, name, check, profiles) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
    throw new Error(`Unexpected skill name: ${name}`);
  const source = resolveCanonical(root, name);
  const mirror = join(root, agent, "skills", name);
  // A mirror root symlinked outside the checkout (personal skill tree)
  // must never be deleted or rewritten through: refuse and warn. This
  // must run before any removal below. A mirror that is itself a symlink
  // still goes through alias validation further down.
  if (
    existsSync(mirror) &&
    !lstatSync(mirror).isSymbolicLink() &&
    escapesCheckout(root, mirror)
  ) {
    console.error(
      `agent skills: warning: ${agent}/skills/${name} escapes the checkout; refusing to modify it`,
    );
    return [];
  }
  if (!source) {
    // Absence of a canonical does not prove that a mirror is disposable:
    // it may contain personal instructions. Leave it for its owner.
    if (profiles?.optional.has(name)) {
      return [];
    }
    throw new Error(
      `Choose a canonical .agents/skills/${name} before syncing ${agent}`,
    );
  }
  inside(root, source);
  const link = relative(dirname(mirror), source);
  const stat = lstatSync(mirror);
  if (stat.isSymbolicLink()) {
    if (
      readlinkSync(mirror) !== link ||
      realpathSync(mirror) !== realpathSync(source)
    )
      throw new Error(`Unexpected skill alias: ${mirror}; expected ${link}`);
    return [];
  }
  if (!stat.isDirectory()) throw new Error(`Not a skill directory: ${mirror}`);
  const original = files(root, source);
  const installed = files(root, mirror);
  const identical =
    original.size === installed.size &&
    [...installed].every(([file, value]) => same(value, original.get(file)));
  if (!identical) {
    // Individual links keep each launcher's agent-specific reference directory.
    return syncSharedFiles({
      root,
      source,
      mirror,
      original,
      installed,
      check,
    });
  }
  if (!check) {
    rmSync(mirror, { recursive: true });
    symlinkSync(link, mirror, "dir");
  }
  return [relative(root, mirror)];
}

function reportUnlisted(base, name) {
  // Strict in CI (fresh tree: an unlisted canonical is a catalogue
  // bug). Locally, a personal or stale install must not block every
  // commit via the git hooks; warn instead.
  if (process.env.CI === "true")
    throw new Error(`${base}/${name} is not listed in skills/profiles.json`);
  console.error(
    `agent skills: warning: ${base}/${name} is not listed in skills/profiles.json (ignored locally, fails in CI)`,
  );
}
function checkCatalogueDir(root, profiles, base) {
  const dir = join(root, base);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const stat = lstatSync(join(dir, name));
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    if (!profiles.all.has(name)) reportUnlisted(base, name);
  }
}
function checkCatalogue(root, profiles) {
  if (!profiles) return;
  for (const base of [".agents/skills", ".agents/skills-optional"])
    checkCatalogueDir(root, profiles, base);
}

/** Deduplicate existing registered mirrors; never discard agent-specific variants. */
export function syncAgentSkills(directory, { check = false } = {}) {
  const root = resolve(directory);
  const profiles = loadProfiles(root);
  checkCore(root, profiles);
  checkCatalogue(root, profiles);
  const changes = [];
  for (const agent of [".claude", ".grok"]) {
    const mirrors = join(root, agent, "skills");
    if (!existsSync(mirrors)) continue;
    if (escapesCheckout(root, mirrors)) {
      console.error(
        `agent skills: warning: ${agent}/skills escapes the checkout; refusing to modify it`,
      );
      continue;
    }
    for (const name of readdirSync(mirrors).sort())
      changes.push(...syncMirror(root, agent, name, check, profiles));
  }
  return changes;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--check") || args.length > 1)
      throw new Error(
        "usage: node scripts/dev/sync-agent-skills.mjs [--check]",
      );
    const check = args.includes("--check");
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const changes = syncAgentSkills(root, { check });
    if (check && changes.length) {
      throw new Error(
        `Duplicate skill installs (${changes.length}); run node scripts/dev/sync-agent-skills.mjs`,
      );
    }
    console.log(
      `agent skills: ${check ? "checked" : "linked"} ${changes.length} duplicate paths`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
