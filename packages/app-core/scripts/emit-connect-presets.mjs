#!/usr/bin/env node
/**
 * Emit `src/lib/connect-presets.generated.ts` (ADR 0147) from three specs:
 *
 * - `spec/connectors/connect-services.json` — Vercel Connect's public service
 *   registry and the live OAuth discovery of each MCP server it lists
 *   (`scripts/release/pin-connect-services.mjs`);
 * - `spec/connectors/connect-presets.json` — what we know about each service's
 *   OAuth server and API keys: endpoints, client authentication, PKCE, scopes,
 *   extra authorization parameters, where to register a client or issue a
 *   key, and one read-only call that proves a token works; and, under `mcp`,
 *   how a connector page offers a published MCP server (the permissions it
 *   selects, whether it is the page's only primary road, whether its
 *   authentication is configurable);
 * - `spec/connectors/catalog.json` — the one integration catalog, for names
 *   and categories of the rows the registry does not list (ADR 0139).
 *
 * One plan per connector, as JSON. `connect-presets.test.ts` fails when this
 * output has drifted from the specs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPackedJsonRows } from "./pack-json.mjs";
import {
  READONLY_PAYMENT_IDS,
  readonlyPaymentContract,
} from "./readonly-payments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const spec = (name) =>
  JSON.parse(
    readFileSync(join(here, "../../../spec/connectors", name), "utf8"),
  );
const outputPath = join(here, "../src/lib/connect-presets.generated.ts");

/** Vercel registry categories → the app's provider categories. */
const CATEGORY = {
  communication: "communication",
  productivity: "productivity",
  "developer-tools": "developer",
  ai: "agent_harnesses",
  data: "storage",
  analytics: "developer",
  content: "productivity",
  commerce: "crm",
  other: "custom",
};

/** Where a row belongs regardless of the registry's coarser category. */
const CATEGORY_OVERRIDE = {
  auth0: "identity",
  clerk: "identity",
  okta: "identity",
  workos: "identity",
  microsoft: "identity",
  gitlab: "backup_recovery",
  bitbucket: "backup_recovery",
  codeberg: "backup_recovery",
  gitee: "backup_recovery",
  github: "backup_recovery",
  salesforce: "crm",
  hubspot: "crm",
  ngrok: "networking",
  tailscale: "networking",
};

/** Payment writes remain refused; only explicit bounded read contracts are admitted. */
const REFUSED = new Set(READONLY_PAYMENT_IDS);

/** Spending and issuing remain outside the connector's read-only authority. */
function refused(id, row) {
  return REFUSED.has(id) || row?.category === "wallet";
}

function templateParams(row) {
  return (row.template_params ?? []).map((param) => ({
    ...param,
    required: param.required !== false,
    secret: param.secret === true,
  }));
}

function verification(row) {
  if (!row) return null;
  return {
    method: row.method,
    url: row.url,
    headers: row.headers ?? {},
    body: row.body ?? null,
    accountField: row.account_field ?? null,
    success: row.success ?? [],
    requiredFields: row.required_fields ?? [],
    errorFields: row.error_fields ?? [],
    auth: row.header
      ? {
          kind: "header",
          header: row.header,
          scheme: row.scheme ?? null,
          valueTemplate: null,
        }
      : null,
  };
}

/** An explicit credential injection site; never inferred from an arbitrary URL. */
function authentication(row) {
  if (row.auth && !["header", "basic", "query", "path"].includes(row.auth.kind))
    throw new Error(`Unsupported authentication metadata for ${row.service}`);
  if (row.auth?.kind === "query")
    return { kind: "query", parameter: row.auth.parameter };
  if (row.auth?.kind === "path")
    return { kind: "path", template: row.auth.template };
  if (row.auth?.kind === "basic")
    return {
      kind: "basic",
      username: row.auth.username,
      password: row.auth.password,
    };
  if (row.basic) return { kind: "basic", ...row.basic };
  return headerAuthentication(row);
}

function headerAuthentication(row) {
  const header = row.auth?.header ?? row.header;
  if (!header) return null;
  return {
    kind: "header",
    header,
    scheme:
      row.auth && Object.hasOwn(row.auth, "scheme")
        ? row.auth.scheme
        : (row.scheme ?? null),
    valueTemplate: row.auth?.value_template ?? null,
  };
}

