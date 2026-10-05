import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMutation, planStack, splitMessage } from "./signed-replay.mjs";

const CLI = join(import.meta.dirname, "../release/land-signed-stack.mjs");
const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x01]);
let dir;
let stubDir;

const run = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const runner = (args, { binary = false } = {}) =>
  execFileSync("git", args, {
    cwd: dir,
    encoding: binary ? "buffer" : "utf8",
  });
const write = (path, data) => writeFileSync(join(dir, path), data);
function commit(message) {
  run(["add", "-A"]);
  run(["commit", "-q", "-m", message]);
}
const planWith = (base, branches) => planStack({ base, branches, git: runner });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "signed-replay-"));
  stubDir = mkdtempSync(join(tmpdir(), "signed-replay-gh-"));
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", "t@example.test"]);
  run(["config", "commit.gpgsign", "false"]);
  write("keep.txt", "one\n");
  write("gone.txt", "bye\n");
  write("run.sh", "#!/bin/sh\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  commit("base");

  run(["checkout", "-q", "-b", "one"]);
  write("keep.txt", "one\ntwo\n");
  write("new.txt", "fresh\n");
  commit("Modify and add\n\nBody line one.\nBody line two.\n");
  unlinkSync(join(dir, "gone.txt"));
  commit("Delete a file");

  run(["checkout", "-q", "-b", "two"]);
  write("blob.bin", BINARY);
  mkdirSync(join(dir, "sub dir"));
  write("sub dir/é.txt", "unicode path\n");
  commit("Add binary");

  run(["checkout", "-q", "-b", "bad-symlink", "two"]);
  symlinkSync("keep.txt", join(dir, "link"));
  commit("Add symlink");
  run(["checkout", "-q", "-b", "bad-exec", "two"]);
  chmodSync(join(dir, "keep.txt"), 0o755);
  commit("Make executable");
  run(["checkout", "-q", "-b", "bad-new-exec", "two"]);
  write("tool.sh", "#!/bin/sh\n");
  chmodSync(join(dir, "tool.sh"), 0o755);
  commit("Add executable");
  run(["checkout", "-q", "-b", "side", "main"]);
  write("side.txt", "side\n");
  commit("Side");
  run(["checkout", "-q", "-b", "bad-merge", "two"]);
  run(["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
  run(["checkout", "-q", "two"]);

  writeFileSync(
    join(stubDir, "gh"),
    `#!/bin/sh\necho called >> "${join(stubDir, "gh-called")}"\nexit 97\n`,
  );
  chmodSync(join(stubDir, "gh"), 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

describe("splitMessage", () => {
  it("splits headline from body", () => {
    expect(splitMessage("Head\n\nBody one.\nBody two.\n")).toEqual({
      headline: "Head",
      body: "Body one.\nBody two.",
    });
    expect(splitMessage("Only\n")).toEqual({ headline: "Only", body: "" });
  });
});

describe("planStack", () => {
  it("plans each branch on the previous one", () => {
    const plan = planWith("main", ["one", "two"]);
    expect(plan.map((p) => [p.branch, p.base, p.commits.length])).toEqual([
      ["one", "main", 2],
      ["two", "one", 1],
    ]);
    const [first, second] = plan[0].commits;
    expect(first.headline).toBe("Modify and add");
    expect(first.body).toBe("Body line one.\nBody line two.");
    expect(first.parent).toBe(run(["rev-parse", "main"]).trim());
    expect(first.additions).toEqual([
      {
        path: "keep.txt",
        contents: Buffer.from("one\ntwo\n").toString("base64"),
      },
      { path: "new.txt", contents: Buffer.from("fresh\n").toString("base64") },
    ]);
    expect(first.deletions).toEqual([]);
    expect(second.headline).toBe("Delete a file");
    expect(second.body).toBe("");
    expect(second.additions).toEqual([]);
    expect(second.deletions).toEqual([{ path: "gone.txt" }]);
  });

  it("round-trips binary contents byte for byte", () => {
    const [change] = planWith("one", ["two"])[0].commits;
    const blob = change.additions.find((a) => a.path === "blob.bin");
    expect(Buffer.from(blob.contents, "base64").equals(BINARY)).toBe(true);
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(BINARY),
    ).toThrow();
    const unicode = change.additions.find((a) => a.path.endsWith("é.txt"));
    expect(unicode.path).toBe("sub dir/é.txt");
  });

  it.each([
    ["bad-symlink", /symlink \(mode 120000\)/],
    ["bad-exec", /keep\.txt changes mode 100644 -> 100755/],
    ["bad-new-exec", /tool\.sh is added with the executable bit/],
    ["bad-merge", /merge commit/],
  ])("refuses %s", (branch, message) => {
    expect(() => planWith("two", [branch])).toThrow(message);
  });

  it("refuses a submodule entry", () => {
    const fake = (args, opts) =>
      args[0] === "diff-tree"
        ? `:000000 160000 ${"0".repeat(40)} ${"1".repeat(40)} A\0vendor\0`
        : runner(args, opts);
    expect(() =>
      planStack({ base: "main", branches: ["one"], git: fake }),
    ).toThrow(/vendor is a submodule \(mode 160000\)/);
  });
});

describe("buildMutation", () => {
  it("builds the createCommitOnBranch request", () => {
    const [change] = planWith("one", ["two"])[0].commits;
    const request = buildMutation({
      repo: "owner/repo",
      branch: "two-signed",
      expectedHeadOid: "a".repeat(40),
      change: { ...change, additions: change.additions.slice(0, 1) },
    });
    expect(request.query).toContain("createCommitOnBranch(input: $input)");
    expect(request.variables).toEqual({
      input: {
        branch: {
          repositoryNameWithOwner: "owner/repo",
          branchName: "two-signed",
        },
        message: { headline: "Add binary", body: "" },
        fileChanges: {
          additions: [
            { path: "blob.bin", contents: BINARY.toString("base64") },
          ],
          deletions: [],
        },
        expectedHeadOid: "a".repeat(40),
      },
    });
  });
});

describe("land-signed-stack dry run", () => {
  it("prints the plan and never calls gh", () => {
    const result = spawnSync(
      process.execPath,
      [CLI, "--repo", "owner/repo", "--base", "main", "--branches", "one,two"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("one (on main): 2 commits, 3 file changes");
    expect(result.stdout).toContain("two (on one): 1 commits, 2 file changes");
    expect(result.stdout).toContain("Dry run: nothing was sent");
    expect(() => readFileSync(join(stubDir, "gh-called"))).toThrow();
  });

  it("fails on a refused stack without calling gh", () => {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "--repo",
        "owner/repo",
        "--base",
        "two",
        "--branches",
        "bad-merge",
        "--apply",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/merge commit/);
    expect(() => readFileSync(join(stubDir, "gh-called"))).toThrow();
  });
});
