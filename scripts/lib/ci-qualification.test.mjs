import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const read = (name) =>
  readFileSync(join(root, ".github/workflows", name), "utf8");
const source = read("ci.yml");
const prerelease = read("ci-prerelease-checks.yml");
const dev = read("ci-dev-checks.yml");

function jobs(text) {
  return Object.fromEntries(
    [
      ...text
        .split("\njobs:\n")[1]
        .matchAll(
          /^ {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/gm,
        ),
    ].map((match) => [match[1], match[2]]),
  );
}

function dependencies(text) {
  return (
    /needs: \[([^\]]+)\]/
      .exec(text)?.[1]
      .split(",")
      .map((value) => value.trim()) ?? []
  );
}

describe("integration compiles only the impacted graph", () => {
  it("runs one build per language and retains the protected check names", () => {
    const fast = jobs(source);
    expect(Object.keys(fast)).toEqual([
      "changes",
      "typescript-build",
      "rust-build",
      "typescript",
      "bundle-check",
      "rust-check",
    ]);
    expect(fast["typescript-build"]).toContain(
      "node scripts/lib/ci-affected-builds.mjs run-ts",
    );
    expect(fast["rust-build"]).toContain(
      "node scripts/lib/ci-affected-builds.mjs run-cargo",
    );
    expect(dependencies(fast.typescript)).toEqual([
      "changes",
      "typescript-build",
    ]);
    expect(dependencies(fast["bundle-check"])).toEqual([
      "changes",
      "typescript-build",
    ]);
    expect(dependencies(fast["rust-check"])).toEqual(["changes", "rust-build"]);
    for (const name of ["TypeScript", "Rust", "Bundle budgets"]) {
      expect(source).toContain(`name: ${name}\n`);
    }
  });

  it("never turns tests, static analysis or browser qualification into a trunk gate", () => {
    const commands = source
      .split(/\n {6}- /)
      .filter((step) => /\n {8}run:/.test(step))
      .map((step) => step.split(/\n {8}run:/)[1])
      .join("\n");
    expect(commands).not.toMatch(
      /ci-affected-tests|\b(?:test|typecheck|lint|quality|verify|audit)(?::|\b)|vitest|playwright|clippy|rustfmt|bundle-budget|evidence-gate|repository-size-gate|sync-agent-skills|check-(?:pr|merge-group)-signature/,
    );
    expect(source).not.toContain("services:");
    expect(source).not.toContain("bundle_matrix:");
    expect(source).not.toContain("--all-targets");
    expect(source).not.toContain("uses: ./.github/workflows/");
  });

  it("shares one cumulative diff between planning and both build jobs", () => {
    const fast = jobs(source);
    expect(fast.changes).toContain("ci-main-baseline.mjs");
    expect(fast.changes).toContain(
      "BASE_SHA: ${{ steps.scope.outputs.base_sha }}",
    );
    expect(fast.changes).toContain(
      "HEAD_SHA: ${{ steps.scope.outputs.head_sha }}",
    );
    for (const command of ["plan-ts", "plan-cargo"]) {
      expect(fast.changes).toContain(
        `node scripts/lib/ci-affected-builds.mjs ${command}`,
      );
    }
    for (const job of [fast["typescript-build"], fast["rust-build"]]) {
      expect(job).toContain("BASE_SHA: ${{ needs.changes.outputs.base_sha }}");
      expect(job).toContain("HEAD_SHA: ${{ needs.changes.outputs.head_sha }}");
      expect(job).not.toContain("github.event.before");
    }
  });
});

