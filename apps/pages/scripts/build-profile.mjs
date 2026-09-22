#!/usr/bin/env node
/**
 * Build Pages under one capability profile and verify the result.
 *
 *   node scripts/build-profile.mjs --profile capability-profiles/family-local.json \
 *        --mode hardened [--out dist-profiles/family-local-hardened] \
 *        [--base /OpenSesame/] [--gate enforce|report] [--expect-absent <module-id>]...
 *   node scripts/build-profile.mjs --all [--gate ...]
 *
 * Each build runs `security-profile.mjs`, then `vite build` in a child
 * process (so `OPENSESAME_*` is read fresh by vite.config.ts and no plugin
 * state leaks between profiles), then `verify-capability-graph.mjs` against
 * the emitted directory, and writes `<out>/measurements.json`. `--all` is the
 * BUILD-07 matrix: minimal-local and family-local in both modes,
 * single-provider-selected, enterprise-selected and rich-explicit selective,
 * enterprise-selected hardened; the aggregate lands in
 * `dist-profiles/measurements.json`. `tsc --noEmit` is not repeated here —
 * the package `build` script owns typechecking.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "./lib/capability-graph.mjs";
import { verifyDist } from "./verify-capability-graph.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, "..");
const PROFILES_DIR = join(APP_ROOT, "capability-profiles");
const require = createRequire(import.meta.url);

export const BUILD_MATRIX = Object.freeze([
  ["minimal-local", "selective"],
  ["minimal-local", "hardened"],
  ["family-local", "selective"],
  ["family-local", "hardened"],
  ["single-provider-selected", "selective"],
  ["enterprise-selected", "selective"],
  ["enterprise-selected", "hardened"],
  ["rich-explicit", "selective"],
]);

function parseArgs(argv) {
  const args = {
    profile: null,
    mode: "selective",
    out: null,
    base: "/OpenSesame/",
    gate: null,
    all: false,
    expectAbsent: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--profile") args.profile = next();
    else if (flag === "--mode") args.mode = next();
    else if (flag === "--out") args.out = next();
    else if (flag === "--base") args.base = next();
    else if (flag === "--gate") args.gate = next();
    else if (flag === "--all") args.all = true;
    else if (flag === "--expect-absent") args.expectAbsent.push(next());
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.all && !args.profile)
    throw new Error("--profile <path> or --all is required");
  return args;
}

function profilePath(nameOrPath) {
  const direct = resolve(APP_ROOT, nameOrPath);
  if (existsSync(direct)) return direct;
  const byName = join(PROFILES_DIR, `${nameOrPath}.json`);
  if (existsSync(byName)) return byName;
  const available = existsSync(PROFILES_DIR)
    ? readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".json"))
    : [];
  throw new Error(
    `profile not found: ${nameOrPath}\navailable under capability-profiles/: ${available.join(", ") || "(none)"}`,
  );
}

function run(file, args, env) {
  execFileSync(process.execPath, [file, ...args], {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192", ...env },
  });
}

/** Build one profile/mode into `out`; returns the verifier's report. */
export async function buildProfile({
  profile,
  mode,
  out,
  base,
  gate,
  expectAbsent = [],
}) {
  const path = profilePath(profile);
  const name =
    JSON.parse(readFileSync(path, "utf8")).name ?? basename(path, ".json");
  const outDir = resolve(APP_ROOT, out ?? `dist-profiles/${name}-${mode}`);
  const env = {
    VITE_BASE: base,
    OPENSESAME_CAPABILITY_PROFILE: path,
    OPENSESAME_BUILD_MODE: mode,
    ...(gate ? { OPENSESAME_GRAPH_GATE: gate } : {}),
  };
  console.error(
    `\n[build-profile] ${name} (${mode}) → ${relative(APP_ROOT, outDir)}`,
  );
  run(join(here, "security-profile.mjs"), [], env);
  mkdirSync(dirname(outDir), { recursive: true });
  // `vite/bin/vite.js` is not an exported subpath; go through package.json.
  const viteBin = join(
    dirname(require.resolve("vite/package.json")),
    "bin/vite.js",
  );
  run(viteBin, ["build", "--outDir", outDir, "--emptyOutDir"], env);
  const { report, table } = await verifyDist({
    dist: outDir,
    profile: path,
    mode,
    base,
    expectAbsent,
  });
  console.error(table);
  writeFileSync(
    join(outDir, "measurements.json"),
    canonicalJson({ ...report, name: `${name}-${mode}` }),
  );
  return { ...report, name: `${name}-${mode}` };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = parseArgs(process.argv.slice(2));
  const jobs = args.all
    ? BUILD_MATRIX.map(([profile, mode]) => ({ profile, mode }))
    : [{ profile: args.profile, mode: args.mode, out: args.out }];
  const results = [];
  let failed = false;
  for (const job of jobs) {
    try {
      results.push(
        await buildProfile({
          ...job,
          base: args.base,
          gate: args.gate,
          expectAbsent: args.expectAbsent,
        }),
      );
    } catch (error) {
      failed = true;
      results.push({
        name: `${job.profile}-${job.mode}`,
        ok: false,
        error: String(error.message ?? error).split("\n")[0],
      });
      console.error(
        `[build-profile] ${job.profile} (${job.mode}) FAILED: ${error.message}`,
      );
    }
  }
  if (args.all) {
    mkdirSync(join(APP_ROOT, "dist-profiles"), { recursive: true });
    writeFileSync(
      join(APP_ROOT, "dist-profiles/measurements.json"),
      canonicalJson(
        results.map((r) => ({
          name: r.name,
          ok: r.ok,
          sizes: r.sizes ?? null,
          error: r.error ?? null,
        })),
      ),
    );
  }
  console.log(
    canonicalJson(
      results.map((r) => ({
        name: r.name,
        ok: r.ok,
        sizes: r.sizes ?? null,
        error: r.error ?? null,
      })),
    ),
  );
  process.exit(failed || results.some((r) => !r.ok) ? 1 : 0);
}
