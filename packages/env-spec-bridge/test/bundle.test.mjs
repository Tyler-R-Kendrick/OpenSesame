import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bundle, entry, packageDir } from "../scripts/bundle.mjs";

const repo = join(packageDir, "..", "..");
// The repository's own schemas, and the shapes they leave out: a sensitive
// static value, keyed resolver arguments, a post-comment decorator.
const fixtures = [
  join(repo, "tests", "fixtures", "demo.env.schema"),
  join(repo, ".env.schema"),
];
const inline = {
  "scope.env.schema": `# @defaultSensitive=false
# ---

# @required @sensitive
GITHUB_TOKEN=opensesameConnection(conn://demo/github, projection=legacy-token, paths="/repos/acme,/user", methods="GET,POST")
`,
  "sensitive.env.schema": `# @sensitive
# @type=string(startsWith=sk_)
LEAK=dummy-value-that-must-not-print
PORT=8080 # @type=port @required
`,
  "login.env.schema": `# @required @sensitive
SITE_LOGIN=opensesameLogin(conn://demo/site, path=sites/demo)
`,
};

// A directory with no node_modules anywhere above it: the bundle must run
// there on its own.
let work;
let bundled;
before(async () => {
  work = mkdtempSync(join(tmpdir(), "env-spec-bundle-"));
  bundled = await bundle(join(work, "kit", "opensesame-env-parse.mjs"));
  for (const [name, text] of Object.entries(inline)) {
    const path = join(work, name);
    writeFileSync(path, text);
    fixtures.push(path);
  }
});
after(() => rmSync(work, { recursive: true, force: true }));

const run = (script, schema) =>
  execFileSync(process.execPath, [script, schema], {
    cwd: work,
    encoding: "utf8",
  });

test("the bundle prints what the unbundled bridge prints for every fixture", () => {
  for (const schema of fixtures) {
    const want = run(entry, schema);
    assert.ok(JSON.parse(want).items.length > 0, schema);
    assert.equal(run(bundled, schema), want, schema);
  }
});

test("the bundle carries the parser inside it and imports only node builtins", () => {
  const text = readFileSync(bundled, "utf8");
  const specifiers = [
    ...text.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm),
  ].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.match(specifier, /^node:/, specifier);
  }
  // The parser's own module, named as it sits under node_modules and not by
  // a path into one machine's package store.
  assert.match(text, /^\/\/ node_modules\/@env-spec\/parser\/dist\/\S+\.mjs$/m);
  assert.match(text, /\bParsedEnvSpecStaticValue = class\b/);
  assert.ok(text.startsWith("#!/usr/bin/env node\n"));
});

test("two bundles of the same inputs are the same bytes", async () => {
  const again = await bundle(join(work, "again.mjs"));
  assert.deepEqual(readFileSync(again), readFileSync(bundled));
});

test("the bundle runs when the path to it has a space in it", () => {
  // A kit unpacked under "My Tools": `import.meta.url` spells the space %20.
  mkdirSync(join(work, "kit dir"));
  const spaced = join(work, "kit dir", "opensesame-env-parse.mjs");
  copyFileSync(bundled, spaced);
  const out = run(spaced, fixtures[0]);
  assert.equal(JSON.parse(out).parser, "@env-spec/parser");
});
