import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { loadShards } from "./ci-gates.mjs";

const root = repoRootFromHere();
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

function cliOutputs(file, command = [], env = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ci-planner-output-"));
  const output = join(directory, "github-output");
  try {
    execFileSync(process.execPath, [join(root, file), ...command], {
      env: {
        ...process.env,
        BASE_SHA: "",
        HEAD_SHA: "",
        ...env,
        GITHUB_OUTPUT: output,
      },
      stdio: "ignore",
    });
    return readFileSync(output, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function selector(env) {
  const out = cliOutputs("scripts/lib/ci-changed-areas.mjs", [], env);
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
}

describe("complete source validation and cumulative integration", () => {
  it("runs fast checks on a push to main and on demand", () => {
    const on = ci.split("\njobs:")[0];
    expect(on).toMatch(/\n {2}push:\n {4}branches: \[main\]/);
    expect(on).toContain("workflow_dispatch:");
  });

  it("uses build jobs without the former test-suite budget", () => {
    const minutes =
      /\n {2}typescript-build:\n[\s\S]*?timeout-minutes: (\d+)/.exec(ci);
    expect(Number(minutes?.[1])).toBeLessThanOrEqual(60);
    expect(Number(minutes?.[1])).toBeGreaterThan(0);
    expect(ci).not.toContain("typescript-tests:");
    expect(ci).not.toContain("check-pr-signatures.mjs");
    expect(ci).not.toContain("check-merge-group-signature.mjs");
    const governance = readFileSync(
      join(root, "ops/github/default-branch.json"),
      "utf8",
    );
    expect(JSON.parse(governance).rules).toContainEqual({
      type: "required_signatures",
    });
  });

  it("cancels only superseded pull requests; main and merge-group runs finish", () => {
    expect(ci).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });

  it("selects every area, every shard and every job when it has no base to diff", () => {
    const out = selector({});
    for (const area of ["typescript", "bundle", "rust", "mtls", "push"]) {
      expect(out[area], area).toBe("true");
    }
    for (const job of [
      "tutorials",
      "device_inbox",
      "device_identity",
      "live_join",
    ]) {
      expect(out[job], job).toBe("true");
    }
    expect(JSON.parse(out.bundle_matrix)).toEqual(loadShards(root));
  });

  it("builds every package and crate when it has no base to diff against", () => {
    for (const command of ["plan-ts", "plan-cargo"]) {
      const out = cliOutputs("scripts/lib/ci-affected-builds.mjs", [command]);
      expect(out).toContain("scope=all");
    }
  });
});

const fullWorkflow = readFileSync(
  join(root, ".github/workflows/full-suite.yml"),
  "utf8",
);
const fullSteps = fullWorkflow
  .split("    steps:\n")[1]
  .split(/\n {6}- (?=name:|uses:)/);

function stepFor(command) {
  const matches = fullSteps.filter((step) => step.includes(command));
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("full-suite native preparation", () => {
  it("uses the repository's bounded package-test concurrency", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    expect(manifest.scripts.test).toContain("--concurrency=1");
    expect(stepFor("pnpm exec turbo run typecheck test")).toContain(
      "run: pnpm exec turbo run typecheck test --concurrency=1",
    );
  });
  it("checks out the exact selected candidate commit for reusable validation", () => {
    expect(fullWorkflow).toContain("workflow_call:");
    expect(fullWorkflow).not.toContain("  schedule:");
    expect(fullWorkflow).toContain("          ref: ${{ inputs.source_sha }}");
    expect(fullWorkflow).not.toContain("          ref: main\n");
  });
  it("finishes canonical native asset verification before package tests", () => {
    const preparation = stepFor("await loadTailscaleAssets();");
    expect(preparation).toContain("node --input-type=module -e");
    expect(preparation).toContain(
      'import { loadTailscaleAssets } from "./apps/pages/scripts/tailscale-wasm-assets.mjs"',
    );
    expect(preparation).not.toMatch(
      /\n\s+if:|continue-on-error:|timeout-minutes:/,
    );
    const tests = stepFor("pnpm exec turbo run typecheck test");
    expect(fullSteps.indexOf(preparation)).toBeLessThan(
      fullSteps.indexOf(tests),
    );
    expect(preparation).not.toContain("cache-hit");
  });

  it("only looks up the exact native distribution pin before cold verification", () => {
    const cache = stepFor("name: Cache the pinned native PWA distribution");
    expect(cache).toContain(
      "actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25",
    );
    expect(cache).toContain(
      "path: .cache/pwa-tailscale-native-http/distributions\n",
    );
    expect(cache).toContain(
      "hashFiles('tools/pwa-tailscale-native-http/source.json', 'apps/pages/src/lib/capabilities/tailscale-artifacts.json')",
    );
    expect(cache).not.toContain("restore-keys:");
    expect(cache).not.toContain("/work");
    const preparation = stepFor("await loadTailscaleAssets();");
    expect(fullSteps.indexOf(cache)).toBeLessThan(
      fullSteps.indexOf(preparation),
    );
  });

  it("retains every package and both real Postgres contracts after preparation", () => {
    const tests = stepFor("pnpm exec turbo run typecheck test");
    expect(tests).not.toMatch(/--filter|continue-on-error:|\n\s+if:/);
    for (const command of [
      "pnpm --filter @opensesame/database test:postgres",
      "pnpm --filter @opensesame/identity-worker test:postgres",
    ]) {
      const postgres = stepFor(command);
      expect(postgres).toContain(
        "DATABASE_URL: postgres://opensesame:opensesame@127.0.0.1:5432/postgres",
      );
      expect(postgres).not.toMatch(/continue-on-error:|\n\s+if:/);
      expect(fullSteps.indexOf(tests)).toBeLessThan(
        fullSteps.indexOf(postgres),
      );
    }
    expect(fullWorkflow).toContain("timeout-minutes: 180");
    expect(fullWorkflow).not.toContain("--passWithNoTests");
  });
});

const scopedJob = ci
  .split("\n  typescript-build:\n")[1]
  .split("\n  rust-build:\n")[0];
const scopedSteps = scopedJob
  .split("    steps:\n")[1]
  .split(/\n {6}- (?=name:|uses:)/);
const pagesAffected =
  "steps.affected.outputs.scope == 'all' || contains(steps.affected.outputs.packages, '@opensesame/pages')";

function scopedStepFor(command) {
  const matches = scopedSteps.filter((step) => step.includes(command));
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("affected Pages build preparation", () => {
  it("selects a cold-build-capable runner before the package job starts", () => {
    const changes = ci.split("\n  typescript-build:\n")[0];
    const packages = changes
      .split("name: Select affected TypeScript packages")[1]
      .split("- name:")[0];
    expect(packages).toContain("id: packages");
    expect(packages).toContain(
      "run: node scripts/lib/ci-affected-builds.mjs plan-ts",
    );
    expect(packages).toContain("BASE_SHA:");
    expect(packages).toContain("HEAD_SHA:");
    expect(changes).toContain(
      `typescript_runner: \${{ (steps.packages.outputs.scope == 'all' || contains(steps.packages.outputs.packages, '@opensesame/pages')) && '\"ubuntu-latest\"' || steps.runner.outputs.linux }}`,
    );
    expect(scopedJob).toContain(
      "runs-on: ${{ fromJSON(needs.changes.outputs.typescript_runner) }}",
    );
  });

  it("restores exact-pin assets before the build that verifies and consumes them", () => {
    const cache = scopedStepFor(
      "name: Cache the pinned native PWA distribution",
    );
    expect(cache).toContain(`if: ${pagesAffected}`);
    expect(cache).toContain(
      "actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25",
    );
    expect(cache).toContain(
      "path: .cache/pwa-tailscale-native-http/distributions\n",
    );
    expect(cache).toContain(
      "key: pwa-native-distribution-${{ hashFiles('tools/pwa-tailscale-native-http/source.json', 'apps/pages/src/lib/capabilities/tailscale-artifacts.json') }}",
    );
    expect(cache).not.toMatch(/restore-keys:|\/work|continue-on-error:/);
    const install = scopedStepFor("run: pnpm install --frozen-lockfile");
    const build = scopedStepFor("ci-affected-builds.mjs run-ts");
    expect(scopedSteps.indexOf(install)).toBeLessThan(
      scopedSteps.indexOf(cache),
    );
    expect(scopedSteps.indexOf(cache)).toBeLessThan(scopedSteps.indexOf(build));
    expect(build).toContain("VITE_BASE: /OpenSesame/");
    expect(scopedJob).not.toMatch(
      /ci-affected-tests|pnpm quality|pnpm lint|pnpm typecheck|verify:|vitest/,
    );
  });
});

const completeWorkflow = readFileSync(
  join(root, ".github/workflows/complete-verify.yml"),
  "utf8",
);
const completeSteps = completeWorkflow
  .split("    steps:\n")[1]
  .split(/\n {6}- (?=name:|uses:)/);

function completeStepFor(command) {
  const matches = completeSteps.filter((step) => step.includes(command));
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("complete verify native preparation", () => {
  it("finishes canonical verification after install and before the complete gate", () => {
    const preparation = completeStepFor("await loadTailscaleAssets();");
    expect(preparation).toContain("node --input-type=module -e");
    expect(preparation).toContain(
      'import { loadTailscaleAssets } from "./apps/pages/scripts/tailscale-wasm-assets.mjs"',
    );
    expect(preparation).not.toMatch(
      /cache-hit|continue-on-error:|timeout-minutes:|\n\s+if:/,
    );
    expect(
      completeSteps.indexOf(completeStepFor("pnpm install --frozen-lockfile")),
    ).toBeLessThan(completeSteps.indexOf(preparation));
    expect(completeSteps.indexOf(preparation)).toBeLessThan(
      completeSteps.indexOf(completeStepFor("pnpm verify 2>&1")),
    );
  });

  it("only looks up the exact native distribution pin before the complete gate", () => {
    const cache = completeStepFor(
      "name: Cache the pinned native PWA distribution",
    );
    expect(cache).toContain(
      "actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25",
    );
    expect(cache).toContain(
      "path: .cache/pwa-tailscale-native-http/distributions\n",
    );
    expect(cache).toContain(
      "key: pwa-native-distribution-${{ hashFiles('tools/pwa-tailscale-native-http/source.json', 'apps/pages/src/lib/capabilities/tailscale-artifacts.json') }}",
    );
    expect(cache).not.toMatch(
      /restore-keys:|\/work|continue-on-error:|\n\s+if:/,
    );
    expect(completeSteps.indexOf(cache)).toBeLessThan(
      completeSteps.indexOf(completeStepFor("await loadTailscaleAssets();")),
    );
  });
});

describe("lookup-only qualification caches", () => {
  it("never schedules a cache save while retaining the lookup", () => {
    const workflows = [
      ["ci-coverage.yml", 0, 1],
      ["ci-prerelease-checks.yml", 3, 3],
      ["ci-release-checks.yml", 0, 2],
      ["complete-verify.yml", 1, 0],
      ["full-suite.yml", 1, 0],
      ["password-parity.yml", 0, 1],
    ];
    for (const [filename, directCount, rustCount] of workflows) {
      const source = readFileSync(
        join(root, ".github/workflows", filename),
        "utf8",
      );
      const steps = source.split(/\n {6}- (?=name:|uses:)/);
      const lookup = steps.filter((step) => step.includes("lookup-only: true"));
      const direct = lookup.filter((step) =>
        step.includes("actions/cache/restore@"),
      );
      const rust = lookup.filter((step) =>
        step.includes("Swatinem/rust-cache@"),
      );
      expect(direct, filename).toHaveLength(directCount);
      expect(rust, filename).toHaveLength(rustCount);
      expect(lookup, filename).toHaveLength(directCount + rustCount);
      for (const step of rust)
        expect(step, filename).toContain("save-if: false");
    }
  });
});
