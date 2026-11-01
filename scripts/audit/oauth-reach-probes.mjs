#!/usr/bin/env node
/**
 * Probe, from the audited origin, whether a page can read the token, resource
 * and revocation endpoints of every provider whose OAuth application a person
 * registers themselves (ADR 0218), and keep the answer in
 * `spec/connectors/oauth-reach.json`.
 *
 *   node scripts/audit/oauth-reach-probes.mjs            # report; exit 1 on drift
 *   node scripts/audit/oauth-reach-probes.mjs --write    # record what the providers say now
 *   node scripts/audit/oauth-reach-probes.mjs asana box  # only these provider ids
 *
 * Unauthenticated and with fake credentials: nothing is ever granted. It needs
 * the network, so it is not part of `pnpm verify`. Behind an HTTPS proxy, run
 * with NODE_USE_ENV_PROXY=1.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  endpointsOf,
  isDirect,
  isTemplate,
  moved,
  needsPreflight,
  observe,
  preflightNeeds,
  requestFor,
} from "../lib/oauth-reach-probes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, "../../spec/connectors/oauth-reach.json");
const presetsPath = join(here, "../../spec/connectors/connect-presets.json");

const ORIGIN = "https://opensesame-labs.github.io";

/**
 * Providers whose endpoints name the person's own tenant. A tenant answers for
 * itself, so no probe can speak for it; what is recorded is the family of hosts
 * a tenant may live at, which is all the bridge will ever be asked to allow.
 */
const TENANT_HOSTS = {
  auth0: ["*.auth0.com"],
  bamboohr: ["*.bamboohr.com"],
  databricks: [
    "*.azuredatabricks.net",
    "*.cloud.databricks.com",
    "*.gcp.databricks.com",
  ],
  okta: ["*.okta-emea.com", "*.okta.com", "*.oktapreview.com"],
  shopify: ["*.myshopify.com"],
  workday: ["*.myworkday.com"],
};

/**
 * Providers whose OAuth connection has a route of its own (an existing GitHub
 * connection, Linear's authorization, Bitbucket's Git backup): the registered
 * application form is not their road, so the bridge is not asked to carry it.
 */
const SPECIALIZED = new Set(["github", "linear", "bitbucket"]);

function send({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, timeout: 30_000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(observe(res.statusCode ?? 0, res.headers)));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

function preflight(endpoint) {
  return send({
    method: "OPTIONS",
    url: endpoint.url,
    headers: {
      origin: ORIGIN,
      "access-control-request-method": endpoint.method,
      "access-control-request-headers": [
        ...preflightNeeds(endpoint),
        "accept",
      ].join(","),
    },
  });
}

async function measure(endpoint) {
  const actual = await send(requestFor(endpoint, ORIGIN));
  const pre = needsPreflight(endpoint) ? await preflight(endpoint) : null;
  return { actual, pre, direct: isDirect(endpoint, actual, pre, ORIGIN) };
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const only = new Set(args.filter((arg) => !arg.startsWith("--")));
const presets = JSON.parse(readFileSync(presetsPath, "utf8")).oauth;
const spec = (() => {
  try {
    return JSON.parse(readFileSync(specPath, "utf8"));
  } catch {
    return { providers: [] };
  }
})();
const recorded = new Map(spec.providers.map((row) => [row.provider_id, row]));
const stamp = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
const drifted = [];
const rows = [];

for (const preset of presets) {
  if (preset.token_endpoint_auth_method === "none") continue;
  const id = preset.service;
  if (SPECIALIZED.has(id)) continue;
  if (only.size && !only.has(id)) {
    if (recorded.has(id)) rows.push(recorded.get(id));
    continue;
  }
  const row = { provider_id: id, endpoints: [] };
  if (TENANT_HOSTS[id]) row.tenant_hosts = TENANT_HOSTS[id];
  for (const endpoint of endpointsOf(preset)) {
    const label = `${id} ${endpoint.stage} ${endpoint.url}`;
    const entry = {
      stage: endpoint.stage,
      method: endpoint.method,
      url: endpoint.url,
    };
    if (isTemplate(endpoint.url)) {
      row.endpoints.push({ ...entry, direct: false, tenant: true });
      console.log(`~  ${label}: names the person's own tenant (not probed)`);
      continue;
    }
    try {
      const { actual, pre, direct } = await measure(endpoint);
      const before = recorded
        .get(id)
        ?.endpoints.find((item) => item.stage === endpoint.stage);
      const change = before ? moved(before, direct) : null;
      console.log(
        `${change ? "!" : "="}  ${label}: ${direct ? "direct" : "refused"}${change ? ` (${change})` : ""}`,
      );
      if (change) drifted.push(label);
      row.endpoints.push({
        ...entry,
        direct,
        probe: {
          status: actual.status,
          allow_origin: actual.allow_origin,
          preflight_status: pre?.status ?? null,
          preflight_allow_origin: pre?.allow_origin ?? null,
          preflight_allow_headers: pre?.allow_headers ?? null,
          checked_at: stamp,
        },
      });
    } catch (error) {
      console.log(`?  ${label}: ${error.message} (not compared)`);
      const before = recorded
        .get(id)
        ?.endpoints.find((item) => item.stage === endpoint.stage);
      if (before) row.endpoints.push(before);
    }
  }
  rows.push(row);
}

if (write) {
  const next = {
    schema_version: 1,
    audited_origin: ORIGIN,
    checked_date: stamp.slice(0, 10),
    qualification:
      "Unauthenticated, TLS-verified requests from the audited origin with fake credentials; nothing is granted. An endpoint is direct when its real answer carries an allowing Access-Control-Allow-Origin and, where the request needs a preflight (a custom header such as Authorization), the preflight allows the origin and names the headers. Tenant endpoints answer for themselves and are not probed; only the family of hosts a tenant may live at is recorded.",
    providers: rows.sort((a, b) => a.provider_id.localeCompare(b.provider_id)),
  };
  writeFileSync(specPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    "Recorded. Run `pnpm exec biome format --write spec/connectors/oauth-reach.json`.",
  );
}
if (drifted.length) {
  console.log(`\n${drifted.length} endpoint(s) moved since the last record.`);
  process.exitCode = write ? 0 : 1;
}
