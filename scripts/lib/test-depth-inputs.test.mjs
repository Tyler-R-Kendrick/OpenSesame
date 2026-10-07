import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertSameInputs, sourceInputs } from "./test-depth-inputs.mjs";

const command = fileURLToPath(
  new URL("./test-depth-inputs.mjs", import.meta.url),
);

function check(root, destination) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "process.umask(0o022); await import(process.argv[1]);",
      command,
      "check",
      destination,
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

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

describe("actual freshness command preserves private drift metadata", () => {
  it("keeps unchanged admission and retains the actual after inventory", () => {
    const root = repository();
    const reports = mkdtempSync(join(tmpdir(), "os-depth-input-reports-"));
    const destination = join(reports, "inputs.before.json");
    execFileSync(process.execPath, [command, "capture", destination], {
      cwd: root,
    });
    const result = check(root, destination);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All 4 tracked inputs unchanged.");
    const after = join(reports, "inputs.after.json");
    expect(JSON.parse(readFileSync(after, "utf8"))).toEqual(
      JSON.parse(readFileSync(destination, "utf8")),
    );
    expect(
      JSON.parse(
        readFileSync(join(reports, "inputs.changed-paths.json"), "utf8"),
      ),
    ).toEqual([]);
    expect(statSync(after).mode & 0o777).toBe(0o600);
    expect(
      statSync(join(reports, "inputs.changed-paths.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("fails nonzero on a real source mutation while retaining both hashes and its path", () => {
    const root = repository();
    const reports = mkdtempSync(join(tmpdir(), "os-depth-input-reports-"));
    const destination = join(reports, "inputs.before.json");
    execFileSync(process.execPath, [command, "capture", destination], {
      cwd: root,
    });
    const beforeRaw = readFileSync(destination, "utf8");
    writeFileSync(join(root, "src/code.txt"), "changed-public-code");
    const result = check(root, destination);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Test-depth tracked inputs changed during execution",
    );
    expect(readFileSync(destination, "utf8")).toBe(beforeRaw);
    const before = JSON.parse(beforeRaw);
    const afterRaw = readFileSync(join(reports, "inputs.after.json"), "utf8");
    const after = JSON.parse(afterRaw);
    const prior = before.find((input) => input.path === "src/code.txt");
    const changed = after.find((input) => input.path === "src/code.txt");
    expect(changed.sha256).toBe(
      createHash("sha256").update("changed-public-code").digest("hex"),
    );
    expect(changed.sha256).not.toBe(prior.sha256);
    expect(
      JSON.parse(
        readFileSync(join(reports, "inputs.changed-paths.json"), "utf8"),
      ),
    ).toEqual(["src/code.txt"]);
    expect(afterRaw).not.toContain("changed-public-code");
    expect(afterRaw).not.toContain("public-code");
  });
});
