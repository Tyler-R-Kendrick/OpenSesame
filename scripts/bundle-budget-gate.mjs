#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Shipped-bundle budget -- the `pnpm quality:bundle` gate.
 *
 * The other two quality gates ratchet: their recorded numbers may only shrink.
 * Bundles are different. A bundle legitimately grows when a feature lands, so
 * the budgets here are explicit reviewable numbers in bundle-budgets.json
 * rather than an auto-recorded baseline -- raising one should cost a line in a
 * diff that a reviewer sees and has to agree with.
 *
 * `apps/pages` is the case that matters most: it is an installable offline PWA
 * (ADR 0090), so its service worker precaches everything measured here. Every
 * byte is downloaded by every device that installs it, on whatever connection
 * it has.
 *
 * Measures, per app:
 *   total        every byte the built dist ships
 *   javascript   raw and gzipped -- gzip is what the wire actually carries
 *   css          raw
 *   largestAsset the single biggest file, which on a Wasm-backed app is
 *                usually the whole story
 *
 * Usage:
 *   node scripts/bundle-budget-gate.mjs           # check (dists must exist)
 *   node scripts/bundle-budget-gate.mjs --report  # sizes only, no gating
 */
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgets = JSON.parse(
  readFileSync(join(root, "bundle-budgets.json"), "utf8"),
);
const args = new Set(process.argv.slice(2));
const reportOnly = args.has("--report");

const KIB = 1024;

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function measure(distDirectory) {
  const files = walk(distDirectory);
  const measurement = {
    total: 0,
    javascript: 0,
    javascriptGzip: 0,
    css: 0,
    largestAsset: 0,
    largestAssetName: "",
    fileCount: files.length,
  };
  for (const file of files) {
    const size = statSync(file).size;
    measurement.total += size;
    if (size > measurement.largestAsset) {
      measurement.largestAsset = size;
      measurement.largestAssetName = relative(distDirectory, file);
    }
    const extension = extname(file);
    if (extension === ".js" || extension === ".mjs") {
      measurement.javascript += size;
      measurement.javascriptGzip += gzipSync(readFileSync(file), {
        level: 9,
      }).byteLength;
    } else if (extension === ".css") {
      measurement.css += size;
    }
  }
  return measurement;
}

const kib = (bytes) => Math.round(bytes / KIB);
const failures = [];
const missing = [];
const results = [];

for (const [app, config] of Object.entries(budgets.apps)) {
  const distDirectory = join(root, config.dist);
  let exists = false;
  try {
    exists = statSync(distDirectory).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    missing.push({ app, dist: config.dist });
    continue;
  }
  const measurement = measure(distDirectory);
  results.push({ app, config, measurement });

  for (const [metric, budgetKib] of Object.entries(config.budgets)) {
    const actualKib = kib(measurement[metric]);
    if (actualKib > budgetKib) {
      failures.push({
        app,
        metric,
        budgetKib,
        actualKib,
        note:
          metric === "largestAsset" ? ` (${measurement.largestAssetName})` : "",
      });
    }
  }
}

console.log("\nShipped bundle sizes (KiB)\n");
for (const { app, config, measurement } of results) {
  console.log(`  ${app}  -- ${measurement.fileCount} files`);
  for (const metric of [
    "total",
    "javascript",
    "javascriptGzip",
    "css",
    "largestAsset",
  ]) {
    const budgetKib = config.budgets[metric];
    const actualKib = kib(measurement[metric]);
    const budgetLabel =
      budgetKib === undefined
        ? ""
        : `  / ${String(budgetKib).padStart(6)} budget${actualKib > budgetKib ? "  OVER" : ""}`;
    const note =
      metric === "largestAsset" ? `  ${measurement.largestAssetName}` : "";
    console.log(
      `    ${metric.padEnd(15)}${String(actualKib).padStart(7)}${budgetLabel}${note}`,
    );
  }
  console.log("");
}

if (missing.length > 0) {
  console.error("Not measured -- no build output at:");
  for (const { app, dist } of missing) console.error(`  ${app}: ${dist}`);
  console.error(
    "Run `pnpm quality:bundle` (which builds first), or `pnpm build`.\n",
  );
}

if (reportOnly) process.exit(0);

if (missing.length > 0) {
  console.error(
    "bundle budget gate: FAIL -- unbuilt apps cannot be measured\n",
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error("bundle budget gate: FAIL\n");
  for (const { app, metric, budgetKib, actualKib, note } of failures) {
    console.error(
      `  ${app} ${metric}: ${actualKib} KiB exceeds the ${budgetKib} KiB budget${note}`,
    );
  }
  console.error(
    "\nEither bring the bundle back under budget, or raise the number in" +
      "\nbundle-budgets.json deliberately, in the same commit, with a reason.\n",
  );
  process.exit(1);
}

console.log(
  `bundle budget gate: CLEAN -- ${results.length} app(s) within budget`,
);
