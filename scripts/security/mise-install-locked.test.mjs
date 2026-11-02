import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { asString, asTable, parseToml, stringList } from "./mise-toml.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Honors the same overrides mise uses for its shim directory.
const shimsPath =
  "${MISE_SHIMS_DIR:-${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims}";

function readText(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function miseOnPath() {
  const found = spawnSync("mise", ["--version"], { encoding: "utf8" });
  return found.status === 0;
}

test("cargo: installs pin Rust 1.88 ahead of the image rustup default", () => {
  const mise = parseToml(readText("mise.toml"));
  const toolchain = parseToml(readText("rust-toolchain.toml"));
  const tools = asTable(mise.tools, "tools");
  const rust = asTable(tools.rust, "rust");
  const rustVersion = asString(rust.version, "rust.version");
  assert.equal(
    rustVersion,
    asString(asTable(toolchain.toolchain, "toolchain").channel, "channel"),
  );
  assert.equal(rustVersion, "1.88.0");

  const env = asTable(mise.env, "env");
  assert.equal(asString(env.RUSTUP_TOOLCHAIN, "RUSTUP_TOOLCHAIN"), rustVersion);

  // _.path prepends. position = "append" would leave /usr/local/cargo/bin first.
  const pathDirective = asTable(env._, "env._");
  assert.equal(Object.hasOwn(pathDirective, "position"), false);
  assert.deepEqual(stringList(pathDirective.path, "env._.path"), [shimsPath]);

  const cargoTools = Object.keys(tools).filter((name) =>
    name.startsWith("cargo:"),
  );
  assert.ok(cargoTools.length > 0, "at least one cargo: tool");
  for (const name of cargoTools) {
    const tool = asTable(tools[name], name);
    assert.ok(
      stringList(tool.depends, `${name}.depends`).includes("rust"),
      `${name} depends on rust`,
    );
    assert.equal(
      asString(
        asTable(tool.install_env, `${name}.install_env`).RUSTUP_TOOLCHAIN,
        `${name}.RUSTUP_TOOLCHAIN`,
      ),
      rustVersion,
    );
  }
});

test(
  "mise env keeps Rust 1.88 shims ahead of /usr/local/cargo",
  {
    skip: miseOnPath() ? false : "mise is not installed",
  },
  () => {
    const envRun = spawnSync("mise", ["env", "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(envRun.status, 0, envRun.stderr);
    const env = JSON.parse(envRun.stdout);
    assert.equal(env.RUSTUP_TOOLCHAIN, "1.88.0");

    const path = asString(env.PATH, "PATH").split(":");
    const shimIndex = path.findIndex((entry) => entry.endsWith("/shims"));
    const cargoIndex = path.indexOf("/usr/local/cargo/bin");
    assert.ok(shimIndex >= 0, `shims missing from PATH: ${path.join("\n")}`);
    if (cargoIndex >= 0) {
      assert.ok(
        shimIndex < cargoIndex,
        `shims must precede /usr/local/cargo/bin:\n${path.join("\n")}`,
      );
    }

    // cargo install uses a cwd outside the repo, so rust-toolchain.toml cannot win.
    const version = spawnSync(
      "mise",
      [
        "exec",
        "--",
        "bash",
        "-c",
        'cd "$(mktemp -d)" && rustc --version && cargo --version',
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /rustc 1\.88\.0/);
    assert.match(version.stdout, /cargo 1\.88\.0/);
  },
);
