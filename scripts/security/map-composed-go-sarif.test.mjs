import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { mapReport, oracleMap, overlayMap } from "./map-composed-go-sarif.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const root = "tools/pwa-tailscale-native-http";
const staged = ".codeql-native/source";
const entries = [
  ["nativeHttp", "nativehttp.go", "cmd/tsconnect/nativehttp"],
  ["nativeBridge", "nativehttp_js.go", "cmd/tsconnect/nativehttp"],
  ["nativeNode", "nodepeer.go", "cmd/tsconnect/wasm"],
  ["nativeNode", "native-ssh-keys.go", "cmd/tsconnect/wasm"],
  ["nativeNode", "native-ssh-keys_test.go", "cmd/tsconnect/wasm"],
  ["nativeNode", "nodessh_js.go", "cmd/tsconnect/wasm"],
  ["nativeNode", "native-extra-dns.go", "ipn/ipnlocal"],
  ["publicTrust", "public-roots.go", "cmd/tsconnect/nativehttp"],
  ["peerGET", "peer-get.go", "cmd/tsconnect/nativehttp"],
  ["peerGET", "nodepeerget_js.go", "cmd/tsconnect/wasm"],
];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "native-go-map-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (path, bytes) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), bytes);
  };
  const plan = Object.fromEntries(
    [...new Set(entries.map(([group]) => group))].map((group) => [
      group,
      { files: [] },
    ]),
  );
  for (const [group, name] of entries) {
    const bytes = `package fixture\n// ${name}\n`;
    plan[group].files.push({ path: name, sha256: hash(bytes) });
    write(`${root}/${name}`, bytes);
  }
  write(`${root}/source.json`, JSON.stringify(plan));
  const oracle = "packages/app-core/scripts/sops-oracle/treedump.go";
  write(oracle, "package main\n// reviewed oracle\n");
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("add", root, oracle);
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  const sha = git("rev-parse", "HEAD");
  for (const [, name, folder] of entries)
    write(
      `${staged}/${folder}/${name}`,
      readFileSync(join(directory, root, name)),
    );
  write(
    ".codeql-sops/sops-src/treedump/main.go",
    readFileSync(join(directory, oracle)),
  );
  return { directory, sha, write, plan, git };
}

test("maps exact committed overlay bytes while retaining all upstream findings and locations", (t) => {
  const f = fixture(t);
  const mappings = overlayMap(f.directory, f.sha);
  assert.equal(mappings.size, entries.length);
  for (const name of [
    "native-ssh-keys.go",
    "native-ssh-keys_test.go",
    "nodessh_js.go",
  ])
    assert.equal(
      mappings.get(`${staged}/cmd/tsconnect/wasm/${name}`),
      `${root}/${name}`,
    );
  const source = `${staged}/cmd/tsconnect/wasm/nodepeer.go`;
  const target = `${root}/nodepeer.go`;
  const upstream = `${staged}/ipn/ipnlocal/c2n.go`;
  const loc = (uri, index) => ({
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: "%SRCROOT%", index },
      region: { startLine: 8 },
    },
  });
  const report = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "CodeQL" } },
        artifacts: [
          { location: { uri: source, uriBaseId: "%SRCROOT%", index: 0 } },
          { location: { uri: upstream, uriBaseId: "%SRCROOT%", index: 1 } },
        ],
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: [
              { level: "none", locations: [loc(source, 0)] },
            ],
          },
        ],
        results: [
          {
            ruleId: "go/example",
            partialFingerprints: { primaryLocationLineHash: "abc:1" },
            locations: [loc(source, 0)],
            codeFlows: [
              { threadFlows: [{ locations: [{ location: loc(source, 0) }] }] },
            ],
          },
          { ruleId: "go/upstream", locations: [loc(upstream, 1)] },
        ],
      },
    ],
  };
  assert.deepEqual(mapReport(report, mappings), {
    findings: 2,
    unmappedPrimaryFindings: 1,
    unmappedResultLocations: 1,
    invalidInvocations: 0,
    errorNotifications: 0,
    reviewedFalsePositives: 0,
    verifiedFiles: entries.length,
    mappedLocations: 4,
  });
  const run = report.runs[0];
  assert.equal(run.artifacts[0].location.uri, target);
  assert.equal(
    run.results[0].locations[0].physicalLocation.artifactLocation.uri,
    target,
  );
  assert.equal(
    run.results[0].codeFlows[0].threadFlows[0].locations[0].location
      .physicalLocation.artifactLocation.uri,
    target,
  );
  assert.equal(
    run.invocations[0].toolExecutionNotifications[0].locations[0]
      .physicalLocation.artifactLocation.uri,
    target,
  );
  assert.equal(
    run.results[0].partialFingerprints.primaryLocationLineHash,
    "abc:1",
  );
  assert.equal(
    run.results[1].locations[0].physicalLocation.artifactLocation.uri,
    upstream,
  );
});

