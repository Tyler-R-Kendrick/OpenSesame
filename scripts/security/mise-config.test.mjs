import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

function kind(value) {
  return Object.prototype.toString.call(value);
}

function asString(value, label) {
  assert.equal(kind(value), "[object String]", label);
  return value;
}

function asBoolean(value, label) {
  assert.equal(kind(value), "[object Boolean]", label);
  return value;
}

function asTable(value, label) {
  assert.equal(kind(value), "[object Object]", label);
  return value;
}

function stringList(value, label) {
  if (Array.isArray(value)) {
    return value.map((entry) => asString(entry, label));
  }
  return asString(value, label)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function balanced(text) {
  let quoted = false;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && quoted) {
      index += 1;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "{") braces += 1;
    else if (!quoted && character === "}") braces -= 1;
    else if (!quoted && character === "[") brackets += 1;
    else if (!quoted && character === "]") brackets -= 1;
  }
  return !quoted && braces === 0 && brackets === 0;
}

function stripComment(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && quoted) {
      index += 1;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (character === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}

function logicalLines(text) {
  const lines = [];
  let buffer = "";
  for (const physical of text.split("\n")) {
    const piece = stripComment(physical).trim();
    if (buffer === "" && piece === "") continue;
    buffer = buffer === "" ? piece : `${buffer} ${piece}`;
    if (balanced(buffer)) {
      if (buffer !== "") lines.push(buffer);
      buffer = "";
    }
  }
  assert.equal(buffer, "", "unterminated mise.toml value");
  return lines;
}

function splitTop(text, separator) {
  const parts = [];
  let quoted = false;
  let braces = 0;
  let brackets = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && quoted) {
      index += 1;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "{") braces += 1;
    else if (!quoted && character === "}") braces -= 1;
    else if (!quoted && character === "[") brackets += 1;
    else if (!quoted && character === "]") brackets -= 1;
    else if (
      !quoted &&
      braces === 0 &&
      brackets === 0 &&
      character === separator
    ) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseString(text, label) {
  assert.equal(text[0], '"', label);
  let value = "";
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      const escaped = text[index + 1];
      assert.ok(escaped === '"' || escaped === "\\", label);
      value += escaped;
      index += 1;
      continue;
    }
    if (character === '"') {
      assert.equal(text.slice(index + 1).trim(), "", label);
      return value;
    }
    value += character;
  }
  assert.fail(`unterminated string in ${label}`);
}

function parseValue(text, label) {
  if (text === "true" || text === "false") return text === "true";
  if (text.startsWith('"')) return parseString(text, label);
  if (text.startsWith("[")) {
    assert.equal(text.at(-1), "]", label);
    const body = text.slice(1, -1).trim();
    if (body === "") return [];
    return splitTop(body, ",").map((part) =>
      parseValue(part.trim(), `${label} array`),
    );
  }
  if (text.startsWith("{")) {
    assert.equal(text.at(-1), "}", label);
    const body = text.slice(1, -1).trim();
    const table = {};
    if (body === "") return table;
    for (const part of splitTop(body, ",")) {
      const entry = part.trim();
      if (entry === "") continue;
      assign(table, entry, label);
    }
    return table;
  }
  assert.fail(`unsupported TOML value in ${label}: ${text}`);
}

function unquoteKey(key, label) {
  const trimmed = key.trim();
  if (trimmed.startsWith('"')) return parseString(trimmed, label);
  assert.match(trimmed, /^[A-Za-z0-9_-]+$/u, label);
  return trimmed;
}

function assign(table, entry, label) {
  const parts = splitTop(entry, "=");
  assert.ok(parts.length >= 2, `${label}: ${entry}`);
  const key = unquoteKey(parts[0], label);
  table[key] = parseValue(parts.slice(1).join("=").trim(), key);
}

