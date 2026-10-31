import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNativePackageAudit,
  decodeNativeProductionTags,
  jsonObjects,
} from "./native-audit.mjs";
const target = "tailscale.com/cmd/tsconnect/wasm";
function fixture() {
  return {
    packages: [
      { ImportPath: target, Module: { Path: "tailscale.com" } },
      { ImportPath: "crypto/x509", Standard: true },
      {
        ImportPath: "golang.org/x/crypto/ssh",
        Module: { Path: "golang.org/x/crypto", Version: "v0.57.0" },
      },
    ],
    messages: [
      {
        config: {
          scanner_name: "govulncheck",
          scanner_version: "v1.9.0",
          scan_level: "package",
          scan_mode: "source",
          go_version: "go1.27.3",
        },
      },
      {
        SBOM: {
          go_version: "go1.27.3",
          roots: [target],
          modules: [
            { path: "stdlib", version: "v1.27.3" },
            { path: "tailscale.com" },
            { path: "golang.org/x/crypto", version: "v0.57.0" },
          ],
        },
      },
    ],
  };
}
test("JSON streams retain quoted braces and escapes and refuse noise or truncation", () => {
  const values = [
    { data: '}"\\[' },
    { finding: { trace: [{ package: "crypto/x509" }] } },
  ];
  assert.deepEqual(
    jsonObjects(
      values.map((value) => JSON.stringify(value, null, 2)).join("\n"),
    ),
    values,
  );
  for (const text of [
    "",
    " ",
    '{"finding":',
    '{"a":"x',
    "{}\nscanner failed",
    "[]",
  ])
    assert.throws(() => jsonObjects(text));
});
test("an exact package-level scan retains module warnings without pretending the package is imported", () => {
  const f = fixture();
  f.messages.push({
    finding: {
      osv: "GO-2026-5932",
      trace: [{ module: "golang.org/x/crypto", version: "v0.57.0" }],
    },
  });
  assert.deepEqual(
    assertNativePackageAudit(f.packages, f.messages, "go1.27.3"),
    {
      packages: 3,
      modules: 3,
      affectedImportedPackages: 0,
      moduleOnlyAdvisories: ["GO-2026-5932"],
      compilerVersion: "go1.27.3",
    },
  );
});
test("an affected imported package fails even when no vulnerable function is called", () => {
  const f = fixture();
  f.messages.push({
    finding: {
      osv: "GO-2026-6809",
      trace: [{ module: "stdlib", package: "crypto/x509" }],
    },
  });
  assert.throws(
    () => assertNativePackageAudit(f.packages, f.messages, "go1.27.3"),
    /imported packages have advisories/,
  );
});
test("missing scanner inventory, changed compiler, partial graph and malformed findings fail closed", () => {
  for (const change of [
    (f) => f.messages.splice(1, 1),
    (f) => {
      f.messages[0].config.scanner_version = "v0.0.0";
    },
    (f) => {
      f.messages[0].config.go_version = "go1.27.2";
    },
    (f) => f.packages.shift(),
    (f) => {
      f.packages[0].DepsErrors = [{ Err: "missing source" }];
    },
    (f) => {
      f.messages[1].SBOM.modules.pop();
    },
    (f) => {
      f.messages[1].SBOM.modules[1] = f.messages[1].SBOM.modules[0];
    },
    (f) => f.messages.push({ finding: { osv: "GO-unknown", trace: [] } }),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() =>
      assertNativePackageAudit(f.packages, f.messages, "go1.27.3"),
    );
  }
});

test("production tags decode unknown JSON through the bounded token-list schema", async () => {
  const valid = "netgo,tailscale_go,ts_omit_ssh";
  assert.equal(await decodeNativeProductionTags(valid), valid);
  for (const value of [
    null,
    42,
    {},
    ["tailscale_go"],
    "",
    "netgo,not_tailscale_go",
    "tailscale_go,ts_omit_useexitnode",
    "tailscale_go,tailscale_go",
    "tailscale_go, bad",
    "tailscale_go;unexpected",
    "tailscale_go,",
    `tailscale_go,${"x".repeat(16384)}`,
  ])
    await assert.rejects(decodeNativeProductionTags(value));
});
