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

/** Reject paths that escape the checkout, including nested symlinks. */
function inside(root, path) {
  const name = relative(realpathSync(root), realpathSync(path));
  if (name.startsWith("..") || isAbsolute(name))
    throw new Error(`Skill path escapes repository: ${path}`);
}
function files(root, directory) {
  const result = new Map();
  function visit(path, name) {
    inside(root, path);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort())
        visit(join(path, entry), name ? `${name}/${entry}` : entry);
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      const actual = lstatSync(realpathSync(path));
      if (!actual.isFile()) throw new Error(`Unexpected skill link: ${path}`);
      result.set(name, {
        bytes: readFileSync(path),
        executable: actual.mode & 0o111,
      });
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

function syncMirror(root, agent, name, check) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
    throw new Error(`Unexpected skill name: ${name}`);
  const source = join(root, ".agents/skills", name);
  const mirror = join(root, agent, "skills", name);
  if (!existsSync(source))
    throw new Error(
      `Choose a canonical .agents/skills/${name} before syncing ${agent}`,
    );
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

/** Deduplicate existing registered mirrors; never discard agent-specific variants. */
export function syncAgentSkills(directory, { check = false } = {}) {
  const root = resolve(directory);
  const changes = [];
  for (const agent of [".claude", ".grok"]) {
    const mirrors = join(root, agent, "skills");
    if (!existsSync(mirrors)) continue;
    for (const name of readdirSync(mirrors).sort())
      changes.push(...syncMirror(root, agent, name, check));
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
