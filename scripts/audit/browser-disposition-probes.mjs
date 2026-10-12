#!/usr/bin/env node
/**
 * Re-probe the evidence behind `spec/connectors/browser-dispositions.json`
 * (ADR 0197) and report where a provider's answer has moved.
 *
 *   node scripts/audit/browser-disposition-probes.mjs            # report; exit 1 on drift
 *   node scripts/audit/browser-disposition-probes.mjs --write    # record what the providers say now
 *   node scripts/audit/browser-disposition-probes.mjs bitwarden  # only these provider ids
 *
 * Unauthenticated, from the audited origin; no credential is ever sent. It
 * needs the network, so it is not part of `pnpm verify`. When a provider that
 * was refusing starts to admit the origin (or the reverse), the row's kind is
 * out of date: re-author it, then record with --write.
 *
 * Behind an HTTPS proxy, run with NODE_USE_ENV_PROXY=1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  drift,
  observe,
  requestFor,
} from "../lib/browser-disposition-probes.mjs";

const specPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../spec/connectors/browser-dispositions.json",
);

function send({ method, url, headers }) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, timeout: 30_000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(observe(res.statusCode ?? 0, res.headers)));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const only = new Set(args.filter((arg) => !arg.startsWith("--")));
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const drifted = [];
let probed = 0;

for (const row of spec.dispositions) {
  if (only.size && !only.has(row.provider_id)) continue;
  for (const probe of row.probes) {
    const label = `${row.provider_id} ${probe.stage} ${probe.url}`;
    probed += 1;
    let observed;
    try {
      observed = await send(requestFor(probe, spec.audited_origin));
    } catch (error) {
      console.log(`?  ${label}: ${error.message} (not compared)`);
      continue;
    }
    const moved = drift(probe, observed, spec.audited_origin);
    console.log(`${moved ? "!" : "="}  ${label}${moved ? `: ${moved}` : ""}`);
    if (moved) drifted.push(label);
    if (write) {
      Object.assign(probe, observed, {
        checked_at: new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
      });
    }
  }
}

if (write) {
  spec.checked_date = new Date().toISOString().slice(0, 10);
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(
    "Recorded. Run `pnpm exec biome format --write spec/connectors/browser-dispositions.json` and `pnpm --filter @opensesame/app-core generate:dispositions`.",
  );
}
console.log(`${probed} probe(s), ${drifted.length} moved.`);
process.exit(drifted.length && !write ? 1 : 0);
