import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPinnedFile } from "../lib/read-pinned-file.mjs";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "pinned-read-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(join(root, "nested"), { recursive: true });
  mkdirSync(outside);
  const path = join(root, "nested", "record.txt");
  writeFileSync(path, "approved");
  writeFileSync(join(outside, "record.txt"), "outside-private");
  return { root, outside, path };
}

test("pinned read returns the checked regular file", (t) => {
  const f = fixture(t);
  assert.equal(
    readPinnedFile(f.path, lstatSync(f.path)).bytes.toString(),
    "approved",
  );
});

test("a leaf swapped to a symlink after inspection is never read", (t) => {
  const f = fixture(t);
  const expected = lstatSync(f.path);
  rmSync(f.path);
  symlinkSync(join(f.outside, "record.txt"), f.path);
  assert.throws(
    () => readPinnedFile(f.path, expected),
    /ELOOP|changed during inspection/u,
  );
});

test("a leaf swapped to another regular inode after inspection is refused", (t) => {
  const f = fixture(t);
  const expected = lstatSync(f.path);
  const replacement = join(f.root, "replacement.txt");
  writeFileSync(replacement, "unreviewed replacement");
  renameSync(replacement, f.path);
  assert.throws(
    () => readPinnedFile(f.path, expected),
    /changed during inspection/u,
  );
});

test("a parent swapped to an escaping symlink after inspection is refused", (t) => {
  const f = fixture(t);
  const expected = lstatSync(f.path);
  rmSync(join(f.root, "nested"), { recursive: true });
  symlinkSync(f.outside, join(f.root, "nested"), "dir");
  assert.throws(
    () => readPinnedFile(f.path, expected),
    /changed during inspection/u,
  );
});

test("executable mode is read from the pinned descriptor", (t) => {
  const f = fixture(t);
  const expected = lstatSync(f.path);
  chmodSync(f.path, 0o755);
  assert.equal(
    readPinnedFile(f.path, expected).executable,
    lstatSync(f.path).mode & 0o111,
  );
});
