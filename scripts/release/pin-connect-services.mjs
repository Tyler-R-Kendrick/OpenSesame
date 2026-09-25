#!/usr/bin/env node
/**
 * Re-pin `spec/connectors/connect-services.json` (ADR 0146): Vercel Connect's
 * public service registry (`GET https://api.vercel.com/v1/connect/services`,
 * no credential), icons dropped, plus the live OAuth discovery of every MCP
 * server it lists (RFC 9728 → RFC 8414 / OIDC). Reads only well-known
 * documents; registers nothing.
 *
 *   node scripts/release/pin-connect-services.mjs          # rewrite the pin
 *   node scripts/release/pin-connect-services.mjs --check  # exit 1 when the
 *                                                          # registry moved
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverProtectedResource,
  makeFetchJson,
} from "../lib/oauth-discovery.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const target = join(root, "spec", "connectors", "connect-services.json");
const REGISTRY = "https://api.vercel.com/v1/connect/services";

const fetchJson = makeFetchJson();

function text(value, max = 400) {
  return typeof value === "string" ? value.trim().slice(0, max) : null;
}

function service(row) {
  return {
    service: row.service,
    name: text(row.name, 80),
    description: text(row.description),
    website: text(row.website),
    docsite: text(row.docsite),
    categories: Array.isArray(row.categories) ? row.categories : [],
    targets: (row.targets ?? []).map((item) => ({
      target: item.target,
      label: text(item.label, 80),
    })),
    connection_methods: (row.connectionMethods ?? []).map((item) => ({
      method: item.connectionMethod,
      service_urls: item.serviceUrls ?? [],
    })),
    managed: row.managed === true,
    supports_triggers: row.supportsTriggers === true,
  };
}

async function pool(items, size, run) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index]);
      }
    }),
  );
  return out;
}

const registry = await makeFetchJson({ maxBytes: 8_000_000 })(REGISTRY);
if (!registry.ok || !Array.isArray(registry.body?.services)) {
  console.error(`registry unavailable (${registry.status})`);
  process.exit(2);
}
const services = registry.body.services
  .map(service)
  .sort((a, b) => a.service.localeCompare(b.service));

if (process.argv.includes("--check")) {
  const pinned = JSON.parse(readFileSync(target, "utf8"));
  const was = pinned.services.map((row) => row.service).join(",");
  const now = services.map((row) => row.service).join(",");
  if (was !== now) {
    console.log("registry moved: re-run without --check");
    process.exit(1);
  }
  console.log(`pin current (${services.length} services)`);
  process.exit(0);
}

await pool(services, 8, async (row) => {
  const mcp = row.connection_methods.find((item) => item.method === "mcp");
  const url = mcp?.service_urls[0];
  if (!url) return;
  const found = await discoverProtectedResource(fetchJson, url);
  row.mcp_discovery = found;
});

const ok = services.filter((row) => row.mcp_discovery?.status === "ok").length;
const mcpCount = services.filter((row) => row.mcp_discovery).length;
writeFileSync(
  target,
  `${JSON.stringify(
    {
      schema_version: 1,
      source: REGISTRY,
      pinned_at: new Date().toISOString().slice(0, 10),
      services,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `${services.length} services pinned; MCP discovery ${ok}/${mcpCount} ok`,
);
