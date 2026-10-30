import assert from "node:assert/strict";
import { test } from "node:test";
import { mapReport } from "./map-composed-go-sarif.mjs";

test("rejects malformed artifact references inside nested result arrays", () => {
  const make = (reference) => ({
    version: "2.1.0",
    runs: [
      {
        artifacts: [],
        results: [{ nested: [{ artifactLocation: reference }] }],
      },
    ],
  });
  for (const invalid of [null, [], "source.go", 7, { uri: 7 }]) {
    assert.throws(() => mapReport(make(invalid), new Map()), /location|URI/);
  }
  const source = ".codeql-native/source/cmd/tsconnect/wasm/nodepeer.go";
  const target = "tools/pwa-tailscale-native-http/nodepeer.go";
  const report = make({ uri: source, uriBaseId: "%SRCROOT%" });
  const summary = mapReport(report, new Map([[source, target]]));
  assert.equal(summary.mappedLocations, 1);
  assert.equal(
    report.runs[0].results[0].nested[0].artifactLocation.uri,
    target,
  );
});
