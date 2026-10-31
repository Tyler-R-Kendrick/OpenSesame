import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, prepare } from "./gitleaks-working-tree-gate.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gitleaks-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "fixtures"));
  const content = "known public fixture\n";
  writeFileSync(join(root, "fixtures", "vector.txt"), content);
  const manifest = [
    {
      path: "fixtures/vector.txt",
      rule: "private-key",
      line: 1,
      fileSha256: hash(content),
      matchSha256: hash("fixture match"),
      reason: "synthetic test",
    },
  ];
  const finding = {
    File: "fixtures/vector.txt",
    RuleID: "private-key",
    StartLine: 1,
    Match: "fixture match",
  };
  return { root, manifest, finding };
}

test("only an exact reviewed file and match can be classified", (t) => {
  const f = fixture(t);
  const before = prepare(f.root, f.manifest);
  assert.equal(
    classify(f.root, f.manifest, before, [f.finding], 1)[0].reviewed,
    true,
  );
  for (const finding of [
    { ...f.finding, Match: "new secret" },
    { ...f.finding, File: "other.txt" },
    { ...f.finding, RuleID: "github-pat" },
    { ...f.finding, StartLine: 2 },
  ])
    assert.equal(
      classify(f.root, f.manifest, before, [finding], 1)[0].reviewed,
      false,
    );
  assert.deepEqual(
    classify(f.root, f.manifest, before, [f.finding, f.finding], 1).map(
      (x) => x.reviewed,
    ),
    [true, false],
  );
  writeFileSync(join(f.root, "fixtures", "vector.txt"), "new secret\n");
  assert.throws(
    () => classify(f.root, f.manifest, before, [f.finding], 1),
    /changed during scan/,
  );
  const next = prepare(f.root, f.manifest);
  assert.equal(
    classify(f.root, f.manifest, next, [f.finding], 1)[0].reviewed,
    false,
  );
});

test("rejects scanner errors, malformed evidence, and symlinked fixtures", (t) => {
  const f = fixture(t);
  const before = prepare(f.root, f.manifest);
  assert.throws(
    () => classify(f.root, f.manifest, before, [], 2),
    /Scanner failed/,
  );
  assert.throws(
    () => classify(f.root, f.manifest, before, [f.finding], 0),
    /inconsistent/,
  );
  assert.throws(
    () => classify(f.root, f.manifest, before, [], 1),
    /inconsistent/,
  );
  assert.throws(
    () =>
      classify(f.root, f.manifest, before, [{ ...f.finding, Match: null }], 1),
    /Malformed/,
  );
  rmSync(join(f.root, "fixtures", "vector.txt"));
  symlinkSync("/dev/null", join(f.root, "fixtures", "vector.txt"));
  assert.throws(() => prepare(f.root, f.manifest), /symlink/);
});

test("rejects symlinked ancestor directories and invalid reviewed paths", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.root, "fixtures"), join(f.root, "alias"));
  assert.throws(
    () => prepare(f.root, [{ ...f.manifest[0], path: "alias/vector.txt" }]),
    /symlink/,
  );
  for (const path of [
    "/absolute",
    "../escape",
    "fixtures/../escape",
    "fixtures//vector.txt",
  ])
    assert.throws(
      () => prepare(f.root, [{ ...f.manifest[0], path }]),
      /Invalid reviewed path/,
    );
});

