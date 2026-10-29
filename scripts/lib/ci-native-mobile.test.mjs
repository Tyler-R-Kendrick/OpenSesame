import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const script = join(root, "scripts/test/mobile-changed.sh");

function classify(path) {
  const fixture = mkdtempSync(join(tmpdir(), "opensesame-native-ci-"));
  const git = (args) =>
    execFileSync("git", args, { cwd: fixture, encoding: "utf8" }).trim();
  try {
    git(["init", "--quiet"]);
    git(["config", "user.name", "Native CI fixture"]);
    git(["config", "user.email", "native-ci@example.invalid"]);
    git(["commit", "--quiet", "--allow-empty", "-m", "baseline"]);
    const base = git(["rev-parse", "HEAD"]);
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), "changed\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "change"]);
    return execFileSync("bash", [script], {
      cwd: fixture,
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: git(["rev-parse", "HEAD"]),
        GITHUB_OUTPUT: "",
      },
      encoding: "utf8",
    }).trim();
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("native mobile required checks", () => {
  it("can create the default bindgen Cargo cache in a fresh checkout", () => {
    const fixture = mkdtempSync(join(tmpdir(), "opensesame-native-cache-"));
    try {
      const target = join(root, "target");
      if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
        symlinkSync(
          join(fixture, "missing-checkout-target"),
          join(fixture, "target"),
        );
      const build = readFileSync(
        join(root, "apps/android/scripts/build-core.sh"),
        "utf8",
      );
      const defaults = build
        .split("\n")
        .filter((line) => /^ {2}local bindgen_(cargo_home|target)=/.test(line));
      expect(defaults).toHaveLength(2);
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            ![
              "OPENSESAME_BINDGEN_CARGO_HOME",
              "OPENSESAME_BINDGEN_TARGET_DIR",
            ].includes(name),
        ),
      );
      execFileSync(
        "bash",
        [
          "-euc",
          `repo_root="$1"; cache() { ${defaults.join("\n")}
mkdir -p "$bindgen_cargo_home" "$bindgen_target"
touch "$bindgen_cargo_home/.package-cache"
}; cache`,
          "--",
          fixture,
        ],
        { env: environment, stdio: "pipe" },
      );
      expect(
        lstatSync(
          join(
            fixture,
            "target/authenticator-bindgen-cargo-home/.package-cache",
          ),
        ).isFile(),
      ).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    "apps/android/android/app/src/main/Wallet.kt",
    "apps/android/ios/EnvelopeCore/Package.swift",
    "crates/authenticator-core/src/lib.rs",
    "Cargo.lock",
    "scripts/test/mobile-apple.sh",
    ".github/workflows/ci.yml",
  ])("tests changed native or ABI input %s", (path) => {
    expect(classify(path)).toBe("native_mobile=true");
  });

  it.each([
    "docs/native.md",
    "apps/android/README.md",
    "apps/pages/src/main.tsx",
  ])("does not require native compilers for %s", (path) => {
    expect(classify(path)).toBe("native_mobile=false");
  });

  it("fails closed when a diff cannot be determined", () => {
    const output = execFileSync("bash", [script], {
      cwd: root,
      env: { ...process.env, BASE_SHA: "", HEAD_SHA: "", GITHUB_OUTPUT: "" },
      encoding: "utf8",
    });
    expect(output.trim()).toBe("native_mobile=true");
  });

  it("makes actual platform tests and builds part of the required Rust result", () => {
    const ci = readFileSync(
      join(root, ".github/workflows/ci-prerelease-checks.yml"),
      "utf8",
    );
    const gate = ci.split("  rust-check:")[1];
    expect(gate).toContain(
      "needs: [changes, rust, android-native, apple-native]",
    );
    expect(gate).toContain('[ "$android" != "success" ]');
    expect(gate).toContain('[ "$apple" != "success" ]');
    expect(ci).toContain("bash scripts/test/mobile-android.sh");
    expect(ci).toContain("bash scripts/test/mobile-apple.sh ios");
  });
});
