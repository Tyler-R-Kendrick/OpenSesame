#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const aggregateReportPath = path.join(
  root,
  "work/2password-parity-report.json",
);
await rm(aggregateReportPath, { force: true });
const manifestPath = path.join(root, "spec/conformance/2password-parity.json");
const manifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const upstreamReview = manifest.upstream.review
  ? JSON.parse(
      await readFile(path.join(root, manifest.upstream.review), "utf8"),
    )
  : undefined;
const failures = [];
const results = new Map();
const preparationResults = new Map();
for (const suite of manifest.suites) {
  if (suite.report) await rm(path.join(root, suite.report), { force: true });
}
for (const preparation of manifest.preparation ?? []) {
  const result = spawnSync(
    preparation.command[0],
    preparation.command.slice(1),
    {
      cwd: preparation.cwd ? path.join(root, preparation.cwd) : root,
      stdio: "inherit",
      env: { ...process.env, ...preparation.env },
    },
  );
  const passed = result.status === 0 && !result.error;
  preparationResults.set(preparation.id, passed);
  if (!passed) failures.push(`Fresh build failed: ${preparation.id}`);
}
if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) {
  throw new Error("The parity scenario matrix must not be empty");
}
const scenarioIds = new Set();
for (const scenario of manifest.scenarios) {
  if (scenarioIds.has(scenario.id) || !scenario.surfaces?.length) {
    throw new Error(`Invalid parity scenario: ${scenario.id}`);
  }
  scenarioIds.add(scenario.id);
}
const suiteIds = new Set();
for (const suite of manifest.suites) {
  if (suiteIds.has(suite.id) || !suite.command?.length || !suite.report) {
    throw new Error(`Invalid parity runtime suite: ${suite.id}`);
  }
  suiteIds.add(suite.id);
  if ((suite.requires ?? []).some((id) => !preparationResults.get(id))) {
    results.set(suite.id, false);
    failures.push(
      `Runtime suite requires a fresh successful build: ${suite.id}`,
    );
    continue;
  }
  const environment = { ...process.env, ...suite.env };
  if (suite.requires?.includes("native-build")) {
    environment.OPENSESAME_NATIVE_BINARY = path.join(
      root,
      "work/2password-native-artifacts/opensesame",
    );
  }
  const result = spawnSync(suite.command[0], suite.command.slice(1), {
    cwd: suite.cwd ? path.join(root, suite.cwd) : root,
    stdio: "inherit",
    env: environment,
  });
  results.set(suite.id, result.status === 0 && !result.error);
  if (!results.get(suite.id))
    failures.push(`Runtime suite failed: ${suite.id}`);
}
async function checkAssertion(binding, label) {
  const suite = manifest.suites.find((entry) => entry.id === binding.suite);
  if (!suite || !results.get(binding.suite)) {
    failures.push(`${label} suite did not pass: ${binding.suite}`);
    return;
  }
  try {
    const report = JSON.parse(
      await readFile(path.join(root, suite.report), "utf8"),
    );
    const assertions = report.testResults.flatMap(
      (entry) => entry.assertionResults,
    );
    if (
      !assertions.some(
        (entry) => entry.status === "passed" && entry.fullName === binding.test,
      )
    ) {
      failures.push(`${label} assertion did not pass: ${binding.test}`);
    }
  } catch {
    failures.push(`${label} assertion report unavailable`);
  }
}
for (const scenario of manifest.scenarios) {
  for (const surface of scenario.surfaces) {
    const binding = scenario.verification[surface];
    if (!binding || !results.get(binding.suite)) {
      failures.push(
        `${scenario.id}: ${surface} has no passing runtime verification`,
      );
      continue;
    }
    const suite = manifest.suites.find((entry) => entry.id === binding.suite);
    if (!suite.surfaces?.includes(surface)) {
      failures.push(
        `${scenario.id}: ${surface} is not exercised by ${binding.suite}`,
      );
      continue;
    }
    if (!suite.report) {
      failures.push(`${scenario.id}: ${surface} has no assertion report`);
      continue;
    }
    await checkAssertion(binding, `${scenario.id}: ${surface} runtime`);
    for (const supporting of binding.supportingAssertions ?? []) {
      await checkAssertion(supporting, `${scenario.id}: ${surface} supporting`);
    }
  }
}
if ((await readFile(manifestPath, "utf8")) !== manifestText) {
  failures.push(
    "Parity matrix changed during verification; rerun against a frozen snapshot",
  );
}
await mkdir(path.join(root, "work"), { recursive: true });
await writeFile(
  aggregateReportPath,
  `${JSON.stringify(
    {
      upstream: manifest.upstream,
      matrixFingerprint: createHash("sha256")
        .update(manifestText)
        .digest("hex"),
      upstreamReview: upstreamReview && {
        inspectedAt: upstreamReview.inspectedAt,
        pullRequests: upstreamReview.pullRequests.map(
          ({ number, head, state, mergedAt, url }) => ({
            number,
            head,
            state,
            mergedAt,
            url,
          }),
        ),
        issues: upstreamReview.issues.map(({ number, state, url }) => ({
          number,
          state,
          url,
        })),
      },
      parity: failures.length === 0,
      scenarios: manifest.scenarios.length,
      surfaceChecks: manifest.scenarios.reduce(
        (count, scenario) => count + scenario.surfaces.length,
        0,
      ),
      failures,
    },
    null,
    2,
  )}\n`,
);
if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `2password parity verified against ${manifest.upstream.commit}: ${manifest.scenarios.length} scenarios\n`,
  );
}
