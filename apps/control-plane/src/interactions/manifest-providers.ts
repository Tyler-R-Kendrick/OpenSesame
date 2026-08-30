/**
 * Community identity provider descriptors from manifest files (ADR 0061 §6).
 *
 * Identity extensibility is descriptor-shaped, never code-shaped: a manifest
 * file declares endpoints, scopes and a subject field, and the platform's
 * own token-exchange legs execute it (ADR 0055 §3 keeps those modules
 * platform-owned). Loaded descriptors join the *static* provider set, so
 * `resolveTrustedIssuer`'s static → BYO → org order is preserved by
 * construction — that function is deliberately untouched.
 *
 * Fail-closed rules, each the lesson of a survey incident
 * (docs/research/hooks-ecosystem.md):
 * - unknown keys refuse the boot (a data file must never carry fields some
 *   future consumer silently honors);
 * - an inline `clientSecret` refuses the boot — files carry
 *   `clientSecretEnv`, a *reference* resolved from the process environment,
 *   so secrets never land in a manifest on disk or in git;
 * - Apple (`apple_es256`, signing keys) is not manifestable: signing
 *   material stays platform-configured;
 * - any unreadable file, bad JSON, or invalid descriptor refuses the boot —
 *   the registry never comes up "mostly" configured.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type OAuth2ProviderDescriptor,
  type OidcProviderDescriptor,
  ProviderConfigError,
  type ProviderDescriptor,
  assertProviderDescriptor,
} from "./registry.js";

export const MANIFEST_DIR_ENV = "OPENSESAME_PROVIDER_MANIFEST_DIR";
const MANIFEST_SUFFIX = ".provider.json";
const MAX_MANIFEST_BYTES = 64 * 1024;

const OIDC_KEYS = new Set([
  "id",
  "kind",
  "label",
  "issuer",
  "scopes",
  "clientAuth",
  "clientId",
  "clientSecretEnv",
  "emailAuthoritative",
]);
const OAUTH2_KEYS = new Set([
  "id",
  "kind",
  "label",
  "issuer",
  "authorizationEndpoint",
  "tokenEndpoint",
  "userinfoEndpoint",
  "scopes",
  "subjectField",
  "emailAuthoritative",
  "profileMap",
  "emailsEndpoint",
  "clientId",
  "clientSecretEnv",
]);

function fail(file: string, message: string): never {
  throw new ProviderConfigError(`provider manifest ${file}: ${message}`);
}

function asRecord(file: string, raw: string): Record<string, unknown> {
  if (raw.length > MAX_MANIFEST_BYTES) {
    fail(file, `exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(file, "is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(file, "must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function optionalString(
  file: string,
  doc: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = doc[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(file, `${key} must be a string`);
  return value;
}

function requiredString(
  file: string,
  doc: Record<string, unknown>,
  key: string,
): string {
  const value = optionalString(file, doc, key);
  if (value === undefined || value.length === 0) {
    fail(file, `${key} is required`);
  }
  return value;
}

/**
 * Secrets are referenced, never carried: resolve `clientSecretEnv` from the
 * process environment, refusing the boot when the named variable is unset —
 * a provider that would fail on its first sign-in must not come up at all.
 */
function resolveClientSecret(
  file: string,
  doc: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const banned of ["clientSecret", "client_secret", "apple"]) {
    if (banned in doc) {
      fail(
        file,
        `may not carry \`${banned}\` — manifests reference secrets via clientSecretEnv, and signing material is not manifestable`,
      );
    }
  }
  const envName = optionalString(file, doc, "clientSecretEnv");
  if (envName === undefined) return undefined;
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(envName)) {
    fail(file, "clientSecretEnv must name an environment variable");
  }
  const value = env[envName];
  if (value === undefined || value.length === 0) {
    fail(file, `clientSecretEnv names ${envName}, which is unset`);
  }
  return value;
}

function assertKnownKeys(
  file: string,
  doc: Record<string, unknown>,
  allowed: Set<string>,
): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) {
      fail(file, `unknown key \`${key}\``);
    }
  }
}

