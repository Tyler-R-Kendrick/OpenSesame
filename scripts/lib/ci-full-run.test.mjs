import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { loadShards } from "./ci-gates.mjs";

const root = repoRootFromHere();
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

function selector(env) {
  const out = execFileSync(
    "node",
    [join(root, "scripts/lib/ci-changed-areas.mjs")],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
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

  it("gives the TypeScript job the time a whole-suite run takes on a slow runner", () => {
    // A lockfile or manifest change plans every package. Current main's serial
    // app-core and Pages workload needs its 180-minute job budget; individual
    // test deadlines remain unchanged.
    const minutes =
      /\n {2}typescript-tests:\n[\s\S]*?timeout-minutes: (\d+)/.exec(ci);
    expect(Number(minutes?.[1])).toBeGreaterThanOrEqual(180);
  });

  it("verifies pull-request signatures only on a pull request", () => {
    const step = ci
      .split("name: Verify merge-required commit signatures")[1]
      ?.split("- name:")[0];
    expect(step).toContain("if: github.event_name == 'pull_request'");
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

  it("tests every package and crate when it has no base to diff against", () => {
    for (const command of ["plan", "cargo"]) {
      const out = execFileSync(
        "node",
        [join(root, "scripts/lib/ci-affected-tests.mjs"), command],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
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

  it("reuses only exact-pin static distributions and still verifies cache hits", () => {
    const cache = stepFor("name: Cache the pinned native PWA distribution");
    expect(cache).toContain(
      "actions/cache@caa296126883cff596d87d8935842f9db880ef25",
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
  .split("\n  typescript-tests:\n")[1]
  .split("\n  bundle:\n")[0];
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

describe("affected Pages native preparation", () => {
  it("selects a cold-build-capable runner before the package job starts", () => {
    const changes = ci.split("\n  typescript-tests:\n")[0];
    const packages = changes
      .split("name: Select affected TypeScript packages")[1]
      .split("- name:")[0];
    expect(packages).toContain("id: packages");
    expect(packages).toContain(
      "run: node scripts/lib/ci-affected-tests.mjs plan",
    );
    expect(packages).toContain("BASE_SHA:");
    expect(packages).toContain("HEAD_SHA:");
    expect(changes).toContain(
      `typescript_runner: \${{ (steps.packages.outputs.scope == 'all' || contains(steps.packages.outputs.packages, '@opensesame/pages')) && '"ubuntu-latest"' || steps.runner.outputs.linux }}`,
    );
    expect(scopedJob).toContain(
      "runs-on: ${{ fromJSON(needs.changes.outputs.typescript_runner) }}",
    );
  });

  it("finishes verified preparation before quality and both scoped test lanes", () => {
    const install = scopedStepFor("run: pnpm install --frozen-lockfile");
    const preparation = scopedStepFor("await loadTailscaleAssets();");
    expect(preparation).toContain(`if: ${pagesAffected}`);
    expect(preparation).toContain("node --input-type=module -e");
    expect(preparation).toContain(
      'import { loadTailscaleAssets } from "./apps/pages/scripts/tailscale-wasm-assets.mjs"',
    );
    expect(preparation).not.toMatch(
      /cache-hit|continue-on-error:|timeout-minutes:|skipIf/,
    );
    expect(scopedSteps.indexOf(install)).toBeLessThan(
      scopedSteps.indexOf(preparation),
    );
    for (const command of [
      "run: pnpm quality",
      "ci-affected-tests.mjs run-ts",
    ]) {
      expect(scopedSteps.indexOf(preparation)).toBeLessThan(
        scopedSteps.indexOf(scopedStepFor(command)),
      );
    }
  });

  it("restores only the exact static distribution and verifies cache hits", () => {
    const cache = scopedStepFor(
      "name: Cache the pinned native PWA distribution",
    );
    expect(cache).toContain(`if: ${pagesAffected}`);
    expect(cache).toContain(
      "actions/cache@caa296126883cff596d87d8935842f9db880ef25",
    );
    expect(cache).toContain(
      "path: .cache/pwa-tailscale-native-http/distributions\n",
    );
    expect(cache).toContain(
      "key: pwa-native-distribution-${{ hashFiles('tools/pwa-tailscale-native-http/source.json', 'apps/pages/src/lib/capabilities/tailscale-artifacts.json') }}",
    );
    expect(cache).not.toMatch(/restore-keys:|\/work|continue-on-error:/);
    expect(scopedSteps.indexOf(cache)).toBeLessThan(
      scopedSteps.indexOf(scopedStepFor("await loadTailscaleAssets();")),
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

  it("caches only exact-pin static distributions and still verifies cache hits", () => {
    const cache = completeStepFor(
      "name: Cache the pinned native PWA distribution",
    );
    expect(cache).toContain(
      "actions/cache@caa296126883cff596d87d8935842f9db880ef25",
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
