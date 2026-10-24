import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/publish-npm.yml", import.meta.url),
  "utf8",
);
const publishStep = workflow.split("      - name: Publish selected packages\n")[1];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "publish-npm-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts/release"), { recursive: true });
  mkdirSync(join(root, "bin"));
  copyFileSync(
    new URL("../release/publish-npm.mjs", import.meta.url),
    join(root, "scripts/release/publish-npm.mjs"),
  );
  const log = join(root, "published.jsonl");
  const marker = join(root, "injected");
  const pnpm = join(root, "bin/pnpm");
  writeFileSync(
    pnpm,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "fs.appendFileSync(process.env.PUBLISH_LOG, JSON.stringify({",
      "  cwd: process.cwd(), args: process.argv.slice(2),",
      "  authenticated: Boolean(process.env.NODE_AUTH_TOKEN)",
      '}) + "\\n");',
      "process.exit(Number(process.env.PUBLISH_EXIT || 0));",
      "",
    ].join("\n"),
  );
  chmodSync(pnpm, 0o755);
  const add = (directory, name, extra = {}, base = "packages") => {
    const path = join(root, base, directory);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({ name, version: "0.1.0", ...extra }),
    );
  };
  add("domain-directory", "@opensesame/os-domain");
  add("api-client", "@opensesame/api-client", { private: false });
  add("private", "@opensesame/private", { private: true });
  add("outside", "@opensesame/outside", {}, "apps");
  const run = (input, overrides = {}) => {
    const command = publishStep.match(/^        run: (.+)$/m)?.[1];
    assert.equal(command, "node scripts/release/publish-npm.mjs");
    return spawnSync("bash", ["-euo", "pipefail", "-c", command], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: join(root, "bin") + ":" + process.env.PATH,
        NODE_AUTH_TOKEN: "test-only-not-a-credential",
        NPM_PACKAGES: input,
        PUBLISH_LOG: log,
        PUBLISH_EXIT: "0",
        ...overrides,
      },
    });
  };
  const published = () =>
    existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
      : [];
  return { root, marker, add, run, published };
}

test("workflow passes dispatch input only as environment data", () => {
  assert.ok(publishStep);
  assert.match(publishStep, /^          NPM_PACKAGES: \$\{\{ inputs.packages \}\}$/m);
  assert.match(
    publishStep,
    /^          NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_TOKEN \}\}$/m,
  );
  const run = publishStep.slice(publishStep.indexOf("        run:"));
  assert.doesNotMatch(run, /\$\{\{/);
});

test("exact public package names publish once in manifest-resolved directories", (t) => {
  const f = fixture(t);
  const result = f.run(
    " @opensesame/os-domain ,\t@opensesame/api-client, @opensesame/os-domain ",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    f.published(),
    ["domain-directory", "api-client"].map((directory) => ({
      cwd: join(f.root, "packages", directory),
      args: ["publish", "--access", "public", "--no-git-checks"],
      authenticated: true,
    })),
  );
});

test("shell syntax and pnpm selectors reject without execution or partial publication", (t) => {
  const f = fixture(t);
  const badInputs = [
    "$(touch " + f.marker + ")",
    String.fromCharCode(96) + "touch " + f.marker + String.fromCharCode(96),
    '"; touch ' + f.marker + "; #",
    "'; touch " + f.marker + "; #",
    "@opensesame/os-domain; touch " + f.marker,
    "@opensesame/os-domain > " + f.marker,
    "@opensesame/os-domain | touch " + f.marker,
    "@opensesame/os-domain\ntouch " + f.marker,
    "@opensesame/os-domain\n@opensesame/api-client",
    "@opensesame/os-domain\r",
    "@opensesame/*",
    "@opensesame/os-domain...",
    "...@opensesame/os-domain",
    "!@opensesame/os-domain",
    "./packages/*",
    "--filter=anything",
    "@opensesame/unknown",
    "@opensesame/private",
    "@opensesame/outside",
    "@opensesame/../api-client",
    "@opensesame/os-domain\\",
    "",
    " ",
    ",",
    "@opensesame/os-domain,",
  ];
  for (const input of badInputs) {
    for (const request of [input, "@opensesame/api-client," + input]) {
      const result = f.run(request);
      assert.notEqual(result.status, 0, JSON.stringify(request));
      assert.deepEqual(f.published(), [], JSON.stringify(request));
      assert.equal(existsSync(f.marker), false, JSON.stringify(request));
    }
  }
});

test("duplicate workspace names fail before publishing", (t) => {
  const f = fixture(t);
  f.add("alias", "@opensesame/os-domain");
  assert.notEqual(f.run("@opensesame/os-domain").status, 0);
  assert.deepEqual(f.published(), []);
});

test("missing token refuses and publisher failure stops subsequent packages", (t) => {
  const f = fixture(t);
  assert.notEqual(
    f.run("@opensesame/os-domain", { NODE_AUTH_TOKEN: "" }).status,
    0,
  );
  assert.deepEqual(f.published(), []);
  const failed = f.run("@opensesame/os-domain,@opensesame/api-client", {
    PUBLISH_EXIT: "17",
  });
  assert.equal(failed.status, 17);
  assert.equal(f.published().length, 1);
});
