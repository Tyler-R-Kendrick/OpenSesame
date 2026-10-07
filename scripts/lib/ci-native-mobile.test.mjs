import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const gate = ci.split("  rust-check:")[1];
    expect(gate).toContain(
      "needs: [changes, rust, native, android-native, apple-native]",
    );
    expect(gate).toContain('case "$mobile_expected:$android:$apple" in');
    expect(gate).toContain("true:success:success|false:skipped:skipped)");
    expect(ci).toContain("bash scripts/test/mobile-android.sh");
    expect(ci).toContain("bash scripts/test/mobile-apple.sh ios");
  });
});

function collectMobile(expected, android, apple) {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const script = ci
    .split("  rust-check:")[1]
    .split("        run: |\n")[1]
    .replace(/^ {10}/gm, "")
    .replaceAll("${{ needs.changes.result }}", "success")
    .replaceAll("${{ needs.rust.result }}", "success")
    .replaceAll("${{ needs.changes.outputs.native }}", "false")
    .replaceAll("${{ needs.native.result }}", "skipped")
    .replaceAll("${{ needs.changes.outputs.native_mobile }}", expected)
    .replaceAll("${{ needs.android-native.result }}", android)
    .replaceAll("${{ needs.apple-native.result }}", apple);
  return spawnSync("bash", ["-c", script], { stdio: "ignore" }).status;
}

describe("native mobile collector executes fail closed", () => {
  it.each(["failure", "skipped", "cancelled", "", "unknown"])(
    "rejects an affected mobile family result %s",
    (result) => {
      expect(collectMobile("true", result, "success")).toBe(1);
      expect(collectMobile("true", "success", result)).toBe(1);
    },
  );
  it("accepts only successful required families or proven unaffected skips", () => {
    expect(collectMobile("true", "success", "success")).toBe(0);
    expect(collectMobile("false", "skipped", "skipped")).toBe(0);
    expect(collectMobile("false", "failure", "skipped")).toBe(1);
    expect(collectMobile("", "success", "success")).toBe(1);
  });
});