function credentialDefinition(row) {
  return {
    header: row.header ?? null,
    scheme: row.scheme ?? null,
    basic: row.basic ?? null,
    auth: authentication(row),
    verify: verification(row.verify),
    templateParams: templateParams(row),
    additionalCredentials: row.additional_credentials ?? [],
  };
}

function oauthPreset(row) {
  return {
    serverUrl: row.server_url,
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    revocationEndpoint: row.revocation_endpoint ?? null,
    userinfoEndpoint: row.userinfo_endpoint ?? null,
    tokenAuth: row.token_endpoint_auth_method,
    pkce: row.pkce,
    authorizationParams: row.authorization_params ?? {},
    scopes: (row.scopes ?? []).map((scope) => ({
      name: scope.name,
      description: scope.description,
      default: scope.default === true,
    })),
    refreshTokens: row.refresh_tokens === true,
    registration: row.client_registration ?? "manual",
    consoleUrl: row.developer_console_url ?? null,
    docsUrl: row.docs_url ?? null,
    templateParams: templateParams(row),
    verify: verification(row.verify),
    scopeSeparator: row.scope_separator ?? " ",
    registrationEndpoint: row.registration_endpoint ?? null,
  };
}

function apiKeyPreset(row) {
  return {
    keyUrl: row.key_url ?? null,
    keyPrefix: row.key_prefix ?? null,
    serviceUrls: row.service_urls ?? [],
    instructions: row.instructions ?? "",
    docsUrl: row.docs_url ?? null,
    ...credentialDefinition(row),
    credentialVariants: (row.credential_variants ?? []).map((variant) => ({
      id: variant.id,
      label: variant.label,
      description: variant.description ?? "",
      ...credentialDefinition({ ...row, ...variant }),
    })),
  };
}

/** A page rule from the spec's `mcp` rows, written only where a row sets it. */
function withMcpRule(info, rule) {
  if (rule?.default_scopes) info.defaultScopes = rule.default_scopes;
  if (rule?.configurable_authentication === false) info.configurable = false;
  return info;
}

function mcpInfo(url, found, rule) {
  if (!found || found.status !== "ok") {
    return { url, status: "no_metadata" };
  }
  return withMcpRule(
    {
      url,
      status: "ok",
      issuer: found.issuer ?? null,
      authorizationEndpoint: found.authorization_endpoint,
      tokenEndpoint: found.token_endpoint,
      registration: found.client_registration,
      pkce: found.code_challenge_methods,
      scopes: found.scopes_supported.slice(0, 12),
      resource: found.resource ?? null,
      resourceMetadata: found.resource_metadata ?? null,
      discoveryUrl: found.discovery_url ?? null,
      registrationEndpoint: found.registration_endpoint ?? null,
      revocationEndpoint: found.revocation_endpoint ?? null,
      tokenAuthMethods: found.token_endpoint_auth_methods ?? [],
    },
    rule,
  );
}

function registryMethod(method, service, apiKey, rule) {
  if (method.method === "oauth") return null;
  if (method.method === "api-key") {
    return {
      kind: "api-key",
      urls: method.service_urls,
      preset: apiKey ?? null,
    };
  }
  if (method.method !== "mcp") return null;
  const url = method.service_urls[0];
  if (!url) return null;
  const info = mcpInfo(url, service.mcp_discovery, rule);
  // An MCP server with no OAuth metadata takes a key (Similarweb's `api-key`
  // header): offered as what it is.
  return info.status === "ok"
    ? { kind: "mcp", mcp: info }
    : { kind: "api-key", urls: [url], preset: apiKey ?? null };
}

function methodsFor(service, oauth, apiKey, rule) {
  const listed = service?.connection_methods ?? [];
  const out = listed
    .map((method) => registryMethod(method, service, apiKey, rule))
    .filter(Boolean);
  const hasOauth = listed.some((method) => method.method === "oauth");
  if (hasOauth || oauth) out.unshift({ kind: "oauth", preset: oauth ?? null });
  if (service?.managed) out.unshift({ kind: "managed" });
  if (apiKey && !out.some((method) => method.kind === "api-key")) {
    out.push({ kind: "api-key", urls: apiKey.serviceUrls, preset: apiKey });
  }
  // Nothing published and nothing known: the generic OAuth integration,
  // every field the person's to fill. Never a page with no way in.
  if (out.length === 0) out.push({ kind: "oauth", preset: null });
  return out;
}