test("retains every TLS finding even with a candidate-supplied matching source digest", (t) => {
  const f = fixture(t);
  const uri = `${staged}/net/tlsdial/tlsdial.go`;
  const bytes = "candidate supplied source\n";
  f.write(uri, bytes);
  const location = (line) => ({
    physicalLocation: {
      artifactLocation: { uri },
      region: { startLine: line },
    },
  });
  const results = [
    { ruleId: "go/disabled-certificate-check", locations: [location(10)] },
    {
      ruleId: "go/disabled-certificate-check",
      locations: [location(20)],
      partialFingerprints: { primaryLocationLineHash: "another-finding" },
    },
  ];
  const report = {
    version: "2.1.0",
    runs: [{ artifacts: [], results: structuredClone(results) }],
  };
  const review = { workspace: f.directory, afterSha256: hash(bytes) };
  const summary = mapReport(report, new Map(), review);
  assert.equal(summary.reviewedFalsePositives, 0);
  assert.equal(summary.findings, 2);
  assert.equal(summary.unmappedPrimaryFindings, 2);
  assert.deepEqual(report.runs[0].results, results);
});

test("dispositions only the complete reviewed upstream TLS result", () => {
  const result = JSON.parse(
    readFileSync(
      new URL(
        "../release/fixtures/codeql-reviewed-native.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const report = {
    version: "2.1.0",
    runs: [
      {
        artifacts: [
          {
            location: {
              uri: ".codeql-native/source/net/tlsdial/tlsdial.go",
              uriBaseId: "%SRCROOT%",
              index: 0,
            },
          },
        ],
        results: [result],
      },
    ],
  };
  const summary = mapReport(report, new Map());
  assert.equal(summary.reviewedFalsePositives, 1);
  assert.equal(summary.findings, 0);
  assert.equal(summary.unmappedPrimaryFindings, 0);
  assert.deepEqual(report.runs[0].results, []);
  result.message.text = "A different finding";
  report.runs[0].results = [result];
  assert.equal(mapReport(report, new Map()).unmappedPrimaryFindings, 1);
});

test("counts missing and failed invocations and both kinds of error notifications", () => {
  const report = { version: "2.1.0", runs: [{ results: [], artifacts: [] }] };
  assert.equal(mapReport(report, new Map()).invalidInvocations, 1);
  report.runs[0].invocations = [
    {
      executionSuccessful: false,
      toolExecutionNotifications: [{ level: "error" }],
      toolConfigurationNotifications: [{ level: "error" }],
    },
  ];
  const summary = mapReport(report, new Map());
  assert.equal(summary.invalidInvocations, 1);
  assert.equal(summary.errorNotifications, 2);
  report.runs[0].invocations[0].toolConfigurationNotifications = {};
  assert.throws(() => mapReport(report, new Map()), /notifications/);
});

test("validates SARIF indexes, preserves unrelated URIs, and counts unmapped result traces", () => {
  const source = `${staged}/cmd/tsconnect/wasm/nodepeer.go`;
  const target = `${root}/nodepeer.go`;
  const upstream = `${staged}/upstream.go`;
  const mappings = new Map([[source, target]]);
  const make = () => ({
    version: "2.1.0",
    runs: [
      {
        artifacts: [
          { location: { uri: source, uriBaseId: "%SRCROOT%" } },
          { location: { uri: upstream, uriBaseId: "%SRCROOT%" } },
        ],
        results: [
          {
            locations: [
              { physicalLocation: { artifactLocation: { index: 0 } } },
            ],
            relatedLocations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: upstream,
                    uriBaseId: "%SRCROOT%",
                    index: 1,
                  },
                },
              },
            ],
            properties: { unrelated: { uri: source } },
          },
        ],
      },
    ],
  });
  const valid = make();
  const summary = mapReport(valid, mappings);
  assert.equal(summary.unmappedPrimaryFindings, 0);
  assert.equal(summary.unmappedResultLocations, 1);
  assert.equal(valid.runs[0].artifacts[0].location.uri, target);
  assert.deepEqual(
    valid.runs[0].results[0].locations[0].physicalLocation.artifactLocation,
    { index: 0 },
  );
  assert.equal(valid.runs[0].results[0].properties.unrelated.uri, source);
  for (const bad of [
    { uri: upstream, index: 0 },
    { index: 3 },
    { uri: source, uriBaseId: "other", index: 0 },
  ]) {
    const invalid = make();
    invalid.runs[0].results[0].locations[0].physicalLocation.artifactLocation =
      bad;
    assert.throws(() => mapReport(invalid, mappings), /index|disagrees/);
  }
});

