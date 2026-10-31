import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const transport = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];
const confidential = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "TOKEN",
  "AWS_SECRET_ACCESS_KEY",
];

function fixture(t, policy) {
  const folder = mkdtempSync(join(tmpdir(), "opensesame-turbo-transport-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, "task"));
  mkdirSync(join(folder, "bin"));
  writeFileSync(
    join(folder, "bin/pnpm"),
    `#!${process.execPath}
import {spawnSync} from "node:child_process";
if (process.argv[2] === "--version") console.log("9.15.0");
else {
  const result = spawnSync(process.execPath, ["probe.mjs"], {stdio: "inherit", env: process.env});
  process.exit(result.status ?? 1);
}
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({
      name: "transport-fixture",
      private: true,
      packageManager: "pnpm@9.15.0",
    }),
  );
  writeFileSync(join(folder, "pnpm-workspace.yaml"), "packages:\n  - task\n");
  writeFileSync(
    join(folder, "task/package.json"),
    JSON.stringify({
      name: "transport-child",
      private: true,
      scripts: { probe: "node probe.mjs" },
    }),
  );
  writeFileSync(
    join(folder, "turbo.json"),
    JSON.stringify({
      globalPassThroughEnv: policy.globalPassThroughEnv,
      tasks: { probe: { cache: false } },
    }),
  );
  const compilerModule = pathToFileURL(
    join(root, "tools/pwa-tailscale-native-http/compose-native.mjs"),
  ).href;
  writeFileSync(
    join(folder, "task/probe.mjs"),
    `
import {writeFileSync} from "node:fs";
import {nativeBuildEnvironment} from ${JSON.stringify(compilerModule)};
const keys = ${JSON.stringify([...transport, ...confidential, "HOME", "GOFLAGS", "TS_PERMIT_TOOLCHAIN_MISMATCH"])};
const compiler = nativeBuildEnvironment("/owned", "-mod=readonly");
const present = (env) => Object.fromEntries(keys.map(key => [key, env[key] !== undefined]));
writeFileSync("result.json", JSON.stringify({task: present(process.env), compiler: present(compiler), flags: compiler.GOFLAGS}));
`,
  );
  execFileSync("git", ["init", "-q"], { cwd: folder });
  return folder;
}

test("strict Turbo retains transport while native children exclude unrelated credentials", (t) => {
  const policy = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8"));
  assert.deepEqual(policy.globalPassThroughEnv, transport);
  const folder = fixture(t, policy);
  const parent = { ...process.env, TURBO_TELEMETRY_DISABLED: "1" };
  parent.PATH = `${join(folder, "bin")}:${process.env.PATH}`;
  for (const key of transport)
    parent[key] = key.toLowerCase().includes("proxy")
      ? "http://fixture.invalid:1234"
      : "/approved/ca";
  for (const key of confidential) parent[key] = "not-forwarded";
  parent.GOFLAGS = "-tags=unapproved";
  parent.TS_PERMIT_TOOLCHAIN_MISMATCH = "1";
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/turbo/bin/turbo"),
      "run",
      "probe",
      "--env-mode=strict",
    ],
    { cwd: folder, env: parent, encoding: "utf8", timeout: 15000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(
    readFileSync(join(folder, "task/result.json"), "utf8"),
  );
  for (const key of transport) {
    assert.equal(observed.task[key], true, key);
    assert.equal(observed.compiler[key], true, key);
  }
  for (const key of confidential) {
    // Turbo itself permits some CI variables by default. We add none of them,
    // and the native compiler boundary still excludes every credential.
    if (key !== "GITHUB_TOKEN") assert.equal(observed.task[key], false, key);
    assert.equal(observed.compiler[key], false, key);
  }
  for (const key of ["HOME", "TS_PERMIT_TOOLCHAIN_MISMATCH"])
    assert.equal(observed.compiler[key], false, key);
  assert.equal(observed.flags, "-mod=readonly");
});
