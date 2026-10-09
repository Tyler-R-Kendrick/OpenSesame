#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.argv[2] ?? process.cwd();
const marker = Number(process.argv[3] ?? "2");
const filesRoot = path.join(
  repoRoot,
  ".deepsec",
  "data",
  "opensesame",
  "files",
);

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith(".json")) out.push(p);
  }
  return out;
}

let complete = 0;
const paths = walk(filesRoot);
for (const fp of paths) {
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  const hist = rec.analysisHistory ?? [];
  if (
    hist.some((h) => {
      if (h.reinvestigateMarker !== marker) return false;
      if (h.phase === "revalidate") return false;
      if ((h.usage?.outputTokens ?? 0) > 0) return true;
      return h.phase === "process" && (h.findingCount ?? 0) >= 0;
    })
  ) {
    complete += 1;
  }
}

const payload = {
  marker,
  filesComplete: complete,
  filesTracked: paths.length,
};
console.log(JSON.stringify(payload));
process.exit(complete >= paths.length ? 0 : 2);
