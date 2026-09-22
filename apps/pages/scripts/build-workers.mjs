#!/usr/bin/env node
/**
 * Build the service-worker variants that are not `sw.js` (ownership.md §4.7).
 *
 * `vite build` (with vite-plugin-pwa) has already written `dist/`, including
 * `dist/sw.js`, the core-only worker. This script then:
 *
 *   1. decides which extra variants this distribution ships — the
 *      `OPENSESAME_DISTRIBUTED_WORKERS` comma list when set (S07's plugin
 *      exports it), else `dist/capability-distribution.json`'s
 *      `workerVariants`, else every variant;
 *   2. builds `src/sw-push.ts` → `dist/sw-push.js` through
 *      `vite.sw-push.config.ts`, defining `self.__WB_MANIFEST` with the shell
 *      entry and its md5 — the same revision workbox injected into `sw.js`,
 *      so both variants of one build derive the same release id;
 *   3. checks the truth of the split (P-TRUTH, PWA-01): `dist/sw.js` must
 *      register no `push` or `notificationclick` handler, and every emitted
 *      variant must exist.
 *
 * Usage: node scripts/build-workers.mjs        (from apps/pages)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Variants beyond the core-only `sw.js`, and the config that builds each. */
const EXTRA_VARIANTS = new Map([
  ["push", { config: "vite.sw-push.config.ts", output: "sw-push.js" }],
]);

const PUSH_HANDLER = /addEventListener\(\s*["'](?:push|notificationclick)["']/;

function distributedVariants(env) {
  const fromEnv = env.OPENSESAME_DISTRIBUTED_WORKERS;
  if (fromEnv !== undefined) {
    return new Set(
      fromEnv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }
  const contract = join(dist, "capability-distribution.json");
  if (existsSync(contract)) {
    try {
      const parsed = JSON.parse(readFileSync(contract, "utf8"));
      if (Array.isArray(parsed.workerVariants)) {
        return new Set(
          parsed.workerVariants
            .map((v) => (v && typeof v.id === "string" ? v.id : null))
            .filter((id) => id !== null),
        );
      }
    } catch {
      // Fall through: an unreadable contract builds everything.
    }
  }
  return new Set(EXTRA_VARIANTS.keys());
}

/** The manifest entry vite-plugin-pwa gives the shell: url + md5 revision. */
function shellManifest() {
  const shell = join(dist, "index.html");
  if (!existsSync(shell)) {
    throw new Error(`build-workers: ${shell} is missing; run vite build first`);
  }
  const revision = createHash("md5").update(readFileSync(shell)).digest("hex");
  return [{ url: "index.html", revision }];
}

function assertCoreWorkerHasNoPush() {
  const core = join(dist, "sw.js");
  if (!existsSync(core)) {
    throw new Error(`build-workers: ${core} is missing; run vite build first`);
  }
  const source = readFileSync(core, "utf8");
  if (PUSH_HANDLER.test(source)) {
    throw new Error(
      "build-workers: dist/sw.js registers a push or notificationclick handler; the core-only worker must not (PWA-01)",
    );
  }
}

async function buildVariant(id, manifest) {
  const variant = EXTRA_VARIANTS.get(id);
  if (!variant) {
    console.log(`build-workers: no extra script for variant "${id}" (core-only ships as sw.js)`);
    return;
  }
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    join(root, variant.config),
    root,
  );
  if (!loaded) throw new Error(`build-workers: could not load ${variant.config}`);
  const config = loaded.config;
  await build({
    ...config,
    configFile: false,
    logLevel: "warn",
    define: {
      ...(config.define ?? {}),
      "self.__WB_MANIFEST": JSON.stringify(manifest),
    },
  });
  const out = join(dist, variant.output);
  if (!existsSync(out)) throw new Error(`build-workers: ${out} was not emitted`);
  const source = readFileSync(out, "utf8");
  if (!PUSH_HANDLER.test(source)) {
    throw new Error(`build-workers: ${variant.output} carries no push handler`);
  }
  console.log(`build-workers: wrote dist/${variant.output} (${source.length} bytes)`);
}

async function main() {
  assertCoreWorkerHasNoPush();
  const wanted = distributedVariants(process.env);
  const manifest = shellManifest();
  for (const id of wanted) {
    if (id === "core-only") continue;
    await buildVariant(id, manifest);
  }
  const skipped = [...EXTRA_VARIANTS.keys()].filter((id) => !wanted.has(id));
  for (const id of skipped) {
    console.log(`build-workers: variant "${id}" not distributed; ${EXTRA_VARIANTS.get(id).output} not emitted`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
