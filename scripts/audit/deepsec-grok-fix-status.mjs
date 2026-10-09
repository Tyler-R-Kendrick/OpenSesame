#!/usr/bin/env node
/** Stack table for fix-phase reporting (launcher output). */
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.argv[2] ?? process.cwd();
const statePath = path.join(
  repoRoot,
  ".cache/deepsec-grok-fix/stack-state.json",
);
const logDir = path.join(repoRoot, ".cache/deepsec-grok-fix");

let state = { items: [], nextIndex: 0, basePr: 773 };
if (fs.existsSync(statePath)) {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
}

const rows = state.items.map((it) => ({
  n: it.n,
  findingId: it.findingId,
  branch: it.branch,
  prBase: it.prBase,
  prUrl: it.prUrl,
  exit: it.exit,
  durationSec: it.durationSec,
  ci: "unknown",
}));

console.log(
  JSON.stringify(
    { stack: rows, nextIndex: state.nextIndex, lastExit: state.lastExit },
    null,
    2,
  ),
);
