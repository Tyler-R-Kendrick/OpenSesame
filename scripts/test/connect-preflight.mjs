#!/usr/bin/env node
/**
 * `pnpm test:connect-preflight` — every connector's real endpoints, read-only
 * (ADR 0146; logic in `scripts/lib/connect-preflight.mjs`).
 *
 *   node scripts/test/connect-preflight.mjs [--out <file.json>]
 *
 * Exits 1 when an endpoint a preset names is gone (404, DNS failure) — the
 * preset is stale, not the network.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pool,
  preflightApiKey,
  preflightMcp,
  preflightOauth,
} from "../lib/connect-preflight.mjs";
import { makeFetchJson } from "../lib/oauth-discovery.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const spec = (name) =>
  JSON.parse(readFileSync(join(root, "spec/connectors", name), "utf8"));
const presets = spec("connect-presets.json");
const services = spec("connect-services.json");
const fetchJson = makeFetchJson();

const mcp = services.services.flatMap((row) => {
  const url = row.connection_methods.find((m) => m.method === "mcp")
    ?.service_urls[0];
  return url ? [[row.service, url]] : [];
});

const results = [
  ...(await pool(presets.oauth, 8, (row) =>
    preflightOauth(row, { fetchJson }),
  )),
  ...(await pool(mcp, 8, ([service, url]) =>
    preflightMcp(service, url, { fetchJson }),
  )),
  ...(await pool(presets.api_key, 8, (row) => preflightApiKey(row, {}))),
];

const tally = {};
for (const row of results) {
  const key = `${row.kind}:${row.result}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
const outIndex = process.argv.indexOf("--out");
if (outIndex > 0) {
  writeFileSync(
    process.argv[outIndex + 1],
    `${JSON.stringify({ ran_at: new Date().toISOString(), tally, results }, null, 2)}\n`,
  );
}
console.log(tally);
const gone = results.filter((row) => row.result === "unreachable");
for (const row of gone) console.log(`unreachable: ${row.kind} ${row.service}`);
process.exit(gone.length === 0 ? 0 : 1);
