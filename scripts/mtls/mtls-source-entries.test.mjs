import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceEntryFailures } from "./mtls-source-entries.mjs";
const cli = {
  name: "@opensesame/cli",
  exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  bin: {
    "opensesame-id": "./dist/bin.js",
    "opensesame-identity": "./dist/bin.js",
  },
  scripts: {
    "test:installed":
      "node scripts/build.mjs && node scripts/test-installed.mjs",
  },
};
test("standalone emitted CLI and source library have distinct validated contracts", () => {
  assert.deepEqual(
    sourceEntryFailures([
      cli,
      { name: "@opensesame/library", exports: "./src/index.ts" },
    ]),
    [],
  );
});
test("a library cannot require a build before source suites run", () => {
  assert.match(
    sourceEntryFailures([
      { name: "@opensesame/library", exports: "./dist/index.js" },
    ])[0],
    /source entry/,
  );
});
test("CLI exemption cannot conceal source consumers in any dependency section", () => {
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    assert.match(
      sourceEntryFailures([
        cli,
        { name: "consumer", [section]: { "@opensesame/cli": "workspace:*" } },
      ])[0],
      /source consumers consumer/,
    );
  }
});
test("an incomplete emitted CLI contract fails", () => {
  assert.match(
    sourceEntryFailures([{ ...cli, bin: {} }])[0],
    /contract is incomplete/,
  );
});
