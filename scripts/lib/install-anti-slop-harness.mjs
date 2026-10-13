import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Shared by install-anti-slop.test.mjs and install-anti-slop-verify.test.mjs:
// the paths of the skill, a scratch directory per test file, and the installer
// and verifier run as child processes, the way a consuming repository runs them.

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const skill = join(root, "skills", "install-anti-slop");
export const asset = join(skill, "assets", "anti-slop");
export const installer = join(skill, "scripts", "install.mjs");
export const generator = join(skill, "scripts", "manifest.mjs");

const scratch = mkdtempSync(join(tmpdir(), "install-anti-slop-"));
export const cleanup = () => rmSync(scratch, { recursive: true, force: true });

let counter = 0;
export function fresh(label) {
  counter += 1;
  const dir = join(scratch, `${label}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Every file under `dir`, as sorted posix paths. */
export function tree(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? tree(dir, `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

export function install(args = []) {
  const cwd = fresh("repo");
  const result = run(installer, ["plugin", ...args], cwd);
  return { ...result, cwd, target: join(cwd, "plugin") };
}

export const verify = (target, args = []) =>
  run(join(target, "verify.mjs"), args, target);
