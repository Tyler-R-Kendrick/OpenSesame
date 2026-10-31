import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  indexSnapshot,
  pushedSnapshots,
  revisionSnapshot,
  worktreeSnapshot,
} from "../lib/exposure-snapshot.mjs";

function fixture(t, objectFormat = "sha1") {
  const root = mkdtempSync(join(tmpdir(), "exposure-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args, input) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    }).trimEnd();
  git([
    "init",
    "-q",
    "--initial-branch=main",
    `--object-format=${objectFormat}`,
  ]);
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message) => {
    git(["add", "--all"]);
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Snapshot Fixture",
      "-c",
      "user.email=snapshot@example.test",
      "commit",
      "-qm",
      message,
    ]);
    return git(["rev-parse", "HEAD"]);
  };
  write("source.ts", "original");
  write("other.ts", "other");
  const original = commit("original fixture");
  return { root, git, write, commit, original };
}

const text = (snapshot, path = "source.ts") => snapshot.read(path).toString();
const zero = (object) => "0".repeat(object.length);
const tuple = (object, ref = "refs/heads/main", remote = zero(object)) =>
  `${ref} ${object} ${ref} ${remote}\n`;

test("index and working bytes are independent in both directions", (t) => {
  const f = fixture(t);
  f.write("source.ts", "staged unsafe");
  f.git(["add", "source.ts"]);
  f.write("source.ts", "unstaged safe");
  assert.equal(text(indexSnapshot(f.root)), "staged unsafe");
  assert.equal(text(worktreeSnapshot(f.root)), "unstaged safe");
  f.git(["add", "source.ts"]);
  f.write("source.ts", "unstaged unsafe");
  assert.equal(text(indexSnapshot(f.root)), "unstaged safe");
  assert.equal(text(worktreeSnapshot(f.root)), "unstaged unsafe");
});

test("index policy bytes cannot be replaced by an unstaged policy relaxation", (t) => {
  const f = fixture(t);
  f.write("policy.json", '{"allowPublic":false}');
  f.git(["add", "policy.json"]);
  f.write("policy.json", '{"allowPublic":true}');
  assert.deepEqual(JSON.parse(text(indexSnapshot(f.root), "policy.json")), {
    allowPublic: false,
  });
  assert.deepEqual(JSON.parse(text(worktreeSnapshot(f.root), "policy.json")), {
    allowPublic: true,
  });
});

test("cached reads and inventories cannot be mutated by a caller", (t) => {
  const f = fixture(t);
  const index = indexSnapshot(f.root);
  f.write("source.ts", "new staged content");
  f.git(["add", "source.ts"]);
  assert.equal(text(index), "original");
  index.read("source.ts").fill(0);
  assert.equal(text(index), "original");
  index.paths().push("injected.ts");
  assert.equal(index.paths().includes("injected.ts"), false);
  const working = worktreeSnapshot(f.root);
  assert.equal(text(working), "new staged content");
  working.read("source.ts").fill(0);
  f.write("source.ts", "subsequent edit");
  assert.equal(text(working), "new staged content");
});

test("working inventory includes nonignored new files and omits actual deletions", (t) => {
  const f = fixture(t);
  f.write(".gitignore", "ignored.ts\n");
  f.write("ignored.ts", "ignored");
  f.write("new file.ts", "new");
  f.write("π.ts", "unicode");
  f.write("\ufeffleading.ts", "leading BOM in filename");
  rmSync(join(f.root, "source.ts"));
  const working = worktreeSnapshot(f.root);
  assert.equal(working.paths().includes("source.ts"), false);
  assert.equal(working.paths().includes("ignored.ts"), false);
  assert.equal(text(working, "new file.ts"), "new");
  assert.equal(text(working, "π.ts"), "unicode");
  assert.equal(text(working, "\ufeffleading.ts"), "leading BOM in filename");
  assert.equal(text(indexSnapshot(f.root)), "original");
  f.git(["rm", "other.ts"]);
  assert.equal(indexSnapshot(f.root).paths().includes("other.ts"), false);
  assert.equal(text(revisionSnapshot(f.root, "HEAD"), "other.ts"), "other");
});

