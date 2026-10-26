import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PHONES,
  TABLETS,
} from "../../apps/pages/scripts/lib/mobile-contract.mjs";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { DRIVER_GATES, bundleMatrix, loadShards } from "./ci-gates.mjs";

const root = repoRootFromHere();
const ci = readFileSync(
  join(root, ".github/workflows/ci-prerelease-checks.yml"),
  "utf8",
);
const bundle = ci.split("  bundle:")[1]?.split("  device-inbox:")[0] ?? "";

/** The matrix legs, in order: `{ shard, sizes? }`. */
function legs() {
  return loadShards(root);
}

/** The job's steps with the `if:` each carries. */
function steps() {
  return (bundle.split("    steps:\n")[1] ?? "")
    .split(/\n {6}- (?=name:|uses:)/)
    .map((step) => ({
      text: step,
      when: /\n\s+if: ([^\n]+)/.exec(step)?.[1],
    }));
}

/** Every gate the shards between them have to run, each exactly once. */
const GATES = [
  "bundle-budget-gate.mjs",
  "build:profile \\\n            --profile capability-profiles/enterprise-selected.json",
  "verify:webmcp",
  "verify:self-hosted-connectors",
  "verify:native-connectors",
  "verify:native-public-protocol",
  "verify:provider-auth",
  "build:identity-verify",
  "verify:identity-connections",
  "build:secret-backends-verify",
  "verify:secret-backends",
  "verify:github-app-browser",
  "verify:keyboard",
  "verify:push-worker",
  "verify:sw-dirty-edit",
  "verify:mobile",
  "verify:header-layout",
  "verify:local-iam",
  "verify:quorum-browser",
  "verify:siop",
  "verify:static",
  "verify:encrypted-search",
  "verify:portable-drop",
  "verify:auth",
  "verify:trusted-unlock",
  "verify:customer-vault-browser",
  "verify-experience-journeys.mjs",
  "verify:relay-join-live",
  "verify:live-local-pair",
  "verify:peer-trust-two-context",
  "verify:peering-diagnostics",
  "verify:fresh-vault-login",
  "verify:cli-public-site",
];

/** The shards a step's `if:` selects: the union of its `||` clauses. */
function shardsOf(when, shards) {
  if (!when) return shards;
  const picked = new Set();
  for (const clause of when.split("||").map((part) => part.trim())) {
    const startsWith = /^startsWith\(matrix\.shard, '([^']+)'\)$/.exec(
      clause,
    )?.[1];
    const only = /^matrix\.shard == '([^']+)'$/.exec(clause)?.[1];
    const not = /^matrix\.shard != '([^']+)'$/.exec(clause)?.[1];
    if (startsWith) {
      for (const name of shards)
        if (name.startsWith(startsWith)) picked.add(name);
    } else if (only) {
      picked.add(only);
    } else if (not) {
      for (const name of shards) if (name !== not) picked.add(name);
    } else {
      throw new Error(`unreadable shard condition: ${clause}`);
    }
  }
  return shards.filter((name) => picked.has(name));
}

function assertGateCoverage(shards) {
  const all = steps();
  for (const gate of GATES) {
    const running = all.filter((step) => step.text.includes(gate));
    expect(running.length, `${gate} runs in ${running.length} steps`).toBe(1);
    const where = shardsOf(running[0].when, shards);
    // `verify:mobile` (by viewport) and the journeys (in turn) are split across shards.
    const split = {
      "verify:mobile": "mobile-",
      "verify-experience-journeys.mjs": "journeys-",
    }[gate];
    const expected = split
      ? shards.filter((name) => name.startsWith(split))
      : where.slice(0, 1);
    expect(where, `${gate} runs in ${where.join(", ")}`).toEqual(expected);
    expect(where.length).toBeGreaterThan(0);
    for (const name of where) expect(shards).toContain(name);
  }
  for (const shard of shards) {
    const selected = all.filter(
      (step) =>
        step.when &&
        step.text.includes("run:") &&
        shardsOf(step.when, shards).includes(shard) &&
        !step.text.includes("ci-pages-build.mjs"),
    );
    expect(selected.length, `${shard} runs no gate`).toBeGreaterThan(0);
  }
}

