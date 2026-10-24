// scripts/release/tag-check.sh (ADR 0212): what a release tag has to be before
// anything is built for it, run against throwaway repositories with real
// annotated and lightweight tags.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const script = join(root, "scripts/release/tag-check.sh");

// No global git configuration: a signing key or hook of the developer's must
// not reach a throwaway repository.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

const work = mkdtempSync(join(tmpdir(), "tag-check-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

const CARGO = (version) => `[package]
name = "decoy"
version = "9.9.9"

[workspace.package]
version   =   "${version}"
edition = "2021"

[workspace.dependencies]
version = "8.8.8"
`;

let repoCount = 0;
/** A repository whose main holds a commit that sets the workspace version. */
function repo(version = "0.1.0") {
  const dir = join(work, `repo-${repoCount++}`);
  execFileSync("mkdir", [dir]);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "Cargo.toml"), CARGO(version));
  git(dir, "add", "Cargo.toml");
  git(dir, "commit", "-q", "-m", "release commit");
  return { dir, commit: git(dir, "rev-parse", "HEAD") };
}

const run = (dir, ...args) =>
  spawnSync("bash", [script, ...args], {
    cwd: dir,
    env: gitEnv,
    encoding: "utf8",
  });

// The structural gate counts each describe callback as one function of at most
// 100 lines, so the suite is several describes of the same name.
describe("tag-check.sh", () => {
  it("is executable, as the workflow calls it", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  it("peels an annotated tag object to the commit it names", () => {
    const { dir, commit } = repo();
    git(dir, "tag", "-a", "v0.1.0", "-m", "the release");
    const tagObject = git(dir, "rev-parse", "v0.1.0");
    // The premise: what GITHUB_SHA can be on an annotated tag is not the commit.
    expect(tagObject).not.toBe(commit);
    expect(git(dir, "cat-file", "-t", tagObject)).toBe("tag");
    const peeled = run(dir, "commit", tagObject);
    expect(peeled.status).toBe(0);
    expect(peeled.stdout.trim()).toBe(commit);
    // A lightweight tag, or the commit itself, is already the commit.
    expect(run(dir, "commit", commit).stdout.trim()).toBe(commit);
  });

  it("verifies a tag on main for either kind of tag, given the tag object or the commit", () => {
    const { dir, commit } = repo();
    git(dir, "tag", "-a", "v0.1.0", "-m", "the release");
    git(dir, "tag", "v0.1.0-rc1");
    const tagObject = git(dir, "rev-parse", "v0.1.0");
    for (const [tag, sha] of [
      ["v0.1.0", tagObject],
      ["v0.1.0", commit],
      ["v0.1.0-rc1", commit],
    ]) {
      const out = run(dir, "verify", tag, sha, "refs/heads/main");
      expect({ tag, sha, status: out.status, err: out.stderr }).toEqual({
        tag,
        sha,
        status: 0,
        err: "",
      });
      expect(out.stdout.trim()).toBe(commit);
    }
  });
});

describe("tag-check.sh", () => {
  it("stops a tag on a commit main does not hold, naming both", () => {
    const { dir } = repo();
    git(dir, "checkout", "-q", "-b", "topic");
    writeFileSync(join(dir, "other.txt"), "x");
    git(dir, "add", "other.txt");
    git(dir, "commit", "-q", "-m", "off main");
    const off = git(dir, "rev-parse", "HEAD");
    git(dir, "tag", "-a", "v0.1.0", "-m", "x");
    const out = run(
      dir,
      "verify",
      "v0.1.0",
      git(dir, "rev-parse", "v0.1.0"),
      "refs/heads/main",
    );
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(
      `points at ${off}, which is not on refs/heads/main`,
    );
    expect(out.stdout).toBe("");
  });

  it("is not fooled by a tag named like the remote branch it compares with", () => {
    const { dir, commit } = repo();
    git(dir, "update-ref", "refs/remotes/origin/main", commit);
    git(dir, "checkout", "-q", "-b", "topic");
    writeFileSync(join(dir, "other.txt"), "x");
    git(dir, "add", "other.txt");
    git(dir, "commit", "-q", "-m", "off main");
    const off = git(dir, "rev-parse", "HEAD");
    // A bare `origin/main` resolves to a tag of that name before the
    // remote-tracking branch, and the tag job fetches every tag.
    git(dir, "tag", "origin/main", off);
    git(dir, "tag", "v0.1.0", off);
    const out = run(dir, "verify", "v0.1.0", off);
    expect({ status: out.status, out: out.stdout }).toEqual({
      status: 2,
      out: "",
    });
    expect(out.stderr).toContain(`points at ${off}, which is not on`);
    // And the commit that is on main still passes, with the same tag planted.
    git(dir, "checkout", "-q", commit);
    expect(run(dir, "verify", "v0.1.0", commit).status).toBe(0);
  });

  it("holds the tag to the workspace version, and nothing under another table", () => {
    const { dir, commit } = repo("0.4.2");
    for (const tag of ["v0.1.0", "v9.9.9", "v8.8.8", "v0.4.20", "v0.4"]) {
      const out = run(dir, "verify", tag, commit, "refs/heads/main");
      expect(out.status, tag).toBe(2);
      expect(out.stderr, tag).toContain("is not version 0.4.2");
    }
    for (const tag of ["v0.4.2", "v0.4.2-rc.1", "v0.4.2-dryrun"]) {
      expect(
        run(dir, "verify", tag, commit, "refs/heads/main").status,
        tag,
      ).toBe(0);
    }
  });

  it("insists the checkout is the commit it verified", () => {
    const { dir, commit } = repo();
    writeFileSync(join(dir, "later.txt"), "x");
    git(dir, "add", "later.txt");
    git(dir, "commit", "-q", "-m", "a later commit on main");
    const out = run(dir, "verify", "v0.1.0", commit, "refs/heads/main");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(`not ${commit}`);
  });
});

describe("tag-check.sh", () => {
  it("refuses what is not a tag name, a commit, or a main to compare with", () => {
    const { dir, commit } = repo();
    for (const tag of ["0.1.0", "v0.1.0;id", "v", "../v0.1.0"]) {
      expect(
        run(dir, "verify", tag, commit, "refs/heads/main").status,
        tag,
      ).toBe(2);
    }
    expect(run(dir, "commit", "not-a-sha").status).toBe(2);
    expect(
      run(dir, "verify", "v0.1.0", "0".repeat(40), "refs/heads/main").status,
    ).toBe(2);
    const noMain = run(dir, "verify", "v0.1.0", commit);
    expect(noMain.status).toBe(2);
    expect(noMain.stderr).toContain(
      "no refs/remotes/origin/main to compare with",
    );
    // A bare name is never looked up, and neither is a short object name.
    for (const bare of ["main", "origin/main", "heads/main"]) {
      const out = run(dir, "verify", "v0.1.0", commit, bare);
      expect(out.status, bare).toBe(2);
      expect(out.stderr, bare).toContain("is not a full ref name");
    }
    expect(
      run(dir, "verify", "v0.1.0", commit.slice(0, 12), "HEAD").status,
    ).toBe(2);
    expect(run(dir, "commit", "v0.1.0").status).toBe(2);
    expect(run(dir).status).toBe(2);
  });

  it("reads this repository's own workspace version", () => {
    const toml = readFileSync(join(root, "Cargo.toml"), "utf8");
    const version =
      /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(toml)?.[1];
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    const head = git(root, "rev-parse", "HEAD");
    const out = run(root, "verify", `v${version}`, head, "HEAD");
    expect({ status: out.status, err: out.stderr }).toEqual({
      status: 0,
      err: "",
    });
    expect(out.stdout.trim()).toBe(head);
  });
});