describe("complete candidate qualification preserves coverage", () => {
  it("retains all original CI jobs and every auxiliary qualification", () => {
    const full = jobs(prerelease);
    for (const id of [
      "changes",
      "typescript-tests",
      "bundle",
      "ai-connections-e2e",
      "tailnet-browser-node-e2e",
      "device-inbox",
      "push-e2e",
      "device-identity-e2e",
      "tutorials-e2e",
      "live-join-e2e",
      "rust",
      "android-native",
      "apple-native",
      "mtls",
      "typescript",
      "bundle-check",
      "rust-check",
      "complete-verify",
      "native-platform",
      "password-parity",
      "container",
      "native-wasm",
      "autofill-browser",
      "sync-target-security",
      "coverage",
    ])
      expect(full[id], id).toBeDefined();
    expect(full.changes).toContain("needs: admission");
    expect(full.changes).toContain("BASE_SHA: ''");
    expect(full.changes).toContain("HEAD_SHA: ''");
    expect(full["typescript-tests"]).toContain("ref: ${{ inputs.source_sha }}");
    expect(full.rust).toContain("ref: ${{ inputs.source_sha }}");
    expect(full["typescript-tests"]).toContain("timeout-minutes: 180");
    for (const profile of [
      "minimal-local-hardened",
      "family-local-hardened",
      "enterprise-selected-hardened",
      "rich-explicit-selective",
    ]) {
      expect(full.bundle).toContain(
        `test -s apps/pages/dist-profiles/${profile}/index.html`,
      );
    }
  });
});

describe("candidate qualification records successful immutable-artifact checks", () => {
  it.each([
    ["dev", dev],
    ["prerelease", prerelease],
  ])(
    "%s gate requires every declared job before recording evidence",
    (stage, workflow) => {
      const all = jobs(workflow);
      const required = Object.keys(all).filter(
        (id) => !["gate", "receipt"].includes(id),
      );
      expect(dependencies(all.gate).sort()).toEqual(required.sort());
      expect(all.gate).toContain("if: always()");
      expect(all.gate).toContain("ci-required-result.mjs all");
      expect(dependencies(all.receipt)).toEqual(["admission", "gate"]);
      expect(all.receipt).not.toContain("if: always()");
      expect(all.receipt).toContain(`receipt --stage ${stage}`);
      expect(all.receipt).toContain("if-no-files-found: error");
      expect(workflow).not.toContain("continue-on-error");
    },
  );
  it("runs all TypeScript packages and real database contracts nightly", () => {
    expect(jobs(dev)["source-tests"]).toContain(
      "uses: ./.github/workflows/full-suite.yml",
    );
    expect(jobs(dev)["source-tests"]).toContain(
      "source_sha: ${{ inputs.source_sha }}",
    );
  });
  it.each([dev, prerelease])(
    "executes stored native and Pages artifacts without replacing them with source builds",
    (workflow) => {
      const smoke = jobs(workflow)["artifact-smoke"];
      expect(smoke).toContain("target: x86_64-unknown-linux-gnu");
      expect(smoke).toContain("target: aarch64-unknown-linux-gnu");
      expect(smoke).toContain('smoke-kit.sh "$KIT_ARCHIVE"');
      expect(smoke).toContain(
        'archive-safe.py tar "$PAGES_ARCHIVE" apps/pages/dist',
      );
      expect(smoke).toContain("verify:static");
      expect(smoke).toContain("verify:sw-dirty-edit");
      expect(smoke).toContain("verify:push-worker");
      expect(smoke).not.toMatch(
        /ci-pages-build|turbo run build|cargo (?:build|test)|build:profile/,
      );
      expect(smoke).toContain(
        'cmp "$RUNNER_TEMP/pages-before.sha256" "$RUNNER_TEMP/pages-after.sha256"',
      );
      expect(smoke).toContain("path: .ci-control");
      expect(smoke).toContain("ref: ${{ github.workflow_sha }}");
      expect(smoke).toContain("ref: ${{ inputs.source_sha }}");
    },
  );
});

