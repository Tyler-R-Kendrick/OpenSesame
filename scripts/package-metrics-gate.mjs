#!/usr/bin/env node
/**
 * Component-coupling gate -- the `pnpm quality:packages` gate.
 *
 * Scores both release planes against Robert C. Martin's component principles
 * (see scripts/lib/martin-metrics.mjs for the definitions) and enforces the
 * two that are objectively checkable:
 *
 *   ADP  a dependency cycle is always a defect -- hard failure, no baseline.
 *        Cycles make the components inseparable: they cannot be built, tested,
 *        versioned or released independently, which dissolves the very thing
 *        that makes them components.
 *
 *   phantom dependencies  a package that imports @opensesame/x without
 *        declaring it -- hard failure. It resolves today only because pnpm's
 *        store happens to hoist it, and it breaks the moment the graph shifts.
 *
 * SDP violations and unused declared dependencies are real but negotiable, so
 * they ratchet against package-metrics-baseline.json exactly the way
 * scripts/quality-gate.mjs ratchets structural debt: the recorded set may
 * shrink, never grow.
 *
 * SAP (A + I ~= 1) is reported, not gated -- abstractness is measured
 * syntactically here, which is good enough to spot a component sliding into
 * the zone of pain but not to fail a merge over.
 *
 * Usage:
 *   node scripts/package-metrics-gate.mjs            # check
 *   node scripts/package-metrics-gate.mjs --update   # re-record the baseline
 *   node scripts/package-metrics-gate.mjs --report   # full I/A/D table
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  couplings,
  cycles,
  mainSequenceDistance,
  sdpViolations,
} from "./lib/martin-metrics.mjs";
import {
  abstractness,
  rustComponents,
  typescriptComponents,
} from "./lib/workspace-graph.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "package-metrics-baseline.json");
const args = new Set(process.argv.slice(2));
const update = args.has("--update");
const report = args.has("--report");

const planes = [
  { id: "typescript", components: typescriptComponents(root) },
  { id: "rust", components: rustComponents(root) },
];

const findings = { cycles: [], phantom: [], sdp: [], unused: [] };
const rows = [];

/**
 * Compares what a package's source actually imports against what its manifest
 * declares. Rust needs no equivalent: rustc already refuses a `use` of a crate
 * that is not a declared dependency.
 */
function auditTypescriptImports(components) {
  const internal = new Set(components.map((component) => component.name));
  for (const component of components) {
    const declared = new Set([...component.deps, ...component.devDeps]);
    const imported = importedPackages(component, internal);
    for (const name of [...imported].sort()) {
      if (name === component.name || declared.has(name)) continue;
      findings.phantom.push({ from: component.name, to: name });
    }
    for (const name of [...declared].sort()) {
      if (!internal.has(name) || imported.has(name)) continue;
      findings.unused.push({ from: component.name, to: name });
    }
  }
}