test("read and mode reject noncanonical and absent paths without fallback", (t) => {
  const f = fixture(t);
  for (const snapshot of [
    worktreeSnapshot(f.root),
    indexSnapshot(f.root),
    revisionSnapshot(f.root, "HEAD"),
  ]) {
    for (const path of [
      "",
      "../source.ts",
      "/source.ts",
      "a/../source.ts",
      "./source.ts",
      "a//x",
      "a/",
      "a\\x",
      "a\0x",
      "C:/source.ts",
      "line\nname",
    ]) {
      assert.throws(() => snapshot.read(path), /canonical/);
      assert.throws(() => snapshot.mode(path), /canonical/);
    }
    assert.throws(() => snapshot.read("missing.ts"), /Missing/);
    assert.throws(() => snapshot.mode("missing.ts"), /Missing/);
  }
});

test("index and working symlink modes cannot be masked by the other tree", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "source.ts"));
  symlinkSync("other.ts", join(f.root, "source.ts"));
  f.git(["add", "source.ts"]);
  rmSync(join(f.root, "source.ts"));
  f.write("source.ts", "safe working replacement");
  const index = indexSnapshot(f.root);
  assert.equal(index.mode("source.ts"), "120000");
  assert.throws(() => text(index), /Unsafe snapshot mode/);
  assert.equal(text(worktreeSnapshot(f.root)), "safe working replacement");
  f.git(["add", "source.ts"]);
  rmSync(join(f.root, "source.ts"));
  symlinkSync("other.ts", join(f.root, "source.ts"));
  assert.equal(text(indexSnapshot(f.root)), "safe working replacement");
  const working = worktreeSnapshot(f.root);
  assert.equal(working.mode("source.ts"), "120000");
  assert.throws(() => text(working), /Unsafe snapshot mode/);
});

