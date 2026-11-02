import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  asBoolean,
  asString,
  asTable,
  kind,
  parseToml,
  stringList,
} from "./mise-toml.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const lockPlatforms = [
  "linux-x64",
  "linux-arm64",
  "macos-arm64",
  "macos-x64",
  "windows-x64",
];

function readText(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function sorted(values) {
  return [...values].sort();
}

test("mise.toml matches the Rust, Node, Go, Java, and cargo-ndk pins", () => {
  const mise = parseToml(readText("mise.toml"));
  const toolchain = parseToml(readText("rust-toolchain.toml"));
  const manifest = JSON.parse(readText("package.json"));
  const ci = readText(".github/workflows/ci-prerelease-checks.yml");
  const tools = asTable(mise.tools, "tools");
  const rust = asTable(tools.rust, "rust");
  const declared = asTable(toolchain.toolchain, "toolchain");

  assert.equal(
    asString(rust.version, "rust.version"),
    asString(declared.channel, "channel"),
  );
  assert.deepEqual(
    sorted(stringList(rust.components, "rust.components")),
    sorted(stringList(declared.components, "components")),
  );
  assert.deepEqual(
    sorted(stringList(rust.targets, "rust.targets")),
    sorted(stringList(declared.targets, "targets")),
  );

  // mise.toml targets Node 24. package.json engines.node remains ">=22":
  // that floor is unchanged in this PR. packageManager stays pnpm until the
  // npm workspaces migration, so pnpm is intentionally absent from mise.
  assert.equal(asString(tools.node, "node"), "24");
  assert.equal(manifest.engines.node, ">=22");
  assert.match(manifest.packageManager, /^pnpm@/u);
  assert.equal(Object.hasOwn(tools, "pnpm"), false);

  const goFile = ci.match(/^ {2,}go-version-file:\s+(\S+)\s*$/mu);
  assert.ok(goFile, "ci-prerelease-checks go-version-file");
  const goDirective = readText(goFile[1]).match(/^go\s+(\S+)\s*$/mu);
  assert.ok(goDirective, "go.mod go directive");
  assert.equal(asString(tools.go, "go"), goDirective[1]);

  const javaHome = [...ci.matchAll(/JAVA_HOME_(\d+)_X64/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(javaHome)], ["17"]);
  assert.match(asString(tools.java, "java"), /^temurin-17(?:\.|$)/u);

  const cargoNdk = ci.match(
    /cargo install cargo-ndk --version (\S+) --locked/u,
  );
  assert.ok(cargoNdk, "ci-prerelease-checks cargo-ndk pin");
  const cargoNdkTool = tools["cargo:cargo-ndk"];
  const cargoNdkVersion =
    kind(cargoNdkTool) === "[object Object]"
      ? asString(
          asTable(cargoNdkTool, "cargo-ndk").version,
          "cargo-ndk.version",
        )
      : asString(cargoNdkTool, "cargo-ndk");
  assert.equal(cargoNdkVersion, cargoNdk[1]);

  assert.equal(
    asString(asTable(mise.env, "env").CARGO_TARGET_DIR, "CARGO_TARGET_DIR"),
    "{{env.HOME}}/.cache/packages/cargo-target",
  );
  assert.equal(
    asBoolean(asTable(mise.settings, "settings").lockfile, "lockfile"),
    true,
  );
  const tasks = asTable(mise.tasks, "tasks");
  for (const name of ["setup", "deps"]) {
    assert.equal(
      asString(asTable(tasks[name], name).run, `${name}.run`),
      "bash scripts/dev/install-dependencies.sh",
    );
  }
});

test("mise.lock exists and names every install platform", () => {
  const lock = readText("mise.lock");
  for (const platform of lockPlatforms) {
    assert.ok(
      lock.includes(`platforms.${platform}`),
      `mise.lock does not mention ${platform}`,
    );
  }
});
