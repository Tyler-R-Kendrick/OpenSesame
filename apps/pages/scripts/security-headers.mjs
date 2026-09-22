/**
 * Capability-derived security headers (S18, NET-06/07/08).
 *
 * `generateSecurityHeaders` turns a capability profile into one CSP and the
 * response headers around it. The deployment facts — canonical origin,
 * deployment profile, whether the host can send headers at all — are INPUTS.
 * Nothing about a capability profile can change them: switching a purpose
 * preset changes `connect-src` and `form-action`, never COOP/COEP or the
 * origin the build is pinned to.
 *
 * `metaCsp` is the same policy minus the directives browsers ignore inside a
 * `<meta http-equiv>` (`frame-ancestors`, `report-uri`, `sandbox`); those are
 * listed in `unsupportedInMeta` so the build can say what a header-less host
 * cannot enforce.
 *
 *   node scripts/security-headers.mjs --profile <profile.json> \
 *     [--emit dist/_headers] [--base /OpenSesame/]
 *
 * Deployment facts come from the same environment `security-profile.mjs`
 * reads (PAGES_DEPLOYMENT_PROFILE, PAGES_CANONICAL_ORIGIN,
 * PAGES_HEADER_SECURITY). `--emit` writes a Netlify/Cloudflare `_headers`
 * file and a `headers.json` beside it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { securityProfile } from "./security-profile.mjs";

/** Ownership §5: always present, never in a policy set. */
export const CORE_CAPABILITIES = Object.freeze([
  "vault.passwords",
  "vault.local-unlock",
  "backup.local-encrypted",
  "identity.brokered-signin",
  "settings.core",
  "install.pwa",
]);

/** Navigation targets a capability declares (form posts / redirects). */
export const NAVIGATION_TARGETS = Object.freeze({
  "backup.git-remote": ["https://github.com"],
  "connectors.external": ["https://github.com"],
});

/** Directives a browser ignores when the policy arrives in a `<meta>` tag. */
export const META_UNSUPPORTED = Object.freeze([
  "frame-ancestors",
  "report-uri",
  "sandbox",
]);

const DEPLOYMENT_PROFILES = Object.freeze([
  "shared_origin_demo",
  "loopback_development",
  "dedicated_origin",
]);

const LOOPBACK_DEV_SOURCES = Object.freeze([
  "http://localhost:*",
  "http://127.0.0.1:*",
  "ws://localhost:*",
  "ws://127.0.0.1:*",
]);

function isOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * The compiled-in broker origins: `issuer` values of `TRUSTED_UPSTREAMS` in
 * `src/lib/federation.ts`, https only (the loopback mock IdP is a test seam).
 */
export function brokerOrigins(federationSource) {
  const start = federationSource.indexOf("TRUSTED_UPSTREAMS");
  if (start < 0)
    throw new Error("TRUSTED_UPSTREAMS not found in federation source");
  const end = federationSource.indexOf("];", start);
  const block = federationSource.slice(start, end < 0 ? undefined : end);
  const origins = new Set();
  for (const match of block.matchAll(/issuer:\s*"([^"]+)"/g)) {
    const origin = new URL(match[1]).origin;
    if (origin.startsWith("https://")) origins.add(origin);
  }
  if (origins.size === 0)
    throw new Error("no https issuer in TRUSTED_UPSTREAMS");
  return [...origins].sort();
}

export async function readBrokerOrigins() {
  const source = await readFile(
    new URL("../src/lib/federation.ts", import.meta.url),
    "utf8",
  );
  return brokerOrigins(source);
}

function ids(list) {
  return Array.isArray(list) ? list.filter((id) => typeof id === "string") : [];
}

/**
 * Capabilities the profile can approve: core, every required root, and the
 * selected optional roots the policy permits. Dependencies are not expanded
 * here — headers are a ceiling over declared navigation, not a resolver.
 */
/** The three id lists a policy names, each read as a bounded list of strings. */
function policyLists(policy) {
  const capabilities = policy?.capabilities ?? null;
  return {
    required: ids(capabilities?.required),
    optional: ids(capabilities?.optional),
    prohibited: ids(capabilities?.prohibited),
  };
}

export function approvedCapabilities(profile) {
  const policy = profile?.instancePolicy ?? null;
  const selected = ids(profile?.installationSelection?.selectedOptional);
  const approved = new Set(CORE_CAPABILITIES);
  if (policy === null) {
    for (const id of selected) approved.add(id);
    return [...approved].sort();
  }
  const lists = policyLists(policy);
  const prohibited = new Set(lists.prohibited);
  const permitted = new Set([...lists.required, ...lists.optional]);
  for (const id of lists.required) {
    if (!prohibited.has(id)) approved.add(id);
  }
  for (const id of selected) {
    if (permitted.has(id) && !prohibited.has(id)) approved.add(id);
  }
  return [...approved].sort();
}

function networkOf(profile) {
  const network = profile?.instancePolicy?.network;
  if (!network) return { externalServices: "deny", allowedServiceOrigins: [] };
  return {
    externalServices: network.externalServices === "allow" ? "allow" : "deny",
    allowedServiceOrigins: ids(network.allowedServiceOrigins).filter(isOrigin),
  };
}