test("symlink parents are visible but refused before any external file read", (t) => {
  const f = fixture(t);
  f.write("nested/source.ts", "staged source");
  f.git(["add", "nested/source.ts"]);
  rmSync(join(f.root, "nested"), { recursive: true });
  const external = mkdtempSync(join(tmpdir(), "exposure-outside-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(join(external, "source.ts"), "outside sentinel");
  symlinkSync(external, join(f.root, "nested"));
  const working = worktreeSnapshot(f.root);
  assert.equal(working.paths().includes("nested/source.ts"), true);
  assert.throws(
    () => working.mode("nested/source.ts"),
    /Unsafe snapshot parent/,
  );
  assert.throws(
    () => working.read("nested/source.ts"),
    /Unsafe snapshot parent/,
  );
  assert.equal(
    text(indexSnapshot(f.root), "nested/source.ts"),
    "staged source",
  );
  assert.equal(
    readFileSync(join(external, "source.ts"), "utf8"),
    "outside sentinel",
  );
});

test("a file changed before its lazy read fails instead of reading replacement bytes", (t) => {
  const f = fixture(t);
  const working = worktreeSnapshot(f.root);
  assert.equal(working.mode("source.ts"), "100644");
  rmSync(join(f.root, "source.ts"));
  symlinkSync("other.ts", join(f.root, "source.ts"));
  assert.throws(() => text(working), /changed/);
});

test("executable modes are retained and directories cannot be read as source", (t) => {
  const f = fixture(t);
  chmodSync(join(f.root, "source.ts"), 0o755);
  f.git(["add", "source.ts"]);
  assert.equal(indexSnapshot(f.root).mode("source.ts"), "100755");
  assert.equal(worktreeSnapshot(f.root).mode("source.ts"), "100755");
  rmSync(join(f.root, "source.ts"));
  mkdirSync(join(f.root, "source.ts"));
  const working = worktreeSnapshot(f.root);
  assert.equal(working.mode("source.ts"), "040000");
  assert.throws(() => text(working), /Unsafe snapshot mode/);
});

test("unresolved index stages remain inventoried and cannot yield source bytes", (t) => {
  const f = fixture(t);
  const object = f.git(["rev-parse", "HEAD:source.ts"]);
  f.git(["update-index", "--force-remove", "source.ts"]);
  f.git(
    ["update-index", "--index-info"],
    `100644 ${object} 1\tsource.ts\n100644 ${object} 2\tsource.ts\n100644 ${object} 3\tsource.ts\n`,
  );
  const index = indexSnapshot(f.root);
  assert.equal(index.paths().filter((path) => path === "source.ts").length, 1);
  assert.throws(() => index.mode("source.ts"), /Unresolved/);
  assert.throws(() => text(index), /Unresolved/);
  assert.equal(text(index, "other.ts"), "other");
});

test("gitlinks and committed symlinks cannot be read as blobs", (t) => {
  const f = fixture(t);
  f.git([
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${f.original},linked-module`,
  ]);
  const index = indexSnapshot(f.root);
  assert.equal(index.mode("linked-module"), "160000");
  assert.throws(() => index.read("linked-module"), /Unsafe snapshot mode/);
  symlinkSync("source.ts", join(f.root, "linked-source"));
  f.git(["add", "linked-source"]);
  f.git([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "unsafe modes",
  ]);
  const committed = revisionSnapshot(f.root, "HEAD");
  assert.equal(committed.mode("linked-module"), "160000");
  assert.equal(committed.mode("linked-source"), "120000");
  assert.throws(() => committed.read("linked-module"), /Unsafe snapshot mode/);
  assert.throws(() => committed.read("linked-source"), /Unsafe snapshot mode/);
});

test("revision snapshots peel annotated tags and stay pinned when HEAD moves", (t) => {
  const f = fixture(t);
  f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "tag.gpgsign=false",
    "tag",
    "-a",
    "v1",
    "-m",
    "fixture tag",
  ]);
  const old = revisionSnapshot(f.root, "v1");
  f.write("source.ts", "new head");
  const latest = f.commit("new head");
  assert.equal(text(old), "original");
  assert.equal(text(revisionSnapshot(f.root, "HEAD")), "new head");
  assert.equal(old.label, `commit:${f.original}`);
  assert.equal(revisionSnapshot(f.root, latest).label, `commit:${latest}`);
  f.git(["replace", f.original, latest]);
  assert.equal(text(revisionSnapshot(f.root, f.original)), "original");
  for (const ref of ["--help", "missing-revision", "HEAD\n", ""]) {
    assert.throws(() => revisionSnapshot(f.root, ref));
  }
});

test("native push tuples check actual other refs, deduplicate tag targets, and skip deletions", (t) => {
  const f = fixture(t);
  f.git(["branch", "other", f.original]);
  f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "tag.gpgsign=false",
    "tag",
    "-a",
    "v1",
    "-m",
    "fixture tag",
  ]);
  const tag = f.git(["rev-parse", "v1"]);
  f.write("source.ts", "different current head");
  const head = f.commit("new head");
  const older = pushedSnapshots(f.root, tuple(f.original, "refs/heads/other"));
  assert.equal(text(older[0]), "original");
  const pushed = pushedSnapshots(
    f.root,
    Buffer.from(
      tuple(f.original, "refs/heads/other") +
        tuple(tag, "refs/tags/v1") +
        tuple(head) +
        tuple(zero(head), "(delete)", head),
    ),
  );
  assert.equal(pushed.length, 2);
  assert.deepEqual(pushed.map((entry) => text(entry)).sort(), [
    "different current head",
    "original",
  ]);
  assert.deepEqual(
    pushedSnapshots(f.root, tuple(zero(head), "(delete)", head)),
    [],
  );
  assert.equal(text(pushedSnapshots(f.root, "")[0]), "different current head");
});

test("malformed and unresolvable push input fails closed", (t) => {
  const f = fixture(t);
  for (const input of [
    "refs/heads/main invalid refs/heads/main invalid\n",
    `refs/heads/main ${f.original} refs/heads/main\n`,
    `refs/heads/main ${f.original} refs/heads/main ${zero(f.original)} extra\n`,
    tuple(f.original).replace(" ", "  "),
    tuple(f.original).replace("refs/heads/main", "refs/heads/ma\0in"),
    `${tuple(f.original)}\n${tuple(f.original)}`,
    tuple("f".repeat(40)),
    tuple(f.original, "refs/heads/main", "0".repeat(64)),
  ])
    assert.throws(() => pushedSnapshots(f.root, input));
  assert.throws(() => pushedSnapshots(f.root, 42));
  assert.throws(() => pushedSnapshots(f.root, Buffer.from([0xff])));
});

test("SHA-256 repositories retain full object IDs", (t) => {
  const f = fixture(t, "sha256");
  assert.equal(f.original.length, 64);
  assert.equal(text(indexSnapshot(f.root)), "original");
  assert.equal(text(revisionSnapshot(f.root, "HEAD")), "original");
  assert.equal(text(pushedSnapshots(f.root, tuple(f.original))[0]), "original");
});

test("working source reads are bounded before allocating oversized file contents", (t) => {
  const f = fixture(t);
  truncateSync(join(f.root, "source.ts"), 64 * 1024 * 1024 + 1);
  assert.throws(() => text(worktreeSnapshot(f.root)), /size|large|limit/i);
});