describe("the bundle job's shards", () => {
  const shards = legs().map((leg) => leg.shard);

  it("is a matrix of parallel shards that the required check reads across", () => {
    expect(shards.length).toBeGreaterThan(1);
    expect(new Set(shards).size).toBe(shards.length);
    expect(bundle).toContain("fail-fast: false");
    expect(bundle).toContain("needs: changes");
    // The legs come from the shard file, narrowed to the gates the diff reaches;
    // a diff that reaches none skips the job, which the check reads as passing.
    expect(bundle).toContain("needs.changes.outputs.bundle_matrix != '[]'");
    expect(bundle).toContain(
      "include: ${{ fromJSON(needs.changes.outputs.bundle_matrix) }}",
    );
    // A matrix job's result is the worst of its legs.
    const check =
      ci.split("  bundle-check:")[1]?.split("  rust-check:")[0] ?? "";
    expect(check).toContain('heavy="${{ needs.bundle.result }}"');
    expect(check).toContain("bundle tests result");
  });

  it("gives the public protocol walks 30 minutes and keeps every other shard at 15", () => {
    const deadline =
      /timeout-minutes: \$\{\{ matrix\.shard == '([^']+)' && (\d+) \|\| (\d+) \}\}/.exec(
        bundle,
      );
    expect(deadline).not.toBeNull();
    const [, extendedShard, extendedMinutes, defaultMinutes] = deadline;
    expect(extendedShard).toBe("native-public-protocol");
    expect(Number(extendedMinutes)).toBe(30);
    expect(Number(defaultMinutes)).toBe(15);
    expect(legs().some((leg) => leg.shard === extendedShard)).toBe(true);
  });

  it("runs every gate in exactly one shard (verify:mobile in its viewport shards), and gives every shard something to run", () => {
    assertGateCoverage(shards);
  });

  it("builds Pages once in every shard, and in `budgets` inside the measuring step", () => {
    const all = steps();
    const builds = all.filter((step) =>
      step.text.includes("ci-pages-build.mjs"),
    );
    for (const shard of shards) {
      const building = builds.filter((step) =>
        shardsOf(step.when, shards).includes(shard),
      );
      expect(building.length, `${shard} builds ${building.length} times`).toBe(
        1,
      );
    }
  });

  it("splits verify:mobile across disjoint shards that between them walk every size", () => {
    const named = legs().filter((leg) => leg.sizes !== undefined);
    expect(named.length).toBeGreaterThan(1);
    const walked = named.flatMap((leg) => leg.sizes.split(","));
    const every = [...PHONES, ...TABLETS].map((size) => size.name);
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual([...every].sort());
    // Every `mobile-` shard names its sizes, and nothing else does.
    for (const leg of legs()) {
      expect(leg.shard.startsWith("mobile-")).toBe(leg.sizes !== undefined);
    }
    expect(bundle).toContain("MOBILE_SIZES: ${{ matrix.sizes }}");
  });

  it("splits the experience journeys into legs that between them run every walk once", () => {
    const named = legs().filter((leg) => leg.journeys !== undefined);
    const counts = named.map((leg) => Number(leg.journeys.split("/")[1]));
    expect(named.length).toBeGreaterThan(1);
    expect(new Set(counts).size).toBe(1);
    expect(named.map((leg) => leg.journeys).sort()).toEqual(
      named.map((_, i) => `${i + 1}/${counts[0]}`),
    );
    for (const leg of named) expect(leg.shard).toMatch(/^journeys-\d+$/);
    expect(bundle).toContain("EXPERIENCE_SHARD: ${{ matrix.journeys }}");
  });
});

it("runs the self-hosted connector contract in budgets with the static build and Chromium", () => {
  const matching = steps().filter((step) =>
    step.text.includes("verify:self-hosted-connectors"),
  );
  expect(matching).toHaveLength(1);
  expect(
    shardsOf(
      matching[0].when,
      legs().map((leg) => leg.shard),
    ),
  ).toEqual(["budgets"]);
  expect(matching[0].text).toContain(
    "PLAYWRIGHT_CHROMIUM: /usr/bin/google-chrome",
  );
  expect(matching[0].text).toContain("VITE_BASE: /OpenSesame/");
});

it("selects both native protocol legs for secret backend and public protocol changes", () => {
  for (const driver of [
    "verify-secret-backends.mjs",
    "verify-native-public-protocol.mjs",
  ])
    expect(
      bundleMatrix(DRIVER_GATES[driver], legs()).map((leg) => leg.shard),
    ).toEqual(["native-public-protocol", "native-secret-backends"]);
});

