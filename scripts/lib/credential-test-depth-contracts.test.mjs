import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
const root = repoRootFromHere();
const read = (name) => readFileSync(join(root, name), "utf8");

it("loads both portable configurations with the canonical browser aliases and 20s case limits", async () => {
  const { default: model } = await import(
    "../../tools/mutation/extension-security-feature-vitest.mjs"
  );
  const { default: genuine } = await import(
    "../../tools/mutation/extension-security-feature-genuine-vitest.mjs"
  );
  for (const config of [model, genuine]) {
    expect(config.root).toBe(join(root, "packages/app-core"));
    expect(config.test.testTimeout).toBe(20000);
    expect(config.test.hookTimeout).toBe(20000);
    expect(config.test.maxWorkers).toBe(1);
    expect(config.test.setupFiles).toEqual(["./src/test-setup.ts"]);
    expect(config.resolve.alias["@opensesame/os-domain"]).toContain(
      "packages/os-domain/src/browser.ts",
    );
  }
  expect(model.test.include).toHaveLength(6);
  expect(genuine.test.include).toEqual([
    ...model.test.include,
    "src/browser/security-integration/management-host.test.ts",
  ]);
});

it("keeps the feature model and genuine mutation campaigns separate with unchanged security thresholds and deadlines", () => {
  const model = JSON.parse(
    read("tools/mutation/extension-security-feature.config.json"),
  );
  const genuine = JSON.parse(
    read("tools/mutation/extension-security-feature-genuine.config.json"),
  );
  for (const config of [model, genuine]) {
    expect(config.mutate).toEqual([
      "packages/app-core/src/browser/security/broker.ts:75:0-144:0",
      "packages/app-core/src/browser/security/client.ts:69:0-94:0",
    ]);
    expect(config.thresholds).toEqual({ high: 100, low: 100, break: 100 });
    expect(config.concurrency).toBe(1);
    expect(config.timeoutMS).toBe(10000);
    expect(config.timeoutFactor).toBe(1.5);
    expect(config.dryRunTimeoutMinutes).toBe(5);
    expect(config.vitest.related).toBe(false);
    expect(config.ignorePatterns).not.toContain("tools/**");
  }
  expect(model.vitest.configFile).not.toBe(genuine.vitest.configFile);
  expect(model.jsonReporter.fileName).not.toBe(genuine.jsonReporter.fileName);
  expect(model.tempDirName).not.toBe(genuine.tempDirName);
  const source = read("tools/mutation/extension-security-feature-vitest.mjs");
  expect(source).toContain(
    'import core from "../../packages/app-core/vitest.config.ts"',
  );
  expect(source).toContain("maxWorkers: 1");
  expect(
    source.match(/src\/browser\/security\/[a-z-]+\.test\.ts/g),
  ).toHaveLength(6);
  expect(
    read("tools/mutation/extension-security-feature-genuine-vitest.mjs"),
  ).toContain("src/browser/security-integration/management-host.test.ts");
  expect(
    JSON.parse(read("tools/mutation/stryker.config.json")).mutate,
  ).not.toContain(model.mutate[0]);
});

function gateFixture() {
  const directory = mkdtempSync(
    join(tmpdir(), "credential-native-gate-contract-"),
  );
  const pkg = join(directory, "tests/fuzz/jazzer");
  const bin = join(directory, "bin");
  for (const part of [
    "scripts/fuzz",
    "scripts/lib",
    "bin",
    "tests/fuzz/jazzer/node_modules/.bin",
    "tests/fuzz/jazzer/src/security-protocol",
  ])
    mkdirSync(join(directory, part), { recursive: true });
  copyFileSync(
    join(root, "scripts/fuzz/jazzer-credential-gate.sh"),
    join(directory, "scripts/fuzz/gate.sh"),
  );
  copyFileSync(
    join(root, "scripts/lib/audit-directory.sh"),
    join(directory, "scripts/lib/audit-directory.sh"),
  );
  for (const path of [
    "credential_canary_parsers",
    "credential_observation_parsers",
    "security-protocol/credential-observation-native",
    "security-protocol/credential-corpus",
  ])
    writeFileSync(join(pkg, `src/${path}.ts`), "");
  writeFileSync(
    join(bin, "node"),
    '#!/bin/sh\nif [ "$1" = "--input-type=module" ]; then exit "$LOADER_STATUS"; fi\nprintf "seed\\n" >> "$GATE_CALLS"\nexit 0\n',
    { mode: 0o700 },
  );
  writeFileSync(
    join(pkg, "node_modules/.bin/jazzer"),
    '#!/bin/sh\nprintf "%s\\n" "$NODE_OPTIONS" "$@" >> "$GATE_CALLS"\nexit "$ENGINE_STATUS"\n',
    { mode: 0o700 },
  );
  return { directory, bin, pkg, calls: join(directory, "calls") };
}

it.each([0, 1])(
  "runs exactly three native targets with fixed bounds and propagates engine status %i",
  (status) => {
    const f = gateFixture();
    let artifacts;
    try {
      const result = spawnSync(
        "bash",
        [join(f.directory, "scripts/fuzz/gate.sh")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${f.bin}:/usr/bin:/bin`,
            GATE_CALLS: f.calls,
            LOADER_STATUS: "0",
            ENGINE_STATUS: String(status),
            FUZZ_SECONDS: "999",
            JAZZER_ALLOW_FALLBACK: "1",
            NODE_OPTIONS: "--no-warnings",
          },
        },
      );
      expect(result.status, result.stderr).toBe(status);
      artifacts = result.stderr.match(/Private audit artifacts: ([^\n]+)/)?.[1];
      expect(artifacts).toBeTruthy();
      expect(statSync(artifacts).mode & 0o777).toBe(0o700);
      const lines = readFileSync(f.calls, "utf8").trim().split("\n");
      expect(lines).toEqual([
        "seed",
        ...[
          ["canary", "src/credential_canary_parsers"],
          ["observation", "src/credential_observation_parsers"],
          ["crypto", "src/security-protocol/credential-observation-native"],
        ].flatMap(([name, target]) => [
          "--no-warnings --import=tsx",
          target,
          "--timeout=5000",
          "--",
          "-max_total_time=60",
          "-max_len=8194",
          `-artifact_prefix=${artifacts}/artifacts/${name}-`,
          `${artifacts}/corpus/${name}`,
        ]),
      ]);
      expect(result.stdout.includes("CLEAN native")).toBe(status === 0);
      expect(result.stdout).not.toContain("DEGRADED");
      for (const name of ["canary", "observation", "crypto"])
        expect(readFileSync(join(artifacts, `${name}.exit`), "utf8")).toBe(
          `${status}\n`,
        );
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
      if (artifacts) rmSync(artifacts, { recursive: true, force: true });
    }
  },
);

it("refuses a missing native addon even when fallback is requested", () => {
  const f = gateFixture();
  let artifacts;
  try {
    const result = spawnSync(
      "bash",
      [join(f.directory, "scripts/fuzz/gate.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${f.bin}:/usr/bin:/bin`,
          GATE_CALLS: f.calls,
          LOADER_STATUS: "1",
          ENGINE_STATUS: "0",
          JAZZER_ALLOW_FALLBACK: "1",
        },
      },
    );
    artifacts = result.stderr.match(/Private audit artifacts: ([^\n]+)/)?.[1];
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no fallback");
    expect(existsSync(f.calls)).toBe(false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
    if (artifacts) rmSync(artifacts, { recursive: true, force: true });
  }
});
