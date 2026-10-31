import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pinned = {
  amd64: "edcfc41d257db36148f065055655fe3fcfc434b0b423ea67468a84c207524e0c",
  arm64: "fe152e1a546af223e6c557cc3111a8bb3e5dc02fcbf7dbe95d26567c0f0041f2",
};

const scanner = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$OSV_TEST_EXECUTIONS"
if [[ "$1" == --version ]]; then
  printf 'osv-scanner version: %s\\n' "$OSV_TEST_VERSION"
  exit 0
fi
output=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --output-file ]]; then output="$2"; shift; fi
  shift
done
printf '%s' "$OSV_TEST_REPORT" > "$output"
exit "$OSV_TEST_STATUS"
`;

const downloader = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$OSV_TEST_DOWNLOADS"
output=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then output="$2"; shift; fi
  shift
done
cat "$OSV_TEST_BINARY" > "$output"
`;

const checksum = `#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
printf '%s\\n' "$input" >> "$OSV_TEST_CHECKSUMS"
printf '%s\\n' "$input" | /usr/bin/sha256sum "$@"
`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-osv-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  for (const file of [
    "scripts/audit/osv-scanner-gate.sh",
    "scripts/lib/audit-directory.sh",
    "scripts/security/assert-no-advisories.mjs",
  ]) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    copyFileSync(join(root, file), join(checkout, file));
  }
  writeFileSync(join(checkout, "pnpm-lock.yaml"), "fixture\n");
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  execFileSync("git", ["add", "."], { cwd: checkout });
  const executable = join(directory, "scanner");
  writeFileSync(executable, scanner, { mode: 0o700 });
  writeFileSync(join(bin, "curl"), downloader, { mode: 0o700 });
  writeFileSync(join(bin, "sha256sum"), checksum, { mode: 0o700 });
  writeFileSync(
    join(bin, "uname"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$OSV_TEST_ARCH"\n',
    { mode: 0o700 },
  );
  return {
    directory,
    checkout,
    bin,
    executable,
    digest: createHash("sha256").update(scanner).digest("hex"),
  };
}