test("CLI retains only sanitized metadata and fails on an unknown finding", (t) => {
  const f = fixture(t);
  const gate = fileURLToPath(
    new URL("./gitleaks-working-tree-gate.mjs", import.meta.url),
  );
  const manifest = join(f.root, "manifest.json");
  const state = join(f.root, "state.json");
  const raw = join(f.root, "raw.json");
  const output = join(f.root, "out.json");
  writeFileSync(manifest, JSON.stringify(f.manifest));
  let p = spawnSync(
    process.execPath,
    [gate, "prepare", f.root, manifest, state],
    { encoding: "utf8" },
  );
  assert.equal(p.status, 0);
  writeFileSync(
    raw,
    JSON.stringify([{ ...f.finding, Match: "private unknown data" }]),
  );
  p = spawnSync(
    process.execPath,
    [gate, "classify", f.root, manifest, state, raw, output, "1"],
    { encoding: "utf8" },
  );
  assert.equal(p.status, 1);
  assert.doesNotMatch(
    p.stdout + p.stderr + readFileSync(output, "utf8"),
    /private unknown data|fixtures\/vector/,
  );
  assert.equal(JSON.parse(readFileSync(output, "utf8"))[0].reviewed, false);
  writeFileSync(raw, "not-json private unknown data");
  p = spawnSync(
    process.execPath,
    [gate, "classify", f.root, manifest, state, raw, output, "1"],
    { encoding: "utf8" },
  );
  assert.notEqual(p.status, 0);
  assert.doesNotMatch(p.stderr, /private unknown data/);
  writeFileSync(manifest, JSON.stringify([]));
  p = spawnSync(
    process.execPath,
    [gate, "classify", f.root, manifest, state, raw, output, "1"],
    { encoding: "utf8" },
  );
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /manifest changed/);
});

test("shell gate removes raw scanner evidence on success and failure", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gitleaks-shell-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  const audit = join(base, "audit");
  const bin = join(base, "bin");
  for (const dir of [
    join(root, "scripts", "audit"),
    join(root, "scripts", "security"),
    join(root, "scripts", "lib"),
    audit,
    bin,
  ])
    mkdirSync(dir, { recursive: true });
  chmodSync(audit, 0o700);
  const project = fileURLToPath(new URL("../../", import.meta.url));
  for (const path of [
    "scripts/audit/gitleaks-gate.sh",
    "scripts/lib/audit-directory.sh",
    "scripts/lib/json-boundary.mjs",
    "scripts/security/gitleaks-working-tree-gate.mjs",
  ])
    copyFileSync(join(project, path), join(root, path));
  writeFileSync(join(root, ".gitleaks.toml"), "");
  writeFileSync(
    join(root, "scripts/security/gitleaks-reviewed-working-tree.json"),
    "[]",
  );
  const fake = join(bin, "gitleaks");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs=require('node:fs');
const a=process.argv.slice(2);const p=a[a.indexOf('--report-path')+1];
if (process.env.FAKE_MODE==='error') { process.stdout.write('private scanner bytes');process.exit(2); }
const found=(process.env.FAKE_MODE==='finding' && a.includes('--no-git')) || (process.env.FAKE_MODE.startsWith('history') && !a.includes('--no-git'));
const rows=found?[{File:'private-path',RuleID:'private-key',StartLine:1,Match:'private scanner bytes'}]:[];
fs.writeFileSync(p,JSON.stringify(rows));
process.exit(rows.length?1:0);
`,
  );
  chmodSync(fake, 0o700);
  for (const mode of [
    "clean",
    "finding",
    "error",
    "history",
    "history-strict",
  ]) {
    const run = spawnSync(
      "bash",
      [join(root, "scripts/audit/gitleaks-gate.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          OPENSESAME_AUDIT_DIR: audit,
          FAKE_MODE: mode,
          OPENSESAME_GITLEAKS_HISTORY_FAIL:
            mode === "history-strict" ? "1" : "",
        },
      },
    );
    assert.equal(
      run.status,
      mode === "clean" || mode === "history" ? 0 : 1,
      mode,
    );
    if (mode === "history") {
      assert.match(run.stdout, /WARN.*git history findings present/);
      assert.match(run.stdout, /PASS.*history findings remain/);
      assert.doesNotMatch(run.stdout, /gitleaks gate: CLEAN/);
    }
    if (mode === "history-strict")
      assert.match(run.stderr, /FAIL.*git history leaks/);
    assert.doesNotMatch(
      run.stdout + run.stderr,
      /private scanner bytes|private-path/,
    );
    for (const dir of readdirSync(audit)) {
      const files = readdirSync(join(audit, dir));
      assert.ok(
        !files.some((name) => name.startsWith(".gitleaks-private.")),
        "raw temporary directory must be removed",
      );
      if (files.includes("gitleaks-dir.json"))
        assert.doesNotMatch(
          readFileSync(join(audit, dir, "gitleaks-dir.json"), "utf8"),
          /private scanner bytes|private-path/,
        );
    }
  }
});
