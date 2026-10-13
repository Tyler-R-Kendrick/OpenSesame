// Same signed source, actual default release, genuine packed product imports and unchanged gates.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  originalPnpm,
  packageProduct,
  run,
} from "./native-packaged-node-command-data.mjs";
import {
  installExactRelease,
  linkDependencies,
  preparePackedTests,
} from "./native-packaged-node-product-data.mjs";
const root = process.cwd();
const audit = resolve(process.env.NATIVE_AUDIT_DIR ?? "");
const core = join(root, "packages/app-core");
const cli = join(root, "packages/cli");
const cohortPath = fileURLToPath(
  new URL("./native-node-original-cohorts.json", import.meta.url),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const created = [];
function source() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (
    !/^[a-f0-9]{40}$/.test(process.env.EXPECTED_HEAD ?? "") ||
    head !== process.env.EXPECTED_HEAD
  )
    throw new Error("Original native bridge source changed.");
  execFileSync("git", ["diff", "--exit-code"], { stdio: "pipe" });
  execFileSync("git", ["diff", "--cached", "--exit-code"], { stdio: "pipe" });
  return head;
}
async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function verifyReport(group, report) {
  const rows = report.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({ file: file.name, ...test })),
  );
  if (rows.length !== group.expected)
    throw new Error(`Original case census changed: ${group.id}`);
  let conditional = 0;
  for (const test of rows) {
    if (test.status === "passed") continue;
    const allowed = group.allowedExistingConditional;
    if (
      allowed &&
      test.status === "pending" &&
      test.file.replaceAll("\\", "/").endsWith(allowed.file) &&
      test.title === allowed.title &&
      conditional++ === 0
    )
      continue;
    throw new Error(`Original case did not execute successfully: ${group.id}`);
  }
  return {
    cases: rows.length,
    passed: rows.length - conditional,
    existingConditional: conditional,
  };
}
async function executeCohorts(groups, packedCore, config) {
  const results = [];
  for (const group of groups) {
    const report = join(audit, `${group.id}.json`);
    await originalPnpm(
      [
        "exec",
        "vitest",
        "run",
        ...group.files,
        "--maxWorkers=1",
        "--config",
        config,
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      group.id,
      packedCore.root,
    );
    results.push({
      id: group.id,
      ...(await verifyReport(
        group,
        JSON.parse(await readFile(report, "utf8")),
      )),
    });
  }
  return results;
}
async function prepareOriginalPackedProducts(provenance) {
  const manifest = await installExactRelease(provenance, source, created);
  const packedCore = await packageProduct("app-core", core);
  const packedCli = await packageProduct("cli", cli);
  await linkDependencies(
    join(core, "node_modules"),
    join(packedCore.root, "node_modules"),
  );
  await linkDependencies(
    join(cli, "node_modules"),
    join(packedCli.root, "node_modules"),
    { "@opensesame/app-core": packedCore.root },
  );
  const imports = join(audit, "packed-imports");
  await mkdir(imports, { mode: 0o700 });
  await mkdir(join(imports, "node_modules/@opensesame"), { recursive: true });
  for (const [name, product] of [
    ["app-core", packedCore],
    ["cli", packedCli],
  ])
    await symlink(
      product.root,
      join(imports, "node_modules/@opensesame", name),
      process.platform === "win32" ? "junction" : "dir",
    );
  await symlink(
    await realpath(join(packedCore.root, "node_modules/@opensesame/os-domain")),
    join(imports, "node_modules/@opensesame/os-domain"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const probe = join(imports, "probe.mts");
  await copyFile(
    fileURLToPath(
      new URL("./native-packaged-original-import-probe.mts", import.meta.url),
    ),
    probe,
  );
  const tsx = await realpath(join(cli, "node_modules/tsx/dist/loader.mjs"));
  await run(
    "actual-packed-product-import",
    process.execPath,
    ["--import", tsx, probe],
    imports,
  );
  return { manifest, packedCore, packedCli };
}
async function main() {
  source();
  const groups = JSON.parse(await readFile(cohortPath, "utf8")).groups;
  const registered = await exists(
    join(core, "src/node/native-companion-installation.ts"),
  );
  if (!registered) {
    await writeFile(
      join(audit, "node-bridge-readiness.json"),
      `${JSON.stringify({ source: source(), status: "unregistered-unready", testsExecuted: 0, productReady: false })}\n`,
      { flag: "wx" },
    );
    return;
  }
  for (const group of groups)
    for (const file of group.files) {
      if (!(await exists(join(core, file))))
        throw new Error(
          "Registered bridge is missing an original required control.",
        );
    }
  const provenance = JSON.parse(
    await readFile(join(audit, "release-provenance.json"), "utf8"),
  );
  const { manifest, packedCore, packedCli } =
    await prepareOriginalPackedProducts(provenance);
  await originalPnpm(["run", "typecheck"], "original-app-core-typecheck", core);
  await originalPnpm(["run", "typecheck"], "original-cli-typecheck", cli);
  const testConfig = await preparePackedTests(packedCore, groups);
  const results = await executeCohorts(groups, packedCore, testConfig.config);
  if (sha(await readFile(provenance.installed.path)) !== manifest.sha256)
    throw new Error("Original release changed after accepted bridge work.");
  source();
  await writeFile(
    join(audit, "node-bridge-proof.json"),
    `${JSON.stringify({ source: source(), profile: "default-release", platform: process.platform, manifest, packedCore, packedCli, testRoot: packedCore.root, testConfig, results, budgetsUnchanged: [4096, 16384], defaultTestTimeout: 20000 }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}
let originalFailure;
let originalRejected = false;
try {
  await main();
} catch (error) {
  originalFailure = error;
  originalRejected = true;
}
const closed = await Promise.allSettled(
  created.map((path) => rm(path, { recursive: true, force: false })),
);
const failures = closed.flatMap((value) =>
  value.status === "rejected" ? [value.reason] : [],
);
if (failures.length)
  throw new AggregateError(
    originalRejected ? [originalFailure, ...failures] : failures,
    "Original bridge work and fixed package cleanup failed.",
  );
if (originalRejected) throw originalFailure;
