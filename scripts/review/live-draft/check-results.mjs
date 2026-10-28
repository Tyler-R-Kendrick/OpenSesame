import { readFileSync } from "node:fs";
const [file, phase] = process.argv.slice(2);
if (!["before", "after"].includes(phase) || !file) throw new Error("Unexpected report arguments");
const report = JSON.parse(readFileSync(file, "utf8"));
const cases = report.testResults.flatMap((suite) => suite.assertionResults)
  .filter((result) => result.status !== "pending" && result.status !== "skipped");
const expected = [
  ["keeps a newer address typed", "100.64.0.2"],
  ["keeps newer TURN server and credentials", "turn:next.example.com"],
  ["keeps a newer carrier draft", "wss://next.example.com"],
];
if (cases.length !== 3) throw new Error(`Unexpected executed test count: ${cases.length}`);
for (const [name, expectedValue] of expected) {
  const matching = cases.filter((entry) => entry.fullName.includes(name));
  if (matching.length !== 1) throw new Error(`Missing or duplicate expected case: ${name}`);
  const result = matching[0];
  if (phase === "before") {
    const failure = (result.failureMessages ?? []).join("\n");
    if (result.status !== "failed" || !failure.includes("AssertionError") || !failure.includes(expectedValue))
      throw new Error(`Baseline did not show the expected lost-draft assertion: ${name}`);
  } else if (result.status !== "passed") {
    throw new Error(`Fix did not pass: ${name}`);
  }
  console.log(`${phase}: ${name}: ${result.status}`);
}
