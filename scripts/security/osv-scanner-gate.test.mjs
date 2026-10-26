import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-osv-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  for (const folder of ["scripts/audit", "scripts/lib", "scripts/security"])
    mkdirSync(join(repo, folder), { recursive: true });
  for (const file of [
    "scripts/audit/osv-scanner-gate.sh",
    "scripts/audit/native-toolchain-sbom.py",
    "scripts/lib/audit-directory.sh",
    "scripts/security/assert-no-advisories.mjs",
  ])
    copyFileSync(join(root, file), join(repo, file));
  writeFileSync(join(repo, "osv-scanner.toml"), "IgnoredVulns = []\n");
  mkdirSync(join(repo, "tools/pwa-tailscale-native-http"), { recursive: true });
  writeFileSync(
    join(repo, "tools/pwa-tailscale-native-http/source.json"),
    JSON.stringify({ compiler: { version: "go1.27.3" } }),
  );
  writeFileSync(
    join(repo, "tools/pwa-tailscale-native-http/native-audit.mjs"),
    'process.exit(Number(process.env.OSV_TEST_NATIVE_AUDIT_STATUS ?? "0"));\n',
  );
  const inputs = [
    "Cargo.lock",
    "pnpm-lock.yaml",
    ".deepsec/pnpm-lock.yaml",
    "tests/fuzz/cargo/Cargo.lock",
    "scripts/test/live-turn/go.mod",
    "nested space/pnpm-lock.yaml",
  ];
  for (const file of inputs) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), "fixture\n");
  }
  writeFileSync(
    join(repo, "scripts/test/live-turn/audit-crypto.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  for (const file of ["node_modules/tool/pnpm-lock.yaml", "work/Cargo.lock"]) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), "untracked\n");
  }
  const scanner = join(directory, "scanner.mjs");
  const log = join(directory, "arguments.json");
  writeFileSync(
    scanner,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("osv-scanner 2.5.0");
} else {
  writeFileSync(process.env.OSV_TEST_LOG, JSON.stringify(args));
  const output = args[args.indexOf("--output-file") + 1];
  if (process.env.OSV_TEST_REPORT !== "missing")
    writeFileSync(output, process.env.OSV_TEST_REPORT ?? '{"results":[]}');
  process.exitCode = Number(process.env.OSV_TEST_STATUS ?? 0);
}
`,
    { mode: 0o700 },
  );
  return {
    inputs,
    repo,
    arguments: () => JSON.parse(readFileSync(log, "utf8")),
    run: (env = {}) => {
      const result = spawnSync("bash", ["scripts/audit/osv-scanner-gate.sh"], {
        cwd: repo,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          OPENSESAME_OSV_SCANNER_BIN: scanner,
          OPENSESAME_OSV_SCANNER_VERSION: "2.5.0",
          OPENSESAME_AUDIT_DIR: directory,
          OSV_TEST_LOG: log,
          ...env,
        },
      });
      assert.ifError(result.error);
      return result;
    },
  };
}

test("the gate scans tracked root, hidden and nested dependency inputs only", (t) => {
  const gate = fixture(t);
  const result = gate.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLEAN/);
  const args = gate.arguments();
  assert.deepEqual(args.slice(0, 2), ["scan", "source"]);
  assert.deepEqual(
    args.filter((arg) => arg.startsWith("--lockfile=")).sort(),
    gate.inputs.map((file) => `--lockfile=${file}`).sort(),
  );
  assert.ok(args.includes(`--config=${join(gate.repo, "osv-scanner.toml")}`));
  const sbom = args.find((arg) => arg.startsWith("--sbom="));
  assert.ok(sbom, "the native compiler is included in the scanner inventory");
  const inventory = JSON.parse(readFileSync(sbom.slice(7), "utf8"));
  assert.deepEqual(inventory.components, [
    {
      type: "framework",
      name: "stdlib",
      version: "1.27.3",
      purl: "pkg:golang/stdlib@1.27.3",
    },
  ]);
});

test("missing or malformed native compiler metadata fails closed", (t) => {
  const gate = fixture(t);
  for (const plan of [
    {},
    { compiler: {} },
    { compiler: { version: "unknown" } },
  ]) {
    writeFileSync(
      join(gate.repo, "tools/pwa-tailscale-native-http/source.json"),
      JSON.stringify(plan),
    );
    const result = gate.run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /CLEAN/);
  }
  rmSync(join(gate.repo, "tools/pwa-tailscale-native-http/source.json"));
  assert.notEqual(
    gate.run().status,
    0,
    "a deleted tracked plan is not omitted",
  );
});

test("native source requires a successful package-graph audit", (t) => {
  const gate = fixture(t);
  const failed = gate.run({ OSV_TEST_NATIVE_AUDIT_STATUS: "1" });
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stdout, /CLEAN/);
  rmSync(join(gate.repo, "tools/pwa-tailscale-native-http/native-audit.mjs"));
  const missing = gate.run();
  assert.notEqual(missing.status, 0);
  assert.doesNotMatch(missing.stdout, /CLEAN/);
});

test("nested-workspace advisories fail even when scanner exits successfully", (t) => {
  const gate = fixture(t);
  const report = JSON.stringify({
    results: [
      {
        source: { path: ".deepsec/pnpm-lock.yaml" },
        packages: [
          {
            package: { name: "affected", version: "1.0.0", ecosystem: "npm" },
            vulnerabilities: [{ id: "GHSA-fixture" }],
          },
        ],
      },
    ],
  });
  for (const status of ["0", "1"]) {
    const result = gate.run({
      OSV_TEST_REPORT: report,
      OSV_TEST_STATUS: status,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GHSA-fixture/);
    assert.match(result.stderr, /\.deepsec\/pnpm-lock.yaml/);
    assert.doesNotMatch(result.stdout, /CLEAN/);
  }
});

test("scanner errors, omitted findings and malformed reports fail closed", (t) => {
  const gate = fixture(t);
  for (const env of [
    { OSV_TEST_STATUS: "2" },
    { OSV_TEST_STATUS: "1" },
    { OSV_TEST_REPORT: "missing" },
    { OSV_TEST_REPORT: "{" },
    { OSV_TEST_REPORT: "{}" },
  ]) {
    const result = gate.run(env);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.doesNotMatch(result.stdout, /CLEAN/);
  }
});

test("a checkout without tracked dependency inputs fails closed", (t) => {
  const gate = fixture(t);
  execFileSync("git", ["rm", "--cached", ...gate.inputs], { cwd: gate.repo });
  const result = gate.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no tracked dependency inputs/);
});

test("local crypto source requires a successful companion audit", (t) => {
  const gate = fixture(t);
  const audit = join(gate.repo, "scripts/test/live-turn/audit-crypto.sh");
  for (const replacement of [
    "",
    "replace golang.org/x/crypto => ./third_party/x-crypto\n",
  ]) {
    writeFileSync(
      join(gate.repo, "scripts/test/live-turn/go.mod"),
      `module fixture\n${replacement}`,
    );
    rmSync(audit);
    assert.notEqual(gate.run().status, 0, "missing companion must fail");
    writeFileSync(audit, "#!/usr/bin/env bash\nexit 42\n");
    assert.equal(gate.run().status, 42, "companion findings must fail");
    writeFileSync(audit, "#!/usr/bin/env bash\nexit 0\n");
    assert.equal(gate.run().status, 0);
  }
});
