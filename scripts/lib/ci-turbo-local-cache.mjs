import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRootFromHere } from "./ci-affected-graph.mjs";

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ lockDigest?: string }} [options]
 */
export function turboLocalCacheKey(env, options = {}) {
  const os = text(env.RUNNER_OS) || "Linux";
  const digest =
    options.lockDigest ??
    createHash("sha256")
      .update(readFileSync(resolve(repoRootFromHere(), "package-lock.json")))
      .digest("hex")
      .slice(0, 16);
  return {
    key: `turbo-local-${os}-${digest}`,
    restorePrefix: `turbo-local-${os}-`,
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function main() {
  const { key, restorePrefix } = turboLocalCacheKey(process.env);
  const lines = [`turbo_local_cache_key=${key}`, `turbo_local_restore_prefix=${restorePrefix}`];
  const body = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, body);
  process.stdout.write(body);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
