#!/usr/bin/env node
/**
 * Emit `server/connect-verify-targets.generated.mjs` (ADR 0147): for each
 * service, the one read-only call the relay's token proof may make with a
 * freshly acquired token — per connection method, from
 * `spec/connectors/connect-presets.json` and the MCP servers in
 * `spec/connectors/connect-services.json`. The relay picks a target by the
 * connector's service; a request can never name one.
 * `server/test/connect-manage.test.mjs` fails when this output has drifted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, isString } from "../server/json-boundary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const spec = (name) =>
  JSON.parse(
    readFileSync(join(here, "../../../spec/connectors", name), "utf8"),
  );
const outputPath = join(here, "../server/connect-verify-targets.generated.mjs");

function validateRelayRow(row, names) {
  if (
    !isJsonObject(row) ||
    !isString(row.service) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.service) ||
    ["constructor", "prototype"].includes(row.service) ||
    names.has(row.service)
  )
    throw new Error("Conflicting relay verification preset");
  const aliases = row.legacy_server_urls ?? [];
  if (
    !Array.isArray(aliases) ||
    aliases.some(
      (url) => !isString(url) || !/^https:\/\/[a-z0-9.-]+\/?$/i.test(url),
    )
  )
    throw new Error("Invalid relay verification host alias");
  names.add(row.service);
}

/** Relay-only source rows must be promoted or removed before a shared row claims them. */
export function relayVerificationPresets(
  presets = spec("connect-presets.json"),
  relay = spec("relay-verification-presets.json"),
) {
  if (
    !isJsonObject(presets) ||
    !isJsonObject(relay) ||
    relay.schema_version !== 1
  )
    throw new Error("Invalid relay verification presets");
  const merged = { ...presets };
  for (const kind of ["oauth", "api_key"]) {
    if (!Array.isArray(presets[kind]) || !Array.isArray(relay[kind]))
      throw new Error("Invalid relay verification presets");
    const names = new Set();
    for (const row of [...presets[kind], ...relay[kind]]) {
      validateRelayRow(row, names);
    }
    merged[kind] = [...presets[kind], ...relay[kind]];
  }
  return merged;
}
export function verifyHostBindings(trust = spec("verification-hosts.json")) {
  if (
    !isJsonObject(trust) ||
    trust.schema_version !== 1 ||
    !isJsonObject(trust.providers)
  )
    throw new Error("Invalid verification host policy");
  const hostname =
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  for (const [id, binding] of Object.entries(trust.providers)) {
    const suffixes = isJsonObject(binding) ? binding.host_suffixes : null;
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
      !Array.isArray(suffixes) ||
      suffixes.some((suffix) => !isString(suffix) || !hostname.test(suffix)) ||
      new Set(suffixes).size !== suffixes.length
    )
      throw new Error("Invalid provider-owned verification host suffixes");
  }
  return trust.providers;
}
const hostBindings = verifyHostBindings();

