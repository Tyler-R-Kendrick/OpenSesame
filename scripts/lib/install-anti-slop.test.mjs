import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  asset,
  cleanup,
  fresh,
  install,
  installer,
  run,
  tree,
} from "./install-anti-slop-harness.mjs";

// Each case spawns Node a few times; a loaded CI runner needs more than 5 s.
vi.setConfig({ testTimeout: 30_000 });
afterAll(cleanup);

describe("the installer", () => {
  it("copies the asset, tests included, and prints exactly what it printed before", () => {
    const { status, stdout, target } = install();
    expect(status).toBe(0);
    expect(stdout).toBe(
      `Copied the anti-slop plugin to ${target}\nConfigure Oxlint with: ${target}/index.ts\n`,
    );
    expect(tree(target)).toEqual(tree(asset));
    expect(tree(target)).toContain("rules/no-reflect-get.test.ts");
    expect(readFileSync(join(target, "verify.mjs"), "utf8")).toBe(
      readFileSync(join(asset, "verify.mjs"), "utf8"),
    );
  });

  it("leaves out every test file under --no-tests, and says so", () => {
    const tests = tree(asset).filter((file) => file.endsWith(".test.ts"));
    expect(tests.length).toBeGreaterThan(10);
    const { status, stdout, target } = install(["--no-tests"]);
    expect(status).toBe(0);
    expect(stdout).toContain(`Copied the anti-slop plugin to ${target}`);
    expect(stdout).toContain(
      `Left out ${tests.length} test files (--no-tests).`,
    );
    expect(stdout).toContain(`node ${target}/verify.mjs --no-tests`);
    expect(tree(target)).toEqual(
      tree(asset).filter((file) => !tests.includes(file)),
    );
    expect(tree(target)).toContain("verify.mjs");
    expect(tree(target)).toContain("MANIFEST.sha256");
  });

  it("still refuses to replace an existing destination", () => {
    const first = install();
    const again = run(installer, ["plugin"], first.cwd);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("Refusing to overwrite");
  });
});

describe("the installer refuses what it does not understand", () => {
  const accepted = "the accepted options are --force and --no-tests.";

  it.each([
    [["plugin", "--no-test"], `Unknown option "--no-test"; ${accepted}\n`],
    [
      ["--no-tests=1", "plugin"],
      `Unknown option "--no-tests=1"; ${accepted}\n`,
    ],
    [["-f", "plugin"], `Unknown option "-f"; ${accepted}\n`],
    [["--help"], `Unknown option "--help"; ${accepted}\n`],
    [
      ["one", "two"],
      'Unexpected extra argument "two"; install.mjs takes at most one destination.\n',
    ],
    [
      [""],
      "The destination is an empty string; pass a path or leave it out.\n",
    ],
  ])("%j exits 2 with one sentence and installs nothing", (args, message) => {
    const cwd = fresh("repo");
    const result = run(installer, args, cwd);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(message);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("names the first offending argument when there are several", () => {
    const result = run(
      installer,
      ["--nope", "--nada", "a", "b"],
      fresh("repo"),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(`Unknown option "--nope"; ${accepted}\n`);
  });

  it("still takes its options before or after the destination, and defaults the destination", () => {
    const cwd = fresh("repo");
    expect(run(installer, ["--no-tests", "--force", "a"], cwd).status).toBe(0);
    expect(run(installer, ["b", "--no-tests"], cwd).status).toBe(0);
    expect(tree(join(cwd, "a"))).toEqual(tree(join(cwd, "b")));
    const bare = run(installer, [], cwd);
    const target = join(cwd, "tools", "oxlint", "anti-slop");
    expect(bare.status).toBe(0);
    expect(bare.stdout).toBe(
      `Copied the anti-slop plugin to ${target}\nConfigure Oxlint with: ${target}/index.ts\n`,
    );
  });
});
