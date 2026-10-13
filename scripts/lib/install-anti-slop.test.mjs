import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skill = join(root, "skills", "install-anti-slop");
const asset = join(skill, "assets", "anti-slop");
const installer = join(skill, "scripts", "install.mjs");
const generator = join(skill, "scripts", "manifest.mjs");

// Each case spawns Node a few times; a loaded CI runner needs more than 5 s.
vi.setConfig({ testTimeout: 30_000 });

const scratch = mkdtempSync(join(tmpdir(), "install-anti-slop-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function fresh(label) {
  counter += 1;
  const dir = join(scratch, `${label}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Every file under `dir`, as sorted posix paths. */
function tree(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? tree(dir, `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

function install(args = []) {
  const cwd = fresh("repo");
  const result = run(installer, ["plugin", ...args], cwd);
  return { ...result, cwd, target: join(cwd, "plugin") };
}

const verify = (target, args = []) =>
  run(join(target, "verify.mjs"), args, target);

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

describe("verify.mjs on an install", () => {
  it("accepts a default install", () => {
    const { target } = install();
    const result = verify(target);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^anti-slop: \d+ files match MANIFEST\.sha256\.\n$/u,
    );
    expect(result.stderr).toBe("");
  });

  it("accepts a --no-tests install under --no-tests, and the same install without it names the missing tests", () => {
    const { target } = install(["--no-tests"]);
    const accepted = verify(target, ["--no-tests"]);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toMatch(
      /test files not expected under --no-tests/u,
    );

    const refused = verify(target);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      "Missing file: rules/no-reflect-get.test.ts is listed in MANIFEST.sha256 but is not installed.",
    );
    expect(refused.stderr).toContain("node verify.mjs --no-tests");
  });

  it("names a file with one changed byte", () => {
    const { target } = install();
    const file = join(target, "rules", "no-reflect-get.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")} `);
    const result = verify(target);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Modified file: rules/no-reflect-get.ts does not match the digest in MANIFEST.sha256.\n",
    );
    expect(result.stdout).toBe("");
  });

  it("names a deleted file", () => {
    const { target } = install();
    unlinkSync(join(target, "shared", "dictionary-types.ts"));
    const result = verify(target);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Missing file: shared/dictionary-types.ts is listed in MANIFEST.sha256 but is not installed.\n",
    );
  });

  it("names an added file", () => {
    const { target } = install();
    writeFileSync(join(target, "rules", "added.ts"), "export {};\n");
    const result = verify(target);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Extra file: rules/added.ts is installed but is not listed in MANIFEST.sha256.\n",
    );
  });

  it("reports every problem, one sentence each", () => {
    const { target } = install();
    unlinkSync(join(target, "index.ts"));
    writeFileSync(join(target, "extra.ts"), "export {};\n");
    writeFileSync(join(target, "shared", "reflect-method.ts"), "export {};\n");
    const lines = verify(target).stderr.trimEnd().split("\n");
    expect(lines).toEqual([
      "Missing file: index.ts is listed in MANIFEST.sha256 but is not installed.",
      "Modified file: shared/reflect-method.ts does not match the digest in MANIFEST.sha256.",
      "Extra file: extra.ts is installed but is not listed in MANIFEST.sha256.",
    ]);
  });
});

describe("verify.mjs on a profile, a manifest or an argument it cannot use", () => {
  it("treats a test file in a --no-tests install as extra", () => {
    const { target } = install(["--no-tests"]);
    cpSync(
      join(asset, "rules", "no-reflect-get.test.ts"),
      join(target, "rules", "no-reflect-get.test.ts"),
    );
    const result = verify(target, ["--no-tests"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "Extra file: rules/no-reflect-get.test.ts is a test file, which an install with --no-tests does not contain.\n",
    );
  });

  it("fails when the manifest is missing", () => {
    const { target } = install();
    unlinkSync(join(target, "MANIFEST.sha256"));
    const result = verify(target);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "MANIFEST.sha256 is missing, so nothing can be verified.\n",
    );
  });

  it("rejects a manifest that is malformed or reaches outside the directory", () => {
    const { target } = install();
    const digest = "0".repeat(64);
    writeFileSync(
      join(target, "MANIFEST.sha256"),
      [
        "not a line",
        `${digest}  ../outside.ts`,
        `${digest}  index.ts`,
        `${digest}  index.ts`,
        `${digest}  MANIFEST.sha256`,
        "",
      ].join("\n"),
    );
    const lines = verify(target).stderr.split("\n");
    expect(lines).toContain(
      'MANIFEST.sha256 line 1 is not "<sha256>  <path>".',
    );
    expect(lines).toContain(
      "MANIFEST.sha256 line 2 names ../outside.ts, which is not a path inside the plugin directory.",
    );
    expect(lines).toContain(
      "MANIFEST.sha256 line 4 lists index.ts a second time.",
    );
    expect(lines).toContain("MANIFEST.sha256 line 5 lists itself.");
  });

  it("rejects an unknown argument with a usage line", () => {
    const { target } = install();
    const result = verify(target, ["--nope"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("Usage: node verify.mjs [--no-tests]\n");
  });
});

describe("MANIFEST.sha256", () => {
  it("is one sorted `<sha256>  <path>` line per shipped file, LF only, none for itself", () => {
    const lines = readFileSync(join(asset, "MANIFEST.sha256"), "utf8");
    expect(lines.endsWith("\n")).toBe(true);
    expect(lines).not.toContain("\r");
    const rows = lines.slice(0, -1).split("\n");
    for (const row of rows)
      expect(row).toMatch(/^[0-9a-f]{64} {2}[A-Za-z0-9._/-]+$/u);
    const paths = rows.map((row) => row.slice(66));
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : 1)));
    expect(paths).toEqual(
      tree(asset).filter((path) => path !== "MANIFEST.sha256"),
    );
    expect(paths).toContain("verify.mjs");
  });

  it("is current, and the generator says how to fix a stale one", () => {
    const current = run(generator, ["--check"], root);
    expect(current.status).toBe(0);
    expect(current.stdout).toMatch(
      /^MANIFEST\.sha256 is current \(\d+ files\)\.\n$/u,
    );

    const copy = fresh("stale");
    cpSync(asset, copy, { recursive: true });
    const rule = join(copy, "rules", "no-widen-then-assert.ts");
    writeFileSync(rule, `${readFileSync(rule, "utf8")}\n`);
    const stale = run(generator, ["--check", "--dir", copy], root);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("MANIFEST.sha256 is stale");
    expect(stale.stderr).toContain('Run "pnpm anti-slop:manifest"');
    expect(stale.stderr).toContain(
      "Modified file: rules/no-widen-then-assert.ts",
    );

    const written = run(generator, ["--dir", copy], root);
    expect(written.status).toBe(0);
    expect(run(generator, ["--check", "--dir", copy], root).status).toBe(0);
  });
});

describe("a skill that ships test-only fixtures", () => {
  it("leaves them out under --no-tests and still verifies both profiles", () => {
    const skillCopy = fresh("skill");
    cpSync(join(skill, "scripts"), join(skillCopy, "scripts"), {
      recursive: true,
    });
    cpSync(asset, join(skillCopy, "assets", "anti-slop"), { recursive: true });
    const shipped = join(skillCopy, "assets", "anti-slop");
    mkdirSync(join(shipped, "fixtures"));
    writeFileSync(join(shipped, "fixtures", "case.json"), "{}\n");
    writeFileSync(join(shipped, "rules", "extra.spec.ts"), "export {};\n");
    const copied = join(skillCopy, "scripts", "manifest.mjs");
    expect(run(copied, [], skillCopy).status).toBe(0);

    const cwd = fresh("repo");
    const full = run(join(skillCopy, "scripts", "install.mjs"), ["full"], cwd);
    expect(full.status).toBe(0);
    expect(tree(join(cwd, "full"))).toContain("fixtures/case.json");
    expect(verify(join(cwd, "full")).status).toBe(0);

    const lean = run(
      join(skillCopy, "scripts", "install.mjs"),
      ["lean", "--no-tests"],
      cwd,
    );
    expect(lean.status).toBe(0);
    const files = tree(join(cwd, "lean"));
    expect(
      files.filter((file) => /fixtures|\.spec\.|\.test\./u.test(file)),
    ).toEqual([]);
    expect(verify(join(cwd, "lean"), ["--no-tests"]).status).toBe(0);
  });
});