const PROFILE_MAP_KEYS = new Set(["email", "name", "emailVerifiedField"]);

function parseProfileMap(
  file: string,
  raw: unknown,
): OAuth2ProviderDescriptor["profileMap"] {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(file, "profileMap must map identity fields to userinfo fields");
  }
  const map: { email?: string; name?: string; emailVerifiedField?: string } =
    {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PROFILE_MAP_KEYS.has(key) || typeof value !== "string") {
      fail(file, `profileMap key \`${key}\` is not a known string field`);
    }
    map[key as "email" | "name" | "emailVerifiedField"] = value;
  }
  return map;
}

function descriptorFrom(
  file: string,
  doc: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): ProviderDescriptor {
  const kind = requiredString(file, doc, "kind");
  const clientSecret = resolveClientSecret(file, doc, env);
  if (kind === "oidc") {
    assertKnownKeys(file, doc, OIDC_KEYS);
    const clientAuth = requiredString(file, doc, "clientAuth");
    if (clientAuth !== "none" && clientAuth !== "client_secret_post") {
      fail(file, "clientAuth must be none or client_secret_post");
    }
    const descriptor: OidcProviderDescriptor = {
      id: requiredString(file, doc, "id"),
      kind: "oidc",
      label: requiredString(file, doc, "label"),
      issuer: requiredString(file, doc, "issuer"),
      scopes: requiredString(file, doc, "scopes"),
      clientAuth,
      emailAuthoritative: doc.emailAuthoritative === true,
    };
    const clientId = optionalString(file, doc, "clientId");
    if (clientId !== undefined) descriptor.clientId = clientId;
    if (clientSecret !== undefined) descriptor.clientSecret = clientSecret;
    return descriptor;
  }
  if (kind === "oauth2") {
    assertKnownKeys(file, doc, OAUTH2_KEYS);
    const profileMap = parseProfileMap(file, doc.profileMap);
    const descriptor: OAuth2ProviderDescriptor = {
      id: requiredString(file, doc, "id"),
      kind: "oauth2",
      label: requiredString(file, doc, "label"),
      issuer: requiredString(file, doc, "issuer"),
      authorizationEndpoint: requiredString(file, doc, "authorizationEndpoint"),
      tokenEndpoint: requiredString(file, doc, "tokenEndpoint"),
      userinfoEndpoint: requiredString(file, doc, "userinfoEndpoint"),
      scopes: requiredString(file, doc, "scopes"),
      subjectField: requiredString(file, doc, "subjectField"),
      emailAuthoritative: doc.emailAuthoritative === true,
      clientId: requiredString(file, doc, "clientId"),
      clientSecret: clientSecret ?? "",
    };
    if (profileMap !== undefined) descriptor.profileMap = profileMap;
    const emailsEndpoint = optionalString(file, doc, "emailsEndpoint");
    if (emailsEndpoint !== undefined)
      descriptor.emailsEndpoint = emailsEndpoint;
    return descriptor;
  }
  return fail(file, "kind must be oidc or oauth2");
}

/**
 * Load every `*.provider.json` under the configured directory. Returns `[]`
 * when the directory variable is unset; every failure refuses the boot.
 */
export function loadManifestProviders(
  env: NodeJS.ProcessEnv,
): ProviderDescriptor[] {
  const dir = env[MANIFEST_DIR_ENV];
  if (dir === undefined || dir.length === 0) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new ProviderConfigError(
      `${MANIFEST_DIR_ENV} names ${dir}, which is not readable: ${String(error)}`,
    );
  }
  const providers: ProviderDescriptor[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(MANIFEST_SUFFIX)) continue;
    const path = join(dir, entry);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      throw new ProviderConfigError(
        `provider manifest ${path} is not readable: ${String(error)}`,
      );
    }
    const descriptor = descriptorFrom(entry, asRecord(entry, raw), env);
    assertProviderDescriptor(descriptor);
    providers.push(descriptor);
  }
  return providers;
}
