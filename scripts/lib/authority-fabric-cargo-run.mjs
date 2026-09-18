/**
 * Cargo suite batching for the authority-fabric gate.
 *
 * One spawn per (crate, bin|lib) key so scenarios sharing a crate share one
 * build snapshot. Bin targets (gateway) are first-class: `--bin` instead of
 * `--lib` when the scenario names a binary.
 */

import { spawnSync } from "node:child_process";
import {
  cargoDiagnostics,
  enumerateCargoTests,
} from "./authority-fabric-facts.mjs";

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** @param {{ crate: string, bin?: string, integration?: string, features?: string[] }} target */
export function cargoBatchKey(target) {
  const suite =
    isString(target.bin)
      ? `${target.crate}#bin:${target.bin}`
      : isString(target.integration)
        ? `${target.crate}#test:${target.integration}`
        : target.crate;
  if (!Array.isArray(target.features) || target.features.length === 0) {
    return suite;
  }
  return `${suite}#features:${[...target.features].sort().join(",")}`;
}

/** @param {{ bin?: string, integration?: string }} target */
export function cargoSuiteArgs(target) {
  if (isString(target.bin)) return ["--bin", target.bin];
  if (isString(target.integration)) {
    return ["--test", target.integration];
  }
  return ["--lib"];
}

/** @param {{ features?: string[] }} target */
export function cargoFeatureArgs(target) {
  if (!Array.isArray(target.features) || target.features.length === 0) {
    return [];
  }
  return ["--features", target.features.join(",")];
}

/** @param {{ bin?: string }} target */
export function cargoBinName(target) {
  return isString(target.bin) ? target.bin : null;
}

/**
 * @param {readonly { scenario: { target: { kind: string, crate: string, bin?: string, test: string } }, resolution: { status: string } }[]} resolved
 * @param {{ root: string, noRun: boolean }} opts
 */
export function runCargoBatches(resolved, { root, noRun }) {
  const results = new Map();
  if (noRun) return results;
  const batches = new Map();
  for (const { scenario, resolution } of resolved) {
    if (resolution.status !== "runnable" || scenario.target.kind !== "cargo") {
      continue;
    }
    const key = cargoBatchKey(scenario.target);
    if (!batches.has(key)) {
      batches.set(key, {
        crate: scenario.target.crate,
        bin:
          isString(scenario.target.bin) ? scenario.target.bin : null,
        integration:
          isString(scenario.target.integration)
            ? scenario.target.integration
            : null,
        features: scenario.target.features,
      });
    }
  }
  for (const [key, spec] of batches) {
    const result = spawnSync(
      "cargo",
      [
        "+1.88.0",
        "test",
        "-p",
        spec.crate,
        ...cargoSuiteArgs(spec),
        ...cargoFeatureArgs(spec),
        "--",
        "--format",
        "pretty",
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    const printed = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const outcomes = new Map();
    for (const match of printed.matchAll(
      /^test (\S+) \.\.\. (ok|FAILED|ignored)$/gm,
    )) {
      outcomes.set(match[1], match[2]);
    }
    results.set(key, {
      outcomes,
      built: !/error\[E\d+\]|could not compile/.test(printed),
      printed: cargoDiagnostics(printed),
    });
  }
  return results;
}

/**
 * @param {{ target: { crate: string, bin?: string, test: string } }} scenario
 * @param {Map<string, { outcomes: Map<string, string>, built: boolean, printed: string }>} cargoResults
 */
export function readCargoResult(scenario, cargoResults) {
  const key = cargoBatchKey(scenario.target);
  const batch = cargoResults.get(key);
  if (batch === undefined) {
    return {
      status: "blocked",
      reason: "harness-error",
      detail: `no batch result for ${key}`,
    };
  }
  if (!batch.built) {
    return {
      status: "blocked",
      reason: "build-failed",
      detail: batch.printed,
    };
  }
  const outcome = batch.outcomes.get(scenario.target.test);
  if (outcome === undefined) {
    return {
      status: "blocked",
      reason: "no-test",
      detail: `${scenario.target.test} was enumerated but did not run; the crate's suite printed no line for it`,
    };
  }
  if (outcome === "ok") {
    return { status: "pass", detail: `${scenario.target.test} ran and passed` };
  }
  if (outcome === "ignored") {
    return {
      status: "blocked",
      reason: "no-test",
      detail: `${scenario.target.test} is #[ignore]d, so it asserts nothing here`,
    };
  }
  return {
    status: "fail",
    reason: "assertion did not hold",
    detail: `${scenario.target.test} ran and failed:\n${batch.printed}`,
  };
}

/**
 * @param {{
 *   root: string,
 *   noRun: boolean,
 *   cargoTargets: readonly { crate: string, module: string, bin?: string }[],
 *   modules: Record<string, boolean>,
 * }} args
 */
export function enumerateScenarioCargoTests({
  root,
  noRun,
  cargoTargets,
  modules,
}) {
  const tests = {};
  const testErrors = {};
  const enumKeys = new Map();
  for (const target of cargoTargets) {
    const key = cargoBatchKey(target);
    if (!enumKeys.has(key)) {
      enumKeys.set(key, {
        crate: target.crate,
        bin: cargoBinName(target),
        integration:
          isString(target.integration) ? target.integration : null,
        features: target.features,
      });
    }
  }
  for (const [key, spec] of noRun ? enumKeys : []) {
    const anyReachable = cargoTargets.some(
      (target) =>
        cargoBatchKey(target) === key &&
        modules[`${target.crate}:${target.module}`] === true,
    );
    if (!anyReachable) {
      tests[key] = null;
      continue;
    }
    const enumerated = enumerateCargoTests(
      root,
      spec.crate,
      spec.bin,
      spec.features,
      spec.integration,
    );
    tests[key] = enumerated.tests;
    testErrors[key] = enumerated.error;
  }
  return { tests, testErrors };
}
