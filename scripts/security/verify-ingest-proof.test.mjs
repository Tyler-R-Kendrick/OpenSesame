import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./verify-ingest-proof.mjs", import.meta.url));
const category = "/language:go-composed-native-review";
const ref = "refs/heads/review/native-ssh-host-key-proof";
const sha = "69e60b69be2348fef8c1bed84f21d853af444148";
const results = [
  ["go/reflected-xss", ".codeql-native/source/ipn/ipnlocal/c2n.go", 166],
  ["go/reflected-xss", ".codeql-native/source/ipn/ipnlocal/peerapi.go", 961],
  ["go/path-injection", ".codeql-native/source/ipn/ipnlocal/local.go", 8380],
  ["go/uncontrolled-allocation-size", ".codeql-native/source/net/dns/resolver/debug.go", 32],
  ["go/disabled-certificate-check", ".codeql-native/source/net/tlsdial/tlsdial.go", 257],
  ["go/clear-text-logging", ".codeql-native/source/control/controlclient/direct.go", 1527],
];
const fixture = () => results.map(([id, path, start_line], n) => ({
  number: n + 625,
  rule: { id },
  most_recent_instance: { category, ref, commit_sha: sha, location: { path, start_line } },
}));

test("requires all six real rules and locations on the exact ref, SHA and normalized API category", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ingest-proof-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, "alerts.json");
  const output = join(directory, "summary.json");
  function verify(alerts) {
    writeFileSync(input, JSON.stringify([alerts]));
    const result = spawnSync(process.execPath, [script, "alerts", input, output], { encoding: "utf8" });
    assert.equal(result.error, undefined);
    return result.status;
  }
  assert.equal(verify(fixture()), 0);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).matchesAllSix, true);
  for (const mutate of [
    (a) => a.pop(),
    (a) => { a[0].most_recent_instance.category += "/"; },
    (a) => { a[0].most_recent_instance.ref = "refs/heads/main"; },
    (a) => { a[0].most_recent_instance.commit_sha = "a".repeat(40); },
    (a) => { a[0].most_recent_instance.location.path = ".codeql-native/source/elsewhere.go"; },
    (a) => { a[0].most_recent_instance.location.start_line++; },
    (a) => { a[0].rule.id = "go/other"; },
  ]) {
    const alerts = fixture();
    mutate(alerts);
    assert.notEqual(verify(alerts), 0);
  }
});
