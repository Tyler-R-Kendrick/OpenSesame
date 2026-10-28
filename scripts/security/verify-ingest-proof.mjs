import { readFileSync, writeFileSync } from "node:fs";

const expected = [
  ["go/reflected-xss", ".codeql-native/source/ipn/ipnlocal/c2n.go", 166],
  ["go/reflected-xss", ".codeql-native/source/ipn/ipnlocal/peerapi.go", 961],
  ["go/path-injection", ".codeql-native/source/ipn/ipnlocal/local.go", 8380],
  ["go/uncontrolled-allocation-size", ".codeql-native/source/net/dns/resolver/debug.go", 32],
  ["go/disabled-certificate-check", ".codeql-native/source/net/tlsdial/tlsdial.go", 257],
  ["go/clear-text-logging", ".codeql-native/source/control/controlclient/direct.go", 1527],
];
const category = "/language:go-composed-native-review/";
const key = (value) => JSON.stringify(value);
const ordered = (values) => values.map(key).sort();
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const fail = (message) => { throw new Error(message); };

if (process.argv[2] === "validate" && process.argv.length === 6) {
  const raw = read(process.argv[3]);
  const mapped = read(process.argv[4]);
  const summary = read(process.argv[5]);
  if (raw.runs?.length !== 1 || mapped.runs?.length !== 1) fail("Expected exactly one SARIF run");
  const run = raw.runs[0];
  if (run.automationDetails?.id !== category || mapped.runs[0].automationDetails?.id !== category) fail("Unexpected category");
  if (run.tool?.driver?.name !== "CodeQL" || !Array.isArray(run.invocations) || !run.invocations.length || run.invocations.some((i) => i.executionSuccessful !== true || ["toolExecutionNotifications", "toolConfigurationNotifications"].some((field) => i[field]?.some((n) => n.level === "error")))) fail("SARIF execution diagnostics are missing or contain an error");
  const actual = run.results.map((result) => {
    const location = result.locations?.[0]?.physicalLocation;
    return [result.ruleId, location?.artifactLocation?.uri, location?.region?.startLine];
  });
  if (key(ordered(actual)) !== key(ordered(expected))) fail("Actual findings differ from reviewed evidence");
  if (key(run.results) !== key(mapped.runs[0].results)) fail("Unexpected changes to actual findings or their traces");
  if (summary.findings !== 6 || summary.unmappedPrimaryFindings !== 6) fail("Unexpected primary mapping coverage");
  console.log(`Verified all ${actual.length} real findings and their complete unchanged result records`);
} else if (process.argv[2] === "alerts" && process.argv.length === 5) {
  const pages = read(process.argv[3]);
  if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p))) fail("Unexpected alert API response");
  const actual = pages.flat().filter((a) => a.most_recent_instance?.category === category).map((a) => ({
    number: a.number,
    rule: a.rule?.id,
    path: a.most_recent_instance?.location?.path,
    line: a.most_recent_instance?.location?.start_line,
  }));
  const tuples = actual.map((a) => [a.rule, a.path, a.line]);
  const matches = key(ordered(tuples)) === key(ordered(expected));
  const result = { category, count: actual.length, matchesAllSix: matches, alerts: actual };
  writeFileSync(process.argv[4], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  if (!matches) fail("GitHub did not expose the six expected branch alerts");
} else {
  fail("Invalid proof command");
}