describe("upstream CI execution contracts survive tier migration", () => {
  it.each([
    ["password-parity.yml", "pnpm test:2password-parity"],
    ["complete-verify.yml", "pnpm verify 2>&1"],
  ])("prepares DBus before the complete native gate in %s", (file, command) => {
    const workflow = read(file);
    expect(workflow).toContain(
      'bash scripts/ci/prepare-dbus.sh "$RUNNER_TEMP/opensesame-dbus"',
    );
    const step = workflow
      .split(/\n {6}- /)
      .find((value) => value.includes(command));
    expect(step).toContain('source "$RUNNER_TEMP/opensesame-dbus/env.sh"');
    expect(workflow).not.toContain("sudo");
  });
  it("prepares rootless DBus for prerelease Rust tests", () => {
    const rust = jobs(prerelease).rust;
    expect(rust).toContain(
      'bash scripts/ci/prepare-dbus.sh "$RUNNER_TEMP/opensesame-dbus"',
    );
    expect(rust).not.toContain("sudo");
    const steps = rust.split(/\n {6}- /);
    for (const command of [
      "node scripts/lib/ci-affected-tests.mjs run-cargo",
      "cargo test -p opensesame-gateway -p opensesame-cli --features bitwarden-compat bitwarden",
    ]) {
      const matches = steps.filter((step) => step.includes(command));
      expect(matches).toHaveLength(1);
      const setup = 'source "$RUNNER_TEMP/opensesame-dbus/env.sh"';
      expect(matches[0]).toContain(setup);
      expect(matches[0].indexOf(setup)).toBeLessThan(
        matches[0].indexOf(command),
      );
    }
  });
  it("keeps journey compilation setup and measured header evidence in prerelease", () => {
    const steps = jobs(prerelease).bundle.split(/\n {6}- /);
    const preparation = steps.find((step) => step.includes("prepare-dbus.sh"));
    const compile = steps.find((step) => step.includes("cargo +1.88.0 build"));
    expect(preparation).toContain("if: matrix.shard == 'journeys-1'");
    expect(compile).toContain('source "$RUNNER_TEMP/opensesame-dbus/env.sh"');
    expect(steps.indexOf(preparation)).toBeLessThan(steps.indexOf(compile));
    const measure = steps.find((step) => step.includes("verify:header-layout"));
    const evidence = steps.find((step) =>
      step.includes("name: Preserve measured header geometry"),
    );
    expect(measure).toContain(
      "PAGES_VERIFY_OUT: ${{ runner.temp }}/header-layout",
    );
    expect(evidence).toContain("if: always() && matrix.shard == 'mobile-320'");
    expect(evidence).toContain("name: header-layout-${{ inputs.source_sha }}");
    expect(evidence).toContain("path: ${{ runner.temp }}/header-layout/");
  });
  it.each([
    [
      "autofill-browser",
      "pnpm --filter @opensesame/browser-extension-autofill test:e2e",
    ],
    ["sync-target-security", "sync-target"],
  ])(
    "requires %s on the exact candidate without an automatic trunk trigger",
    (id, command) => {
      const workflow = read(`${id}.yml`);
      const candidate = jobs(prerelease)[id];
      expect(candidate).toContain("needs: admission");
      expect(candidate).toContain(`uses: ./.github/workflows/${id}.yml`);
      expect(candidate).toContain("source_sha: ${{ inputs.source_sha }}");
      expect(workflow).toContain(
        "  workflow_call:\n    inputs:\n      source_sha:",
      );
      expect(workflow).toContain("required: true");
      expect(workflow).not.toMatch(
        /^ {2}(?:pull_request|pull_request_target|push|merge_group):/m,
      );
      expect(workflow).toContain("inputs.source_sha");
      expect(workflow).toContain(command);
      expect(workflow).not.toContain("continue-on-error");
    },
  );
  it("keeps release candidates on GitHub-hosted runners", () => {
    expect(jobs(prerelease).changes).toContain(
      '[ "$EVENT" = "pull_request" ] && [ "$HEAD_REPO" = "$REPO" ]',
    );
  });
});