/**
 * A preset from the one integration catalog's own OAuth block, for a row the
 * researched presets do not cover (Cursor Origin): same endpoints, client
 * authentication, and scopes the Host uses (ADR 0139).
 */
function catalogOauthPreset(row) {
  const auth = row.auth;
  return oauthPreset({
    server_url: new URL(auth.authorize_url).origin,
    authorization_endpoint: auth.authorize_url,
    token_endpoint: auth.token_url,
    revocation_endpoint: auth.revoke_url ?? null,
    token_endpoint_auth_method: auth.token_auth,
    pkce: "none",
    authorization_params: Object.fromEntries(auth.extra_authorize_params ?? []),
    scopes: row.scopes,
    refresh_tokens: auth.supports_refresh,
    client_registration: "manual",
    docs_url: row.docs_url,
  });
}

function docsFor(service, row, oauth, apiKey) {
  return (
    service?.docsite ??
    oauth?.docsUrl ??
    apiKey?.docsUrl ??
    row?.docs_url ??
    service?.website ??
    null
  );
}

function categoryFor(id, service, row, preset) {
  return (
    CATEGORY_OVERRIDE[id] ??
    row?.category ??
    preset?.category ??
    CATEGORY[service?.categories[0] ?? "other"] ??
    "developer"
  );
}

function planFor(id, service, row, oauth, apiKey, rule, preset) {
  const safeRead = readonlyPaymentContract(id, apiKey);
  const plan = {
    id,
    name: service?.name ?? row?.display_name ?? preset?.display_name ?? id,
    docsUrl: docsFor(service, row, oauth, apiKey),
    category: categoryFor(id, service, row, preset),
    registry: Boolean(service),
    refused: refused(id, row) && !safeRead,
    methods: READONLY_PAYMENT_IDS.has(id)
      ? safeRead
        ? [{ kind: "api-key", urls: apiKey.serviceUrls, preset: apiKey }]
        : []
      : methodsFor(service, oauth, apiKey, rule),
  };
  if (rule?.primary_only) plan.primaryMethod = "mcp";
  return plan;
}

export function renderPlanJson(
  services = spec("connect-services.json"),
  presets = spec("connect-presets.json"),
  catalog = spec("catalog.json"),
) {
  const oauth = new Map(
    presets.oauth.map((row) => [row.service, oauthPreset(row)]),
  );
  const apiKey = new Map(
    presets.api_key.map((row) => [row.service, apiKeyPreset(row)]),
  );
  const mcp = new Map((presets.mcp ?? []).map((row) => [row.service, row]));
  const bundled = new Map(catalog.providers.map((row) => [row.id, row]));
  for (const row of catalog.providers) {
    if (
      row.auth.kind === "oauth2_authorization_code" &&
      row.category !== "testing" &&
      !oauth.has(row.id) &&
      row.auth.authorize_url.startsWith("https://")
    ) {
      oauth.set(row.id, catalogOauthPreset(row));
    }
  }
  const listed = new Map(services.services.map((row) => [row.service, row]));
  /** Researched rows carry their own name and category when no registry row does. */
  const presetMeta = new Map(
    [...presets.api_key, ...presets.oauth].map((row) => [row.service, row]),
  );
  const ids = [
    ...listed.keys(),
    ...[...oauth.keys(), ...apiKey.keys()].filter((id) => !listed.has(id)),
  ];
  const plans = [...new Set(ids)].map((id) =>
    planFor(
      id,
      listed.get(id),
      bundled.get(id),
      oauth.get(id),
      apiKey.get(id),
      mcp.get(id),
      presetMeta.get(id),
    ),
  );
  return plans.map((plan) => JSON.stringify(plan));
}
export function renderModule(
  services = spec("connect-services.json"),
  presets = spec("connect-presets.json"),
  catalog = spec("catalog.json"),
) {
  return [
    "// Generated by scripts/emit-connect-presets.mjs from",
    "// spec/connectors/connect-services.json, connect-presets.json and",
    "// catalog.json — do not edit.",
    `export const CONNECT_SERVICES_PINNED_AT = ${JSON.stringify(services.pinned_at)};`,
    "",
    "/** One connector plan per row, as JSON (`ConnectPlanSchema`). */",
    renderPackedJsonRows(
      "CONNECT_PLAN_JSON",
      renderPlanJson(services, presets, catalog),
    ),
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(outputPath, renderModule());
  console.log(`wrote ${outputPath}`);
}