function runGate(f, options = {}) {
  const env = {
    ...process.env,
    PATH: `${f.bin}:${process.env.PATH}`,
    OPENSESAME_AUDIT_DIR: f.directory,
    OSV_TEST_ARCH: options.arch || "x86_64",
    OSV_TEST_VERSION: options.toolVersion || "2.5.0",
    OSV_TEST_REPORT: JSON.stringify(options.report || { results: [] }),
    OSV_TEST_STATUS: String(options.status || 0),
    OSV_TEST_BINARY: f.executable,
    OSV_TEST_EXECUTIONS: join(f.directory, "executions"),
    OSV_TEST_DOWNLOADS: join(f.directory, "downloads"),
    OSV_TEST_CHECKSUMS: join(f.directory, "checksums"),
  };
  for (const key of ["VERSION", "BIN", "SHA256"])
    delete env[`OPENSESAME_OSV_SCANNER_${key}`];
  if (options.version !== undefined)
    env.OPENSESAME_OSV_SCANNER_VERSION = options.version;
  if (options.supplied !== false)
    env.OPENSESAME_OSV_SCANNER_BIN = options.binary || f.executable;
  if (options.digest !== undefined)
    env.OPENSESAME_OSV_SCANNER_SHA256 = options.digest;
  const result = spawnSync(
    "bash",
    [join(f.checkout, "scripts/audit/osv-scanner-gate.sh")],
    { env, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  return result;
}

function unused(f) {
  assert.equal(existsSync(join(f.directory, "executions")), false);
  assert.equal(existsSync(join(f.directory, "downloads")), false);
}

test("default Linux downloads use the reviewed architecture-specific pins before execution", (t) => {
  for (const [arch, target] of [
    ["x86_64", "amd64"],
    ["aarch64", "arm64"],
  ]) {
    const f = fixture(t);
    const result = runGate(f, { supplied: false, arch });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scanner digest mismatch/);
    assert.equal(existsSync(join(f.directory, "executions")), false);
    assert.match(
      readFileSync(join(f.directory, "downloads"), "utf8"),
      new RegExp(`/v2\\.5\\.0/osv-scanner_linux_${target}`),
    );
    assert.equal(
      readFileSync(join(f.directory, "checksums"), "utf8"),
      `${pinned[target]}  ${join(f.checkout, ".tools/bin/osv-scanner")}\n`,
    );
  }
});

test("an absent pin for a different version or explicitly empty override fails before download or execution", (t) => {
  for (const options of [{ version: "9.9.9" }, { digest: "" }]) {
    const f = fixture(t);
    const result = runGate(f, { ...options, supplied: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing scanner digest/);
    unused(f);
  }
});

test("malformed and placeholder digests are refused before download or execution", (t) => {
  for (const digest of [
    "REPLACE_WITH_V2_5_0_LINUX_RELEASE_SHA256",
    "not-a-digest",
    "a".repeat(63),
    "a".repeat(65),
    `${"a".repeat(64)}\n`,
  ]) {
    const f = fixture(t);
    const result = runGate(f, { digest, supplied: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid scanner digest/);
    unused(f);
  }
});

test("overridden binaries must match an explicit or built-in pin before even --version runs", (t) => {
  for (const digest of [undefined, "0".repeat(64)]) {
    const f = fixture(t);
    const result = runGate(f, { digest });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scanner digest mismatch/);
    unused(f);
    assert.equal(readFileSync(f.executable, "utf8"), scanner);
  }
});

test("a correct override checksum permits scanning and also supports an explicitly pinned custom version", (t) => {
  for (const version of ["2.5.0", "9.9.9"]) {
    const f = fixture(t);
    const result = runGate(f, {
      digest: f.digest,
      version,
      toolVersion: version,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CLEAN \(no findings\)/);
    assert.equal(existsSync(join(f.directory, "downloads")), false);
    assert.match(
      readFileSync(join(f.directory, "executions"), "utf8"),
      /^--version\nscan source /,
    );
  }
});

test("downloaded bytes pass the same checksum verification before being made executable", (t) => {
  const f = fixture(t);
  const result = runGate(f, { supplied: false, digest: f.digest });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLEAN \(no findings\)/);
  assert.equal(
    readFileSync(join(f.directory, "checksums"), "utf8"),
    `${f.digest}  ${join(f.checkout, ".tools/bin/osv-scanner")}\n`,
  );
});

test("a missing override binary is never silently replaced by a download", (t) => {
  const f = fixture(t);
  const result = runGate(f, {
    binary: `${f.executable}.missing`,
    digest: f.digest,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /configured scanner is missing/);
  unused(f);
});

test("binary path overrides cannot verify one file and execute a different PATH entry", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, "scanner"), scanner, { mode: 0o700 });
  writeFileSync(
    join(f.bin, "scanner"),
    '#!/usr/bin/env bash\necho substituted >> "$OSV_TEST_EXECUTIONS"\nexit 1\n',
    { mode: 0o700 },
  );
  const result = runGate(f, { binary: "scanner", digest: f.digest });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(
    readFileSync(join(f.directory, "executions"), "utf8"),
    /substituted/,
  );
  for (const suffix of ["\n", "\r"]) {
    const invalid = fixture(t);
    const rejected = runGate(invalid, {
      binary: `${invalid.executable}${suffix}`,
      digest: invalid.digest,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /invalid scanner path/);
    unused(invalid);
  }
});

test("verified executables must report the exact requested version", (t) => {
  const f = fixture(t);
  const result = runGate(f, { digest: f.digest, toolVersion: "2.5.00" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scanner version mismatch/);
  assert.equal(
    readFileSync(join(f.directory, "executions"), "utf8"),
    "--version\n",
  );
  assert.equal(existsSync(join(f.directory, "downloads")), false);
});

test("verification never changes scanner-error or omitted-findings failures into a clean report", (t) => {
  for (const status of [1, 2]) {
    const f = fixture(t);
    const result = runGate(f, { digest: f.digest, status });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scanner error|scanner findings omitted/);
  }
});