test("maps the copied oracle only when its committed and staged bytes agree", (t) => {
  const f = fixture(t);
  const source = ".codeql-sops/sops-src/treedump/main.go";
  assert.equal(
    oracleMap(f.directory, f.sha).get(source),
    "packages/app-core/scripts/sops-oracle/treedump.go",
  );
  f.write(source, "different oracle\n");
  assert.throws(() => oracleMap(f.directory, f.sha), /differs/);
});

test("rejects staged, tracked, manifest and source identity changes", (t) => {
  const f = fixture(t);
  const tracked = `${root}/nodepeer.go`;
  const source = `${staged}/cmd/tsconnect/wasm/nodepeer.go`;
  const original = readFileSync(join(f.directory, tracked));
  f.write(source, "different\n");
  assert.throws(() => overlayMap(f.directory, f.sha), /differs/);
  f.write(source, original);
  const ssh = `${staged}/cmd/tsconnect/wasm/native-ssh-keys.go`;
  f.write(ssh, "replaced key verifier\n");
  assert.throws(() => overlayMap(f.directory, f.sha), /differs/);
  f.write(ssh, readFileSync(join(f.directory, root, "native-ssh-keys.go")));
  f.write(tracked, "changed\n");
  assert.throws(() => overlayMap(f.directory, f.sha), /differs/);
  f.write(tracked, original);
  f.write(`${root}/source.json`, "{}\n");
  assert.throws(() => overlayMap(f.directory, f.sha), /Source plan differs/);
  assert.throws(
    () => overlayMap(f.directory, "a".repeat(40)),
    /Checkout differs/,
  );
});

test("rejects symlinked staged files and duplicate mapped artifacts", (t) => {
  const f = fixture(t);
  const source = `${staged}/cmd/tsconnect/wasm/nodepeer.go`;
  const tracked = `${root}/nodepeer.go`;
  const mappings = overlayMap(f.directory, f.sha);
  const report = {
    version: "2.1.0",
    runs: [
      {
        results: [],
        artifacts: [
          { location: { uri: source, uriBaseId: "%SRCROOT%" } },
          { location: { uri: tracked, uriBaseId: "%SRCROOT%" } },
        ],
      },
    ],
  };
  assert.throws(() => mapReport(report, mappings), /Duplicate mapped/);
  rmSync(join(f.directory, source));
  symlinkSync(join(f.directory, tracked), join(f.directory, source));
  assert.throws(() => overlayMap(f.directory, f.sha), /regular owned file/);
});

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