it("runs the unchanged whole secret backend profile and driver in an independent leg", () => {
  const all = steps();
  for (const command of [
    "build:secret-backends-verify",
    "verify:secret-backends",
  ])
    expect(
      shardsOf(
        all.find((step) => step.text.includes(command)).when,
        legs().map((leg) => leg.shard),
      ),
    ).toEqual(["native-secret-backends"]);
  const secret = all.find((step) =>
    step.text.includes("verify:secret-backends"),
  );
  expect(secret.text).toContain(
    "pnpm --filter @opensesame/pages build:secret-backends-verify\n          pnpm --filter @opensesame/pages verify:secret-backends",
  );
  expect(secret.text).toContain("PLAYWRIGHT_CHROMIUM: /usr/bin/google-chrome");
  expect(secret.text).toContain("VITE_BASE: /OpenSesame/");
  for (const command of [
    "verify:native-public-protocol",
    "verify:provider-auth",
    "build:identity-verify",
    "verify:identity-connections",
  ])
    expect(
      shardsOf(
        all.find((step) => step.text.includes(command)).when,
        legs().map((leg) => leg.shard),
      ),
    ).toEqual(["native-public-protocol"]);
});

it("runs trusted-contact unlock in the auth shard and selects it for driver edits", () => {
  const matching = steps().filter((step) =>
    step.text.includes("verify:trusted-unlock"),
  );
  expect(matching).toHaveLength(1);
  expect(
    shardsOf(
      matching[0].when,
      legs().map((leg) => leg.shard),
    ),
  ).toEqual(["auth"]);
  expect(matching[0].text).toContain(
    "PLAYWRIGHT_CHROMIUM: /usr/bin/google-chrome",
  );
  expect(matching[0].text).toContain("VITE_BASE: /OpenSesame/");
  expect(DRIVER_GATES["verify-trusted-unlock.mjs"]).toEqual(["auth"]);
  expect(
    bundleMatrix(DRIVER_GATES["verify-trusted-unlock.mjs"], legs()).map(
      (leg) => leg.shard,
    ),
  ).toEqual(["auth"]);
});

it("gives only the GitHub App walk a fresh command-local evidence directory", () => {
  const matching = steps().filter((step) =>
    step.text.includes("verify:github-app-browser"),
  );
  expect(matching).toHaveLength(1);
  expect(matching[0].when).toBe("matrix.shard == 'native-secret-backends'");
  const [environment, commands] = matching[0].text.split("        run: |\n");
  expect(environment).not.toContain("PAGES_VERIFY_OUT:");
  expect(
    commands
      .trim()
      .split("\n")
      .map((line) => line.trim()),
  ).toEqual([
    "pnpm --filter @opensesame/pages build:secret-backends-verify",
    "pnpm --filter @opensesame/pages verify:secret-backends",
    "PAGES_VERIFY_OUT=${{ runner.temp }}/github-app-browser GITHUB_APP_VERIFY_PHASE=after pnpm --filter @opensesame/pages verify:github-app-browser",
  ]);
});

it("preserves only reviewed GitHub evidence after success or failure, excluding encrypted downloads", () => {
  const matching = steps().filter((step) =>
    step.text.includes("Preserve GitHub App browser evidence"),
  );
  expect(matching).toHaveLength(1);
  const upload = matching[0];
  expect(upload.when).toBe(
    "always() && matrix.shard == 'native-secret-backends'",
  );
  expect(upload.text).toContain(
    "uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6.0.0",
  );
  expect(upload.text).toContain(
    "name: github-app-browser-${{ inputs.source_sha }}",
  );
  const paths = /path: \|\n([\s\S]*?) {10}if-no-files-found:/.exec(
    upload.text,
  )?.[1];
  expect(
    paths
      ?.trim()
      .split("\n")
      .map((line) => line.trim()),
  ).toEqual([
    "${{ runner.temp }}/github-app-browser/receipt.json",
    "${{ runner.temp }}/github-app-browser/progress.json",
    "${{ runner.temp }}/github-app-browser/after-*.png",
    "${{ runner.temp }}/github-app-browser/after-*.json",
    "${{ runner.temp }}/github-app-browser/failure-*.png",
    "!${{ runner.temp }}/github-app-browser/*.encrypted.json",
  ]);
  expect(upload.text).toContain("if-no-files-found: warn");
  expect(upload.text).toContain("retention-days: 14");
});
