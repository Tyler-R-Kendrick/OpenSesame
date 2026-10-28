import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashDistribution } from "./build-provenance.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-provenance-"));
  roots.push(root);
  return root;
}

it("length-prefixed records prevent cross-file hash collisions", () => {
  const left = fixture();
  const right = fixture();
  fs.writeFileSync(path.join(left, "a"), "x");
  fs.writeFileSync(path.join(left, "b"), "y");
  fs.writeFileSync(path.join(right, "a"), "xb\0y");
  expect(hashDistribution(left)).not.toBe(hashDistribution(right));
});

it("matching distributions are stable across creation order", () => {
  const left = fixture();
  const right = fixture();
  fs.mkdirSync(path.join(left, "nested"));
  fs.mkdirSync(path.join(right, "nested"));
  fs.writeFileSync(path.join(left, "z"), "last");
  fs.writeFileSync(path.join(left, "nested/a"), "first");
  fs.writeFileSync(path.join(right, "nested/a"), "first");
  fs.writeFileSync(path.join(right, "z"), "last");
  expect(hashDistribution(left)).toBe(hashDistribution(right));
  expect(hashDistribution(left)).toBe(hashDistribution(left));
});

it("file and directory symlinks are rejected", () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "target"), "contents");
  fs.symlinkSync("target", path.join(root, "file-link"));
  expect(() => hashDistribution(root)).toThrow(
    /Distribution contains a symlink/,
  );
  fs.rmSync(path.join(root, "file-link"));
  fs.mkdirSync(path.join(root, "target-directory"));
  fs.symlinkSync("target-directory", path.join(root, "directory-link"), "dir");
  expect(() => hashDistribution(root)).toThrow(
    /Distribution contains a symlink/,
  );
});