const IMPORT_SPECIFIER =
  /(?:from|import|require)\s*\(?\s*["'](?<specifier>@opensesame\/[^"'/]+)/g;

function importedPackages(component, internal) {
  const found = new Set();
  for (const extension of ["ts", "tsx", "mts", "cts", "js", "mjs"]) {
    for (const file of globSync(`${component.dir}/**/*.${extension}`, {
      cwd: root,
      exclude: (entry) =>
        entry === "node_modules" || entry === "dist" || entry === ".wxt",
    })) {
      const source = readFileSync(join(root, file), "utf8");
      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const name = match.groups.specifier;
        if (internal.has(name)) found.add(name);
      }
    }
  }
  return found;
}

function score() {
  for (const plane of planes) {
    const metrics = couplings(plane.components);

    for (const cycle of cycles(plane.components)) {
      findings.cycles.push({ plane: plane.id, ...cycle });
    }
    for (const violation of sdpViolations(plane.components, metrics)) {
      findings.sdp.push({ plane: plane.id, ...violation });
    }
    for (const component of plane.components) {
      const surface = abstractness(root, component);
      const { ca, ce, instability } = metrics.get(component.name);
      rows.push({
        plane: plane.id,
        name: component.name,
        ca,
        ce,
        instability,
        abstractness: surface.value,
        distance: mainSequenceDistance(surface.value, { ca, ce }),
      });
    }
    if (plane.id === "typescript") auditTypescriptImports(plane.components);
  }
}

score();

/* ---------- reporting ---------- */

if (report) {
  console.log(
    "\nComponent metrics -- Ca afferent, Ce efferent, I instability, A abstractness (syntactic), D distance from main sequence\n",
  );
  for (const plane of planes) {
    console.log(`  ${plane.id}`);
    console.log(
      `  ${"component".padEnd(42)}${"Ca".padStart(4)}${"Ce".padStart(4)}${"I".padStart(7)}${"A".padStart(7)}${"D".padStart(7)}`,
    );
    for (const row of rows
      .filter((candidate) => candidate.plane === plane.id)
      .sort((a, b) => (b.distance ?? -1) - (a.distance ?? -1))) {
      const distance = row.distance === null ? "n/a" : row.distance.toFixed(2);
      console.log(
        `  ${row.name.padEnd(42)}${String(row.ca).padStart(4)}${String(row.ce).padStart(4)}${row.instability.toFixed(2).padStart(7)}${row.abstractness.toFixed(2).padStart(7)}${distance.padStart(7)}`,
      );
    }
    console.log("");
  }
}

/* ---------- ratchet ---------- */

const edgeKey = (finding) =>
  `${finding.plane ?? "typescript"}: ${finding.from} -> ${finding.to}`;
const measured = {
  sdp: findings.sdp.map(edgeKey).sort(),
  unused: findings.unused.map(edgeKey).sort(),
};

function readBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
    return { sdp: parsed.sdp ?? [], unused: parsed.unused ?? [] };
  } catch {
    return { sdp: [], unused: [] };
  }
}

if (update) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        $comment: [
          "Accepted component-coupling debt -- see scripts/package-metrics-gate.mjs.",
          "These lists may only ever SHRINK. Regenerate with:",
          "  pnpm quality:packages --update",
          "sdp:    edges that depend toward instability (Martin's SDP).",
          "unused: declared workspace dependencies nothing imports (CRP/REP).",
        ],
        totals: { sdp: measured.sdp.length, unused: measured.unused.length },
        ...measured,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `package metrics: baseline updated -- ${measured.sdp.length} SDP, ${measured.unused.length} unused`,
  );
}

const baseline = readBaseline();
const failures = [];

if (findings.cycles.length > 0) {
  failures.push(
    `ADP -- ${findings.cycles.length} dependency cycle(s):\n${findings.cycles
      .map(
        (cycle) =>
          `      ${cycle.plane}: ${cycle.example.join(" -> ")}${cycle.members.length > cycle.example.length - 1 ? `\n        (cycle group: ${cycle.members.join(", ")})` : ""}`,
      )
      .join("\n")}`,
  );
}
if (findings.phantom.length > 0) {
  failures.push(
    `Phantom dependencies -- ${findings.phantom.length} import(s) of an undeclared workspace package:\n${findings.phantom
      .map(
        (edge) => `      ${edge.from} imports ${edge.to} (not in package.json)`,
      )
      .join("\n")}`,
  );
}

for (const [kind, label] of [
  ["sdp", "SDP violations (depending toward instability)"],
  ["unused", "unused declared workspace dependencies"],
]) {
  const allowed = new Set(baseline[kind]);
  const added = measured[kind].filter((edge) => !allowed.has(edge));
  const removed = baseline[kind].filter(
    (edge) => !measured[kind].includes(edge),
  );
  if (added.length > 0) {
    failures.push(
      `New ${label}:\n${added.map((edge) => `      ${edge}`).join("\n")}`,
    );
  }
  if (!update && removed.length > 0) {
    failures.push(
      `Fixed ${label} not recorded -- run \`pnpm quality:packages --update\`:\n${removed
        .map((edge) => `      ${edge}`)
        .join("\n")}`,
    );
  }
}

if (failures.length > 0) {
  console.error("\npackage metrics gate: FAIL\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

const worst = rows
  .filter((row) => row.distance !== null)
  .sort((a, b) => b.distance - a.distance)[0];
const headline =
  worst === undefined
    ? ""
    : `; furthest from main sequence: ${worst.name} (D=${worst.distance.toFixed(2)})`;
console.log(
  `package metrics gate: CLEAN -- ${rows.length} components, 0 cycles, 0 phantom deps; ${measured.sdp.length} SDP and ${measured.unused.length} unused-dep debts tracked${headline}`,
);
