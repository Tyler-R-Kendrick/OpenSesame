import { readFileSync } from "node:fs";

// The scanner adapter writes a JSON array. No advisory exceptions are accepted.
try {
  if (process.argv.length !== 3) throw new Error("Expected one findings file");
  const findings = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (!Array.isArray(findings)) throw new Error("Expected a findings array");
  if (findings.length !== 0) {
    throw new Error(`Reported vulnerabilities: ${JSON.stringify(findings)}`);
  }
  console.log("osv-scanner gate: CLEAN (no findings)");
} catch (error) {
  console.error(`osv-scanner gate: FAIL (${error.message})`);
  process.exitCode = 1;
}