function tableAt(rootTable, header) {
  let cursor = rootTable;
  for (const part of header.split(".")) {
    const key = unquoteKey(part, header);
    if (!Object.hasOwn(cursor, key)) cursor[key] = {};
    cursor = asTable(cursor[key], key);
  }
  return cursor;
}

// Rejects syntax this gate does not understand so an edit cannot skip a pin.
function parseToml(text) {
  const rootTable = {};
  let current = rootTable;
  for (const line of logicalLines(text)) {
    if (line.startsWith("[")) {
      const header = line.match(/^\[([^\]]+)\]$/u);
      assert.ok(header, `unsupported table header: ${line}`);
      current = tableAt(rootTable, header[1]);
      continue;
    }
    assign(current, line, "mise.toml");
  }
  return rootTable;
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
    sorted([
      ...stringList(declared.components, "components"),
      "llvm-tools-preview",
    ]),
  );
  assert.match(
    readText("mise.lock"),
    /\[tools\.rust\.options\]\ncomponents = "clippy,llvm-tools-preview,rustfmt"\ntargets = "wasm32-unknown-unknown"\n/u,
  );
  assert.deepEqual(
    sorted(stringList(rust.targets, "rust.targets")),
    sorted(stringList(declared.targets, "targets")),
  );

  // mise.toml pins Node 24. package.json engines.node is ">=24" after the
  // npm workspaces migration. packageManager is removed; pnpm stays out of mise.
  assert.equal(asString(tools.node, "node"), "24");
  assert.equal(manifest.engines.node, ">=24");
  assert.equal(Object.hasOwn(manifest, "packageManager"), false);
  assert.equal(Object.hasOwn(tools, "pnpm"), false);
  assert.ok(
    Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0,
  );

  const goDirective = readText("scripts/test/live-turn/go.mod").match(
    /^go\s+(\S+)\s*$/mu,
  );
  assert.ok(goDirective, "go.mod go directive");
  assert.equal(asString(tools.go, "go"), goDirective[1]);
  assert.match(ci, /install_args: go\s*$/mu);
  assert.doesNotMatch(ci, /actions\/setup-go/u);
  assert.doesNotMatch(ci, /go-version-file:/u);

  assert.match(asString(tools.java, "java"), /^temurin-17(?:\.|$)/u);
  assert.doesNotMatch(ci, /JAVA_HOME_17_X64/u);
  assert.match(ci, /install_args: rust java cargo:cargo-ndk\s*$/mu);

  assert.equal(asString(tools["cargo:cargo-ndk"], "cargo-ndk"), "4.1.2");
  assert.doesNotMatch(ci, /cargo install cargo-ndk/u);

  const env = asTable(mise.env, "env");
  assert.equal(
    asString(env.CARGO_TARGET_DIR, "CARGO_TARGET_DIR"),
    "{{env.HOME}}/.cache/packages/cargo-target",
  );
  assert.equal(
    asString(env.ANDROID_SDK_PLATFORM, "ANDROID_SDK_PLATFORM"),
    "android-36",
  );
  assert.equal(
    asString(env.ANDROID_BUILD_TOOLS, "ANDROID_BUILD_TOOLS"),
    "35.0.0",
  );
  assert.equal(
    asString(env.ANDROID_BUILD_TOOLS_LATEST, "ANDROID_BUILD_TOOLS_LATEST"),
    "36.0.0",
  );
  assert.equal(
    asString(env.ANDROID_NDK_VERSION, "ANDROID_NDK_VERSION"),
    "28.0.13004108",
  );
  assert.match(ci, /platforms;\$\{ANDROID_SDK_PLATFORM\}/u);
  assert.match(ci, /build-tools;\$\{ANDROID_BUILD_TOOLS\}/u);
  assert.match(ci, /build-tools;\$\{ANDROID_BUILD_TOOLS_LATEST\}/u);
  assert.match(ci, /ndk;\$\{ANDROID_NDK_VERSION\}/u);
  assert.doesNotMatch(ci, /28\.0\.13004108/u);
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
