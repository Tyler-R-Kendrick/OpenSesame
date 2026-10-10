import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PHONES,
  TABLETS,
} from "../../apps/pages/scripts/lib/mobile-contract.mjs";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { loadShards } from "./ci-gates.mjs";

const root = repoRootFromHere();
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
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
  "verify:keyboard",
  "verify:push-worker",
  "verify:mobile",
  "verify:local-iam",
  "verify:siop",
  "verify:static",
  "verify:encrypted-search",
  "verify:auth",
  "verify:customer-vault-browser",
  "verify-experience-journeys.mjs",
  "verify:relay-join-live",
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

  it("keeps every shard well inside its own timeout, a fraction of the serial job's", () => {
    const limit = Number(/timeout-minutes: (\d+)/.exec(bundle)?.[1]);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(15);
  });

  it("runs every gate in exactly one shard (verify:mobile in its viewport shards), and gives every shard something to run", () => {
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
