import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  findTskeyLiteralViolations,
  isScannablePath,
} from "./tskey-literal-gate.mjs";

const prefix = (kind) => `${["ts", "key"].join("")}-${kind}-`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tskey-gate-"));
  return {
    root,
    write(relPath, text) {
      const absolute = join(root, relPath);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, text);
      return relPath;
    },
    scan(files) {
      return findTskeyLiteralViolations({ root, files });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the repository has no committed tailscale key literals", () => {
  const violations = findTskeyLiteralViolations();
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("a source literal is reported with its path", () => {
  const dir = fixture();
  try {
    const secret = `${prefix("api")}abcd1234`;
    dir.write("src/example.ts", `export const key = "${secret}";\n`);
    assert.deepEqual(dir.scan(["src/example.ts"]), ["src/example.ts:1"]);
  } finally {
    dir.cleanup();
  }
});

test("ellipsis placeholders, regex lines, and prefix checks are allowed", () => {
  const dir = fixture();
  try {
    const ellipsis = `${prefix("api")}…`;
    const regex = `/^${prefix("auth")}/`;
    const regexKey = `/^${prefix("auth")}k/`;
    const prefixOnly = `starts_with("${prefix("auth")}")`;
    dir.write(
      "docs/shape.md",
      [
        `An API access token (\`${ellipsis}\`).`,
        regex,
        regexKey,
        prefixOnly,
      ].join("\n"),
    );
    assert.deepEqual(dir.scan(["docs/shape.md"]), []);
  } finally {
    dir.cleanup();
  }
});

test("the production TOKEN regex line is allowed", () => {
  const dir = fixture();
  try {
    const rel = "packages/app-core/src/lib/native-tailscale-api.ts";
    dir.write(
      rel,
      `export const TOKEN = /^${["ts", "key"].join("")}-[A-Za-z0-9_-]{8,300}$/;\n`,
    );
    assert.deepEqual(dir.scan([rel]), []);
  } finally {
    dir.cleanup();
  }
});

test("minters, templates, lockfiles, and build dirs are not scanned", () => {
  const secret = `${prefix("auth")}abcd1234`;
  const samples = [
    "packages/app-core/src/lib/synthetic-tailscale-key.ts",
    "packages/app-core/src/lib/synthetic-tailscale-key.test.ts",
    "scripts/security/tskey-literal-gate.mjs",
    "spec/conformance/tailnet-admin-protocol.json.hbs",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "node_modules/pkg/index.js",
    "target/debug/out.rs",
    "dist/app.js",
  ];
  for (const path of samples) assert.equal(isScannablePath(path), false, path);
  const dir = fixture();
  try {
    for (const path of samples) dir.write(path, `const key = "${secret}";\n`);
    assert.deepEqual(dir.scan(samples), []);
  } finally {
    dir.cleanup();
  }
});
