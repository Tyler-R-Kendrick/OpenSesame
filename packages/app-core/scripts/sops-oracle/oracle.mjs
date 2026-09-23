/**
 * The pinned upstream SOPS oracle for development and CI (CONFORMANCE-01).
 *
 * Release v3.13.3 (source commit 26e2f4784ca61353082c32dbd987c25eda086dc9)
 * is fetched once into a cache directory and verified against the
 * checksums published with the release before it is ever executed. Every
 * invocation runs with an empty environment, a private HOME and config
 * dir, explicit identity files, and no plugin or key-service discovery.
 *
 * This is a build-time tool. The shipped browser never invokes it and
 * never asks a user to install it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";

export const SOPS_VERSION = "3.13.3";
export const SOPS_SOURCE_COMMIT = "26e2f4784ca61353082c32dbd987c25eda086dc9";

/** From sops-v3.13.3.checksums.txt on the GitHub release. */
export const CHECKSUMS = {
  "linux-x64": [
    "sops-v3.13.3.linux.amd64",
    "e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b",
  ],
  "linux-arm64": [
    "sops-v3.13.3.linux.arm64",
    "53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77",
  ],
  "darwin-x64": [
    "sops-v3.13.3.darwin.amd64",
    "42162d5cef10b74fcf80a045a70e658d7ce6e63d6ea1be6f347e44015714468d",
  ],
  "darwin-arm64": [
    "sops-v3.13.3.darwin.arm64",
    "b97c0d434aab577dc40310e8d22ff9e45eef4c80638ab978daae9b4681c59286",
  ],
};

export function oracleCacheDir() {
  return (
    process.env.SOPS_ORACLE_DIR ?? join(tmpdir(), "opensesame-sops-oracle")
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Locate or provision the verified binary. Returns `{ bin, sha256 }` or
 * `{ error }` (never throws): a missing oracle is an incomplete result, not
 * a browser failure. `SOPS_BIN` may name a binary, but it is only accepted
 * when its digest matches the pinned release.
 */
export function provisionOracle({ allowDownload = true } = {}) {
  const key = `${platform()}-${arch()}`;
  const pinned = CHECKSUMS[key];
  if (!pinned)
    return { error: `no pinned sops ${SOPS_VERSION} artifact for ${key}` };
  const [name, expected] = pinned;
  const candidates = [];
  if (process.env.SOPS_BIN) candidates.push(process.env.SOPS_BIN);
  const dir = oracleCacheDir();
  const cached = join(dir, name);
  candidates.push(cached);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const actual = sha256(candidate);
      if (actual === expected) return { bin: candidate, sha256: actual, name };
      if (candidate === process.env.SOPS_BIN) {
        return {
          error: `SOPS_BIN digest ${actual} is not the pinned ${SOPS_VERSION} release`,
        };
      }
    }
  }
  if (!allowDownload)
    return {
      error: "pinned sops oracle is not present and downloads are disabled",
    };
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/${name}`;
  const download = spawnSync(
    "curl",
    ["-fsSL", "--max-time", "300", "-o", cached, url],
    { stdio: "inherit" },
  );
  if (download.status !== 0) return { error: `could not download ${url}` };
  const actual = sha256(cached);
  if (actual !== expected) {
    rmSync(cached, { force: true });
    return {
      error: `downloaded oracle digest ${actual} does not match ${expected}`,
    };
  }
  chmodSync(cached, 0o755);
  return { bin: cached, sha256: actual, name };
}

/**
 * Run the oracle hermetically. `identities` are written to a private key
 * file; `config` (optional) becomes the `.sops.yaml` beside the input.
 */
export function runSops(
  bin,
  {
    args,
    input,
    inputName = "doc.yaml",
    identities = [],
    config = null,
    timeoutMs = 20_000,
    readBack = false,
  },
) {
  const work = mkdtempSync(join(tmpdir(), "sops-oracle-"));
  try {
    const home = join(work, "home");
    mkdirSync(join(home, ".config"), { recursive: true });
    const file = join(work, inputName);
    writeFileSync(file, input);
    if (config !== null) writeFileSync(join(work, ".sops.yaml"), config);
    const keyFile = join(work, "keys.txt");
    writeFileSync(keyFile, `${identities.join("\n")}\n`, { mode: 0o600 });
    const result = spawnSync(bin, [...args, file], {
      cwd: work,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PATH: "/nonexistent",
        SOPS_AGE_KEY_FILE: keyFile,
        SOPS_DISABLE_VERSION_CHECK: "1",
      },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: (result.stderr ?? "").slice(0, 4000),
      timedOut: result.error?.code === "ETIMEDOUT",
      // In-place commands such as `--set` and `--rotate` rewrite the file.
      file: readBack && existsSync(file) ? readFileSync(file, "utf8") : null,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Build the tree-dump helper from the pinned source when Go is available. */
export function provisionTreedump() {
  const dir = oracleCacheDir();
  const bin = join(dir, `treedump-${SOPS_SOURCE_COMMIT.slice(0, 12)}`);
  if (existsSync(bin)) return { bin };
  const go = spawnSync("go", ["version"], { encoding: "utf8" });
  if (go.status !== 0)
    return { error: "go toolchain not available to build treedump" };
  mkdirSync(dir, { recursive: true });
  const src = join(dir, "sops-src");
  if (!existsSync(join(src, "go.mod"))) {
    const clone = spawnSync(
      "git",
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        `v${SOPS_VERSION}`,
        "https://github.com/getsops/sops",
        src,
      ],
      { stdio: "inherit" },
    );
    if (clone.status !== 0)
      return { error: "could not clone upstream sops source" };
  }
  const head = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  if (head !== SOPS_SOURCE_COMMIT)
    return {
      error: `upstream checkout is ${head}, expected ${SOPS_SOURCE_COMMIT}`,
    };
  mkdirSync(join(src, "treedump"), { recursive: true });
  writeFileSync(
    join(src, "treedump", "main.go"),
    readFileSync(new URL("./treedump.go", import.meta.url)),
  );
  const build = spawnSync("go", ["build", "-o", bin, "./treedump"], {
    cwd: src,
    stdio: "inherit",
    timeout: 600_000,
  });
  if (build.status !== 0) return { error: "go build of treedump failed" };
  return { bin };
}

export function runTreedump(bin, format, input, inputName = "doc.yaml") {
  const work = mkdtempSync(join(tmpdir(), "sops-treedump-"));
  try {
    const file = join(work, inputName);
    writeFileSync(file, input);
    const result = spawnSync(bin, [format, file], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