function connectSources(profile, deploymentProfile, brokers, notes) {
  const sources = ["'self'", ...brokers];
  const network = networkOf(profile);
  if (network.externalServices === "allow") {
    if (network.allowedServiceOrigins.length === 0) {
      sources.push("https:");
      notes.push(
        "connect-src widened to https: because externalServices is allow with no allowedServiceOrigins; list origins to narrow it.",
      );
    } else {
      sources.push(...network.allowedServiceOrigins);
    }
  }
  if (deploymentProfile === "loopback_development") {
    sources.push(...LOOPBACK_DEV_SOURCES);
  }
  return [...new Set(sources)];
}

function formActionSources(approved) {
  const sources = ["'self'"];
  for (const id of approved) {
    for (const target of NAVIGATION_TARGETS[id] ?? []) sources.push(target);
  }
  return [...new Set(sources)];
}

function directiveString(directives) {
  return Object.entries(directives)
    .map(([name, values]) =>
      values.length === 0 ? name : `${name} ${values.join(" ")}`,
    )
    .join("; ");
}

/** Path-specific COOP exceptions mirroring `src/lib/opener-policy.ts`. */
export function pathOverrides(basePath) {
  const root = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return [
    {
      path: `${root}identity/authorize`,
      set: { "Cross-Origin-Opener-Policy": "unsafe-none" },
      unset: [],
    },
    {
      path: `${root}identity/siop`,
      set: { "Cross-Origin-Opener-Policy": "unsafe-none" },
      unset: [],
    },
    {
      path: `${root}auth/redirect.html`,
      set: {},
      unset: ["Cross-Origin-Opener-Policy"],
    },
  ];
}

export function generateSecurityHeaders(input) {
  const {
    profile,
    deploymentProfile,
    canonicalOrigin,
    headerSecurity,
    brokerOrigins: brokers = [],
    basePath = "/",
  } = input;
  if (!DEPLOYMENT_PROFILES.includes(deploymentProfile))
    throw new Error("Invalid deploymentProfile");
  if (!isOrigin(canonicalOrigin)) throw new Error("Invalid canonicalOrigin");
  if (typeof headerSecurity !== "boolean")
    throw new Error("headerSecurity must be boolean");
  if (!brokers.every(isOrigin)) throw new Error("Invalid broker origin");
  const notes = [];
  const approved = approvedCapabilities(profile);
  const https = canonicalOrigin.startsWith("https://");
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'wasm-unsafe-eval'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": connectSources(profile, deploymentProfile, brokers, notes),
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": formActionSources(approved),
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
  };
  // Only meaningful on an https origin; a browser ignores it elsewhere.
  if (https) directives["upgrade-insecure-requests"] = [];
  const csp = directiveString(directives);
  const metaDirectives = Object.fromEntries(
    Object.entries(directives).filter(
      ([name]) => !META_UNSUPPORTED.includes(name),
    ),
  );
  const metaCsp = directiveString(metaDirectives);
  const headers = {
    "Content-Security-Policy": csp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
  };
  if (!headerSecurity) {
    notes.push(
      "headerSecurity is false: this host cannot send headers; only metaCsp is enforceable and unsupportedInMeta is not.",
    );
  }
  return {
    csp,
    headers,
    metaCsp,
    unsupportedInMeta: [...META_UNSUPPORTED],
    approvedCapabilities: approved,
    canonicalOrigin,
    deploymentProfile,
    headerSecurity,
    pathOverrides: pathOverrides(basePath),
    notes,
  };
}

/** Netlify/Cloudflare `_headers` text. `! Header` removes one on a path. */
export function renderHeadersFile(result) {
  const lines = ["/*"];
  for (const [name, value] of Object.entries(result.headers)) {
    lines.push(`  ${name}: ${value}`);
  }
  for (const override of result.pathOverrides) {
    lines.push(override.path);
    for (const [name, value] of Object.entries(override.set)) {
      lines.push(`  ${name}: ${value}`);
    }
    for (const name of override.unset) lines.push(`  ! ${name}`);
  }
  return `${lines.join("\n")}\n`;
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv, env) {
  const profilePath = argValue(argv, "--profile");
  const profile =
    profilePath === undefined
      ? null
      : JSON.parse(await readFile(profilePath, "utf8"));
  const deployment = securityProfile(env);
  const result = generateSecurityHeaders({
    profile,
    deploymentProfile: deployment.profile,
    canonicalOrigin: deployment.canonicalOrigin,
    headerSecurity: deployment.headerSecurity,
    brokerOrigins: await readBrokerOrigins(),
    basePath: argValue(argv, "--base") ?? "/",
  });
  const emit = argValue(argv, "--emit");
  if (emit === undefined) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  await mkdir(dirname(emit), { recursive: true });
  await writeFile(emit, renderHeadersFile(result));
  await writeFile(
    join(dirname(emit), "headers.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  await main(process.argv.slice(2), process.env);
}
