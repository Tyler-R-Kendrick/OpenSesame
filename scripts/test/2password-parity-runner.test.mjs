import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const runner = await readFile(
  new URL("./2password-parity.mjs", import.meta.url),
);

async function exercise(t, { writeFresh = true, corruptMatrix = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "parity-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["scripts/test", "spec/conformance", "work"])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, "scripts/test/2password-parity.mjs"), runner);
  const report = {
    testResults: [
      { assertionResults: [{ fullName: "fresh assertion", status: "passed" }] },
    ],
  };
  await writeFile(path.join(root, "work/suite.json"), JSON.stringify(report));
  await writeFile(
    path.join(root, "work/2password-parity-report.json"),
    '{"parity":true}',
  );
  const preparation = `const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.equal(fs.existsSync('work/2password-parity-report.json'), false); assert.equal(fs.existsSync('work/suite.json'), false);`;
  const suite = `${writeFresh ? `require('node:fs').writeFileSync('work/suite.json', ${JSON.stringify(JSON.stringify(report))});` : ""}${corruptMatrix ? "require('node:fs').appendFileSync('spec/conformance/2password-parity.json', '\\n');" : ""}`;
  const matrix = {
    upstream: { commit: "orchestration-fixture" },
    preparation: [
      { id: "fresh", command: [process.execPath, "-e", preparation] },
    ],
    suites: [
      {
        id: "runtime",
        requires: ["fresh"],
        command: [process.execPath, "-e", suite],
        report: "work/suite.json",
        surfaces: ["test"],
      },
    ],
    scenarios: [
      {
        id: "fixture",
        surfaces: ["test"],
        verification: { test: { suite: "runtime", test: "fresh assertion" } },
      },
    ],
  };
  await writeFile(
    path.join(root, "spec/conformance/2password-parity.json"),
    JSON.stringify(matrix),
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/test/2password-parity.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  return {
    result,
    report: JSON.parse(
      await readFile(
        path.join(root, "work/2password-parity-report.json"),
        "utf8",
      ),
    ),
  };
}

test("invalidates old aggregate and suite reports before fresh preparation", async (t) => {
  const { result, report } = await exercise(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.parity, true);
});

test("a successful command cannot reuse an absent fresh assertion report", async (t) => {
  const { result, report } = await exercise(t, { writeFresh: false });
  assert.equal(result.status, 1);
  assert.equal(report.parity, false);
});

test("a matrix modified during runtime cannot produce parity", async (t) => {
  const { result, report } = await exercise(t, { corruptMatrix: true });
  assert.equal(result.status, 1);
  assert.equal(report.parity, false);
  assert.ok(
    report.failures.some((failure) => failure.includes("matrix changed")),
  );
});
