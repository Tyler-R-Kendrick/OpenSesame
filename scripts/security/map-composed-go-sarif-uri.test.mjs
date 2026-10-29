import assert from "node:assert/strict";
import { test } from "node:test";
import { mapReport } from "./map-composed-go-sarif.mjs";

const root = "tools/pwa-tailscale-native-http";
const staged = ".codeql-native/source";

test("rejects a staged URI with an unexpected base", () => {
  const source = `${staged}/cmd/tsconnect/wasm/nodepeer.go`;
  const report = {
    version: "2.1.0",
    runs: [
      {
        results: [
          {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: source, uriBaseId: "other" },
                },
              },
            ],
          },
        ],
        artifacts: [],
      },
    ],
  };
  assert.throws(
    () => mapReport(report, new Map([[source, `${root}/nodepeer.go`]])),
    /URI base/,
  );
});