function unboundTemplate(template, hostSuffixes) {
  const authority = /^https:\/\/([^/?#]+)/i.exec(template ?? "")?.[1];
  if (!authority || authority.includes("@") || authority.includes("\\"))
    return true;
  if (!authority.includes("{")) return false;
  if (authority.includes(":")) return true;
  const host = authority.toLowerCase();
  return !hostSuffixes.some((suffix) => host.endsWith(`.${suffix}`));
}

function validateProofDisabled(verify) {
  if (
    verify.proof_disabled !== undefined &&
    verify.proof_disabled !== true &&
    verify.proof_disabled !== false
  )
    throw new Error("Invalid verification disabled flag");
}

function target(
  kind,
  verify,
  header = "Authorization",
  scheme = "Bearer",
  basic = null,
  sources = [],
  hostSuffixes = [],
) {
  validateProofDisabled(verify);
  const built = {
    sources,
    kind,
    method: verify.method,
    url: verify.url,
    accountField: verify.account_field ?? null,
    header,
    scheme,
    basic,
    headers: verify.headers ?? {},
    body: verify.body ?? null,
    success: verify.success ?? [],
    requiredFields: verify.required_fields ?? [],
    errorFields: verify.error_fields ?? [],
    hostSuffixes,
    unbound: unboundTemplate(verify.url, hostSuffixes),
  };
  if (verify.proof_disabled === true) built.proofDisabled = true;
  return built;
}

/**
 * OAuth rows of the integration catalog the researched presets do not cover
 * (Cursor Origin), in the presets' shape — the same derivation as
 * `packages/app-core/scripts/emit-connect-presets.mjs` (ADR 0139).
 */
function catalogOauthRows(presets, catalog = spec("catalog.json")) {
  const covered = new Set(presets.oauth.map((row) => row.service));
  return catalog.providers
    .filter(
      (row) =>
        row.auth.kind === "oauth2_authorization_code" &&
        row.category !== "testing" &&
        !covered.has(row.id) &&
        row.auth.authorize_url.startsWith("https://") &&
        row.verify?.path &&
        row.egress?.authorities?.[0],
    )
    .map((row) => ({
      service: row.id,
      server_url: new URL(row.auth.authorize_url).origin,
      authorization_endpoint: row.auth.authorize_url,
      token_endpoint: row.auth.token_url,
      verify: {
        method: "GET",
        url: `https://${row.egress.authorities[0]}${row.verify.path}`,
      },
    }));
}

function oauthRows(presets) {
  return [...presets.oauth, ...catalogOauthRows(presets)];
}

function templated(sources) {
  return sources.filter((source) => source.template.includes("{"));
}

function oauthTarget(row) {
  return target(
    "oauth",
    row.verify,
    row.verify.header === undefined ? "Authorization" : row.verify.header,
    row.verify.scheme === undefined ? "Bearer" : row.verify.scheme,
    null,
    templated([
      {
        template: row.authorization_endpoint,
        field: "serverConfig.authorization_endpoint",
      },
      { template: row.token_endpoint, field: "serverConfig.token_endpoint" },
    ]),
    hostBindings[row.service]?.host_suffixes ?? [],
  );
}

function apiKeyTarget(row) {
  const verify = legacyApiVerification(row);
  if (!verify) return null;
  const sources = templated(
    (row.service_urls ?? []).map((template, index) => ({
      template,
      field: `serviceUrls.${index}`,
    })),
  );
  const recoverable = new Set(
    sources.flatMap((source) =>
      [...source.template.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]),
    ),
  );
  const unresolved = [...verify.url.matchAll(/\{([a-z_]+)\}/g)].some(
    (match) => match[1] !== "key" && !recoverable.has(match[1]),
  );
  if (unresolved) return null;
  return target(
    "api-key",
    verify,
    row.header,
    row.scheme ?? null,
    row.basic ?? null,
    sources,
    hostBindings[row.service]?.host_suffixes ?? [],
  );
}

/** The single-key relay cannot supply a provider's additional secret slots. */
function legacyApiVerification(row) {
  if (!row.legacy_verify && (row.additional_credentials ?? []).length > 0)
    return null;
  if (row.auth?.value_template) return null;
  const verify = row.legacy_verify ?? row.verify;
  const params = row.template_params ?? [];
  const fill = (value) =>
    value.replace(/\{([a-z_]+)\}/g, (whole, name) => {
      const param = params.find((item) => item.name === name);
      return !param?.secret && param?.choices?.length > 0
        ? param.choices[0].value
        : whole;
    });
  const optional = new Set(
    params.filter((item) => item.required === false).map((item) => item.name),
  );
  const headers = Object.fromEntries(
    Object.entries(verify.headers ?? {})
      .filter(([, value]) => {
        const names = [...value.matchAll(/\{([a-z_]+)\}/g)].map(
          (match) => match[1],
        );
        return !names.length || !names.every((name) => optional.has(name));
      })
      .map(([name, value]) => [name, fill(value)]),
  );
  return { ...verify, url: fill(verify.url), headers };
}

function mcpUrl(row) {
  if (row.mcp_discovery?.status !== "ok") return null;
  return (
    row.connection_methods.find((m) => m.method === "mcp")?.service_urls[0] ??
    null
  );
}

export function verifyTargets(
  services = spec("connect-services.json"),
  presets = relayVerificationPresets(),
) {
  const out = {};
  const slot = (id) => {
    out[id] ??= {};
    return out[id];
  };
  for (const row of oauthRows(presets).filter((r) => r.verify)) {
    slot(row.service).oauth = oauthTarget(row);
  }
  for (const row of presets.api_key.filter((r) => r.verify)) {
    const selected = apiKeyTarget(row);
    if (selected) slot(row.service).apiKey = selected;
  }
  for (const row of services.services) {
    const url = mcpUrl(row);
    if (url) {
      slot(row.service).mcp = target("mcp", {
        method: "POST",
        url,
        account_field: null,
      });
    }
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Custom OAuth connectors name their service by host (`bitbucket.org`). */
function oauthHosts(row) {
  return [
    ...new Set(
      [row.server_url, ...(row.legacy_server_urls ?? [])]
        .filter((url) => !url.includes("{"))
        .map((url) => new URL(url).host),
    ),
  ];
}

export function verifyHosts(presets = relayVerificationPresets()) {
  const out = {};
  for (const row of oauthRows(presets)) {
    if (!row.verify) continue;
    for (const host of oauthHosts(row)) out[host] ??= row.service;
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function verifyAliasHosts(presets = relayVerificationPresets()) {
  const out = {};
  for (const row of oauthRows(presets)) {
    if (!row.verify) continue;
    for (const host of oauthHosts(row)) {
      out[host] ??= [];
      out[host].push(row.service);
    }
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function renderModule() {
  const rows = Object.entries(verifyTargets()).map(
    ([id, row]) => `  ${JSON.stringify(JSON.stringify([id, row]))},`,
  );
  return [
    "// Generated by scripts/emit-connect-verify-targets.mjs from",
    "// spec/connectors/connect-presets.json, relay-verification-presets.json,",
    "// connect-services.json and verification-hosts.json — do not edit.",
    "/** One `[service, targets]` pair per row, as JSON. */",
    "const ROWS = [",
    ...rows,
    "];",
    "",
    "export const VERIFY_TARGETS = Object.freeze(",
    "  Object.fromEntries(ROWS.map((row) => { const [id, targets] = JSON.parse(row); return [id, Object.freeze(targets)]; })),",
    ");",
    "",
    `export const VERIFY_HOSTS = Object.freeze(${JSON.stringify(verifyHosts())});`,
    "",
    `export const VERIFY_OAUTH_ALIAS_HOSTS = Object.freeze(Object.fromEntries(Object.entries(${JSON.stringify(verifyAliasHosts(), null, 2)}).map(([host, ids]) => [host, Object.freeze(ids)])));`,
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(outputPath, renderModule());
  console.log(`wrote ${outputPath}`);
}
