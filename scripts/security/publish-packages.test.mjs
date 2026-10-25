import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
import { selectedPackages } from "../release/publish-packages.mjs";

test("publication accepts exact workspace names and rejects filter and shell syntax", () => {
  assert.equal(
    selectedPackages(" @opensesame/os-domain ,@opensesame/api-client ").length,
    2,
  );
  assert.equal(
    selectedPackages("@opensesame/os-domain,@opensesame/os-domain").length,
    1,
  );
  for (const input of [
    "",
    "*",
    "--help",
    "@opensesame/*",
    "@opensesame/no-such-package",
    "@opensesame/os-domain,",
    "$(touch injected)",
    "`touch injected`",
    'a"; touch injected; #',
    "a\nb",
    "a\rb",
    "a>b",
    "a|b",
    "a;b",
  ]) {
    assert.throws(() => selectedPackages(input), undefined, input);
  }
});

test("invalid selections never start pnpm; valid publication uses argv and a package cwd", () => {
  const directory = mkdtempSync(join(tmpdir(), "publish-packages-"));
  try {
    mkdirSync(join(directory, "bin"));
    const log = join(directory, "invocations");
    writeFileSync(
      join(directory, "bin", "pnpm"),
      '#!/bin/sh\npwd >> "$PUBLISH_TEST_LOG"\nprintf "%s\\n" "$@" >> "$PUBLISH_TEST_LOG"\n',
      { mode: 0o755 },
    );
    const run = (input) =>
      spawnSync(process.execPath, ["scripts/release/publish-packages.mjs"], {
        env: {
          ...process.env,
          PATH: `${join(directory, "bin")}:${process.env.PATH}`,
          NPM_PACKAGES: input,
          PUBLISH_TEST_LOG: log,
        },
        encoding: "utf8",
      });
    for (const input of [
      "$(touch injected)",
      "@opensesame/os-domain,@opensesame/*",
      "@opensesame/os-domain\n--help",
    ]) {
      assert.notEqual(run(input).status, 0);
      assert.equal(existsSync(log), false);
      assert.equal(existsSync("injected"), false);
    }
    assert.equal(run("@opensesame/os-domain").status, 0);
    assert.match(
      readFileSync(log, "utf8"),
      /packages\/os-domain\npublish\n--access\npublic\n--no-git-checks\n$/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
