import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dependencyRoot } from "./dependency-root.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

/** A workspace with one member, `packages/core`, and no installed packages. */
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-root-"));
  roots.push(root);
  writeJson(root, "packages/core/package.json", { name: "core" });
  return { root, member: path.join(root, "packages/core/package.json") };
}

function writeText(root, file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function writeJson(root, file, value) {
  writeText(root, file, JSON.stringify(value));
}

/** Install `name` at `at` (a node_modules directory) with `manifest`'s fields. */
function install(root, at, name, manifest, entry = "index.js") {
  writeJson(root, `${at}/${name}/package.json`, { name, ...manifest });
  writeText(root, `${at}/${name}/${entry}`, "export {};\n");
  return fs.realpathSync(path.join(root, at, name));
}

describe("the copy of a dependency a workspace member resolves", () => {
  it("is the member's own copy in an isolated layout", () => {
    const { root, member } = workspace();
    install(root, "node_modules", "@scope/curves", { version: "2.0.1" });
    const own = install(root, "packages/core/node_modules", "@scope/curves", {
      version: "2.4.0",
    });
    expect(fs.realpathSync(dependencyRoot(member, "@scope/curves"))).toBe(own);
  });

  it("is the hoisted copy when the member has none of its own", () => {
    const { root, member } = workspace();
    const hoisted = install(root, "node_modules", "@scope/curves", {
      version: "2.4.0",
    });
    expect(fs.realpathSync(dependencyRoot(member, "@scope/curves"))).toBe(
      hoisted,
    );
  });

  it("is found through exports that do not publish package.json", () => {
    const { root, member } = workspace();
    const hoisted = install(root, "node_modules", "@scope/curves", {
      type: "module",
      exports: { ".": "./index.js", "./nist.js": "./nist.js" },
    });
    expect(fs.realpathSync(dependencyRoot(member, "@scope/curves"))).toBe(
      hoisted,
    );
  });

  it("is the package root when the entry sits in a subdirectory", () => {
    const { root, member } = workspace();
    const hoisted = install(
      root,
      "node_modules",
      "plain",
      { main: "dist/esm/index.js" },
      "dist/esm/index.js",
    );
    writeJson(root, "node_modules/plain/dist/esm/package.json", {
      type: "module",
    });
    expect(fs.realpathSync(dependencyRoot(member, "plain"))).toBe(hoisted);
  });

  it("refuses a dependency the member cannot resolve", () => {
    const { member } = workspace();
    expect(() => dependencyRoot(member, "absent")).toThrow();
  });
});
