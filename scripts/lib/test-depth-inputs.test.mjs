import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSameInputs, sourceInputs } from "./test-depth-inputs.mjs";

function repository() {
  const root = mkdtempSync(join(tmpdir(), "os-depth-source-contract-"));
  execFileSync("git", ["init", "--quiet", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/code.txt"), "public-code");
  symlinkSync("src", join(root, "directory-link"));
  symlinkSync("src/code.txt", join(root, "file-link"));
  symlinkSync("not-present", join(root, "dangling-link"));
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

describe("tracked source captures preserve genuine Git symlinks", () => {
  it("hashes exact link text without traversing directory or dangling targets", () => {
    const captured = sourceInputs(repository());
    expect(captured.map((input) => input.path)).toEqual([
      "dangling-link",
      "directory-link",
      "file-link",
      "src/code.txt",
    ]);
    expect(captured.find((input) => input.path === "directory-link")).toEqual({
      path: "directory-link",
      kind: "symlink",
      sha256: createHash("sha256").update("src").digest("hex"),
    });
    expect(captured.find((input) => input.path === "src/code.txt")?.kind).toBe(
      "file",
    );
  });

  it("detects a changed tracked target even when all link text stays the same", () => {
    const root = repository();
    const before = sourceInputs(root);
    writeFileSync(join(root, "src/code.txt"), "changed-public-code");
    expect(() => assertSameInputs(before, sourceInputs(root))).toThrow();
  });

  it("detects a retargeted directory symlink", () => {
    const root = repository();
    const before = sourceInputs(root);
    unlinkSync(join(root, "directory-link"));
    symlinkSync("not-present", join(root, "directory-link"));
    expect(() => assertSameInputs(before, sourceInputs(root))).toThrow();
  });

  it("distinguishes raw link bytes that UTF-8 decoding would replace", () => {
    const root = repository();
    unlinkSync(join(root, "dangling-link"));
    symlinkSync(Buffer.from([255]), join(root, "dangling-link"));
    const before = sourceInputs(root);
    unlinkSync(join(root, "dangling-link"));
    symlinkSync(Buffer.from([254]), join(root, "dangling-link"));
    expect(() => assertSameInputs(before, sourceInputs(root))).toThrow();
  });

  it("detects file-to-link substitution even with an equal byte digest", () => {
    const root = repository();
    writeFileSync(join(root, "src/code.txt"), "target");
    const before = sourceInputs(root);
    unlinkSync(join(root, "src/code.txt"));
    symlinkSync("target", join(root, "src/code.txt"));
    expect(() => assertSameInputs(before, sourceInputs(root))).toThrow();
  });

  it("rejects an ordinary directory replacing a tracked file", () => {
    const root = repository();
    unlinkSync(join(root, "src/code.txt"));
    mkdirSync(join(root, "src/code.txt"));
    expect(() => sourceInputs(root)).toThrow("Unexpected tracked input type");
  });
});
