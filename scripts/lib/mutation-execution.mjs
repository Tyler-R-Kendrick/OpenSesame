import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const featureFiles = [
  "packages/app-core/src/browser/security/broker.ts",
  "packages/app-core/src/browser/security/client.ts",
];

/** Reject empty feature campaigns and completed outcomes without executed tests.
 * Stryker retains responsibility for scores and timeout/error classification.
 */
export function assertFeatureMutationExecution(report) {
  const files = report?.files;
  if (
    !files ||
    Object.keys(files).length !== featureFiles.length ||
    featureFiles.some((path) => !Array.isArray(files[path]?.mutants))
  ) {
    throw new Error("Expected the complete feature mutation report");
  }
  for (const path of featureFiles) {
    const mutants = files[path].mutants;
    if (mutants.length === 0) throw new Error("Feature mutants are missing");
    for (const mutant of mutants) {
      if (
        ["Killed", "Survived"].includes(mutant.status) &&
        (!Number.isSafeInteger(mutant.testsCompleted) ||
          mutant.testsCompleted <= 0)
      ) {
        throw new Error("Completed mutation outcome executed no tests");
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assertFeatureMutationExecution(
    JSON.parse(readFileSync(process.argv[2], "utf8")),
  );
}
