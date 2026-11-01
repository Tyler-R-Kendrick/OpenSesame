import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;

/**
 * Git ref Turborepo should compare against for `...[ref]` filters.
 * merge_group → merge base sha; pull_request → origin/$GITHUB_BASE_REF;
 * otherwise origin/main.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function turboComparisonRef(env) {
  if (env.GITHUB_EVENT_NAME === "merge_group") {
    const base = env.BASE_SHA ?? env.MERGE_GROUP_BASE_SHA ?? "";
    if (SHA.test(base)) return base;
  }
  const baseRef = text(env.GITHUB_BASE_REF);
  if (env.GITHUB_EVENT_NAME === "pull_request" && baseRef.length > 0) {
    return `origin/${baseRef}`;
  }
  return "origin/main";
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureRef(root, ref, env) {
  if (SHA.test(ref)) return ref;
  if (!/^origin\/[\w./-]+$/u.test(ref)) {
    throw new Error(`unsupported turbo comparison ref ${ref}`);
  }
  const remote = ref.slice("origin/".length);
  try {
    execFileSync("git", ["fetch", "origin", remote, "--depth=1"], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    execFileSync("git", ["rev-parse", ref], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return ref;
  } catch {
    const fallback = text(env.BASE_SHA);
    if (SHA.test(fallback)) return fallback;
    throw new Error(
      `could not resolve turbo comparison ref ${ref}; set BASE_SHA to the stack parent`,
    );
  }
}

export function materializeTurboComparisonRef(env, root) {
  return ensureRef(root, turboComparisonRef(env), env);
}

function main() {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const ref = materializeTurboComparisonRef(process.env, root);
  const line = `turbo_comparison_ref=${ref}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, line);
  }
  process.stdout.write(line);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
