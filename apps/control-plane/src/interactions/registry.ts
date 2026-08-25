import { readFileSync } from "node:fs";
import type { ControlPlaneConfig } from "../config.js";

/**
 * The federated provider registry (ADR 0055).
 *
 * One deployment, many upstreams. `OPENSESAME_PROVIDERS` lists the ids that
 * are on offer and each one is configured through `OPENSESAME_PROVIDER_<ID>_*`
 * variables; four ids carry built-in defaults (google, microsoft, github,
 * apple) so a real deployment needs a client id and secret and nothing else,
 * and any other id is fully generic — issuer, kind, endpoints and scopes all
 * come from configuration, which is what makes "any OIDC or OAuth2 provider"
 * a configuration question rather than a code change.
 *
 * The descriptors here are the *static* half of trust: `resolveTrustedIssuer`
 * (`./trust.ts`) consults this registry first, then durable BYO records, then
 * organization SSO. Issuers listed in `OPENSESAME_TRUSTED_UPSTREAMS` without a
 * registry entry are still first-class — they resolve to a synthesized
 * public-client descriptor that behaves exactly as the pre-registry code did,
 * so the origin-profile brokers (shoo.dev, the local reference IdP) keep
 * working unchanged.
 */

export type ProviderKind = "oidc" | "oauth2";

export type OidcProviderDescriptor = {
  id: string;
  kind: "oidc";
  label: string;
  issuer: string;
  /** Space-separated scope string sent on the authorization request. */
  scopes: string;
  clientAuth: "none" | "client_secret_post" | "apple_es256";
  clientId?: string;
  clientSecret?: string;
  /** Apple only: the assertion comes back as a cross-site form POST. */
  responseMode?: "form_post";
  apple?: { teamId: string; keyId: string; privateKeyPem: string };
};

export type OAuth2ProviderDescriptor = {
  id: string;
  kind: "oauth2";
  label: string;
  /** Identity of the upstream on the identity row; not a discovery document. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  scopes: string;
  /**
   * The userinfo field carrying a stable subject. Provider-specific and
   * deliberately explicit: GitHub's `id` is immutable while its `login` is
   * renameable, and a renameable subject is an account-takeover path.
   */
  subjectField: string;
  profileMap?: { email?: string; name?: string; emailVerifiedField?: string };
  /**
   * A second authenticated read that answers "which of this account's
   * addresses has the provider itself confirmed?".
   *
   * Some providers do not put a verified email on the profile document at all.
   * GitHub is the shipped example: `/user` carries the *public* profile email,
   * absent for anyone who keeps it private and never accompanied by a verified
   * flag, while `/user/emails` returns every address with `primary` and
   * `verified` booleans GitHub set itself. Without this read a GitHub sign-in
   * can never satisfy the verified-email policy, so a person signing in with
   * Google and later with GitHub silently gets two accounts.
   *
   * On the descriptor rather than baked into the leg so the leg stays generic;
   * a provider without one behaves exactly as before.
   */
  emailsEndpoint?: string;
  clientId: string;
  clientSecret: string;
};

export type ProviderDescriptor =
  | OidcProviderDescriptor
  | OAuth2ProviderDescriptor;

/** A provider entry that configuration cannot satisfy. Refuses the boot. */
export class ProviderConfigError extends Error {
  override readonly name = "ProviderConfigError";
}

const DEFAULT_OIDC_SCOPES = "openid email profile";
const SHOO_ISSUER = "https://shoo.dev";
const MOCK_UPSTREAM_LABEL = "a local test account";
const MICROSOFT_HOST = "login.microsoftonline.com";
/**
 * Multi-tenant Microsoft endpoints publish the literal template
 * `https://login.microsoftonline.com/{tenantid}/v2.0` as their issuer, which
 * exact-match issuer validation can never satisfy. Tenant-pinned only (D4).
 */
const MICROSOFT_MULTI_TENANT = new Set([
  "common",
  "organizations",
  "consumers",
]);

type BuiltInProvider = {
  kind: ProviderKind;
  label: string;
  issuer?: string;
  scopes?: string;
  responseMode?: "form_post";
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  emailsEndpoint?: string;
  subjectField?: string;
  profileMap?: { email?: string; name?: string; emailVerifiedField?: string };
};

/**
 * Shipped defaults. Endpoint constants for GitHub mirror the values the Host
 * plane's connector catalog uses (`crates/connection-broker/src/catalog.json`)
 * — copied deliberately rather than imported, because the two planes do not
 * share code (ADR 0017).
 */
const BUILT_IN_PROVIDERS: ReadonlyMap<string, BuiltInProvider> = new Map([
  [
    "google",
    { kind: "oidc", label: "Google", issuer: "https://accounts.google.com" },
  ],
  // No issuer default: it is derived from the required tenant id below.
  ["microsoft", { kind: "oidc", label: "Microsoft" }],
  [
    "github",
    {
      kind: "oauth2",
      label: "GitHub",
      issuer: "https://github.com",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      userinfoEndpoint: "https://api.github.com/user",
      emailsEndpoint: "https://api.github.com/user/emails",
      // Only what a sign-in needs: the profile and the addresses GitHub has
      // confirmed. `user:email` is read-only and grants nothing else; without
      // it a GitHub identity can never carry a verified email, and so can
      // never join the account the same person already has (ADR 0057 D15).
      scopes: "read:user user:email",
      subjectField: "id",
      profileMap: { email: "email", name: "name" },
    },
  ],
  [
    "apple",
    {
      kind: "oidc",
      label: "Apple",
      issuer: "https://appleid.apple.com",
      // Apple's own scope values; it has no `profile` scope.
      scopes: "openid email name",
      responseMode: "form_post",
    },
  ],
]);

/** Trailing slashes are not part of an issuer's identity. */
export function normalizeIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

function isLoopbackIssuer(issuer: string): boolean {
  const [host] = issuerHost(issuer).split(":");
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * Id and label for an issuer that is allowlisted but has no registry entry.
 * Mirrors `describeUpstream` in `./federated.ts` and the Pages
 * `TRUSTED_UPSTREAMS` table so all three surfaces name the same broker the
 * same way — shoo.dev fronts Google, so its button says Google.
 */
type UpstreamIdentity = { id: string; label: string };

function describeIssuer(issuer: string): UpstreamIdentity {
  if (normalizeIssuer(issuer) === SHOO_ISSUER) {
    return { id: "shoo", label: "Google" };
  }
  if (isLoopbackIssuer(issuer)) {
    return { id: "mock", label: MOCK_UPSTREAM_LABEL };
  }
  const host = issuerHost(issuer);
  return { id: host, label: host };
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function providerEnvPrefix(id: string): string {
  return `OPENSESAME_PROVIDER_${id.toUpperCase()}_`;
}

/** Ids become environment variable names, so they must be name-safe. */
function assertProviderId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_]*$/.test(id)) {
    throw new ProviderConfigError(
      `OPENSESAME_PROVIDERS entry \`${id}\` is not a usable provider id; use lowercase letters, digits and underscores`,
    );
  }
}

function assertIssuerUrl(id: string, issuer: string): void {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new ProviderConfigError(
      `${providerEnvPrefix(id)}ISSUER is not a URL: \`${issuer}\``,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderConfigError(
      `${providerEnvPrefix(id)}ISSUER must be an http(s) URL: \`${issuer}\``,
    );
  }
  if (url.username || url.password) {
    throw new ProviderConfigError(
      `${providerEnvPrefix(id)}ISSUER must not carry credentials`,
    );
  }
  if (url.host === MICROSOFT_HOST) {
    // `new URL` percent-encodes the braces of a `{tenantid}` template, so the
    // segment is decoded before it is judged.
    const [rawTenant] = url.pathname.replace(/^\/+/, "").split("/");
    const tenant = decodeURIComponent(rawTenant ?? "");
    if (
      tenant.length === 0 ||
      MICROSOFT_MULTI_TENANT.has(tenant) ||
      tenant.includes("{")
    ) {
      throw new ProviderConfigError(
        `${providerEnvPrefix(id)}TENANT must name one tenant: Microsoft's multi-tenant endpoints (${[...MICROSOFT_MULTI_TENANT].join(", ")}) publish a templated issuer that can never match the assertion`,
      );
    }
  }
}

/**
 * Every invariant a descriptor must hold, wherever it came from. The parser
 * below runs it per entry so a bad environment fails at boot, and
 * `assertSecureConfig` runs it again over `config.providers` so a config that
 * reached the server another way (a `Partial` merge in a test, a future
 * caller) cannot smuggle a half-configured provider past it.
 */
export function assertProviderDescriptor(provider: ProviderDescriptor): void {
  assertProviderId(provider.id);
  if (provider.label.length === 0) {
    throw new ProviderConfigError(
      `${providerEnvPrefix(provider.id)}LABEL must not be empty`,
    );
  }
  assertIssuerUrl(provider.id, provider.issuer);

  if (provider.kind === "oauth2") {
    for (const [name, value] of [
      ["AUTHORIZE_URL", provider.authorizationEndpoint],
      ["TOKEN_URL", provider.tokenEndpoint],
      ["USERINFO_URL", provider.userinfoEndpoint],
      ["SUBJECT_FIELD", provider.subjectField],
      ["CLIENT_ID", provider.clientId],
      ["CLIENT_SECRET", provider.clientSecret],
    ]) {
      if (value === undefined || value.length === 0) {
        throw new ProviderConfigError(
          `${providerEnvPrefix(provider.id)}${name} is required for an oauth2 provider`,
        );
      }
    }
    return;
  }

  if (provider.clientSecret !== undefined && provider.clientId === undefined) {
    throw new ProviderConfigError(
      `${providerEnvPrefix(provider.id)}CLIENT_SECRET needs ${providerEnvPrefix(provider.id)}CLIENT_ID: a secret has nobody to authenticate as`,
    );
  }
  if (provider.clientAuth === "client_secret_post") {
    if (!provider.clientId || !provider.clientSecret) {
      throw new ProviderConfigError(
        `${providerEnvPrefix(provider.id)}CLIENT_ID and ${providerEnvPrefix(provider.id)}CLIENT_SECRET are both required for a confidential client`,
      );
    }
  }
  if (provider.clientAuth === "apple_es256") {
    const apple = provider.apple;
    if (
      !provider.clientId ||
      !apple ||
      !apple.teamId ||
      !apple.keyId ||
      !apple.privateKeyPem
    ) {
      throw new ProviderConfigError(
        `${providerEnvPrefix(provider.id)}TEAM_ID, ${providerEnvPrefix(provider.id)}KEY_ID and ${providerEnvPrefix(provider.id)}PRIVATE_KEY (or _PRIVATE_KEY_FILE) are all required alongside ${providerEnvPrefix(provider.id)}CLIENT_ID`,
      );
    }
    if (provider.responseMode !== "form_post") {
      throw new ProviderConfigError(
        `provider \`${provider.id}\` signs its client secret with ES256 but does not use response_mode=form_post; that combination is Apple's, and Apple returns the assertion by form POST`,
      );
    }
  }
}

function readAppleKey(
  env: NodeJS.ProcessEnv,
  prefix: string,
): { teamId: string; keyId: string; privateKeyPem: string } | undefined {
  const teamId = readEnv(env, `${prefix}TEAM_ID`);
  const keyId = readEnv(env, `${prefix}KEY_ID`);
  const inline = readEnv(env, `${prefix}PRIVATE_KEY`);
  const file = readEnv(env, `${prefix}PRIVATE_KEY_FILE`);
  if (!teamId && !keyId && !inline && !file) return undefined;

  let privateKeyPem = inline ?? "";
  if (!privateKeyPem && file) {
    try {
      privateKeyPem = readFileSync(file, "utf8").trim();
    } catch (cause) {
      // The path is operator configuration and safe to name; the key is not,
      // and never reaches this message.
      throw new ProviderConfigError(
        `${prefix}PRIVATE_KEY_FILE could not be read: \`${file}\``,
        { cause },
      );
    }
  }
  return {
    teamId: teamId ?? "",
    keyId: keyId ?? "",
    privateKeyPem,
  };
}

function readProvider(env: NodeJS.ProcessEnv, id: string): ProviderDescriptor {
  assertProviderId(id);
  const prefix = providerEnvPrefix(id);
  const builtIn = BUILT_IN_PROVIDERS.get(id);
  const kindValue = readEnv(env, `${prefix}KIND`) ?? builtIn?.kind ?? "oidc";
  if (kindValue !== "oidc" && kindValue !== "oauth2") {
    throw new ProviderConfigError(
      `${prefix}KIND must be \`oidc\` or \`oauth2\`; got \`${kindValue}\``,
    );
  }
  const label = readEnv(env, `${prefix}LABEL`) ?? builtIn?.label ?? id;
  const clientId = readEnv(env, `${prefix}CLIENT_ID`);
  const clientSecret = readEnv(env, `${prefix}CLIENT_SECRET`);

  const configuredIssuer = readEnv(env, `${prefix}ISSUER`);
  const tenant = readEnv(env, `${prefix}TENANT`);
  const issuer =
    configuredIssuer ??
    (id === "microsoft" && tenant
      ? `https://${MICROSOFT_HOST}/${tenant}/v2.0`
      : builtIn?.issuer);
  if (!issuer) {
    throw new ProviderConfigError(
      id === "microsoft"
        ? `${prefix}TENANT is required: Microsoft sign-in is tenant-pinned (D4)`
        : `${prefix}ISSUER is required for provider \`${id}\``,
    );
  }

  if (kindValue === "oauth2") {
    const descriptor: OAuth2ProviderDescriptor = {
      id,
      kind: "oauth2",
      label,
      issuer: normalizeIssuer(issuer),
      authorizationEndpoint:
        readEnv(env, `${prefix}AUTHORIZE_URL`) ??
        builtIn?.authorizationEndpoint ??
        "",
      tokenEndpoint:
        readEnv(env, `${prefix}TOKEN_URL`) ?? builtIn?.tokenEndpoint ?? "",
      userinfoEndpoint:
        readEnv(env, `${prefix}USERINFO_URL`) ??
        builtIn?.userinfoEndpoint ??
        "",
      scopes: readEnv(env, `${prefix}SCOPES`) ?? builtIn?.scopes ?? "",
      subjectField:
        readEnv(env, `${prefix}SUBJECT_FIELD`) ?? builtIn?.subjectField ?? "",
      clientId: clientId ?? "",
      clientSecret: clientSecret ?? "",
      // Optional everywhere: a provider that puts a verified address on the
      // profile document needs no second read, and one that offers neither
      // simply never carries a verified email.
      ...(() => {
        const emails =
          readEnv(env, `${prefix}EMAILS_URL`) ?? builtIn?.emailsEndpoint;
        return emails ? { emailsEndpoint: emails } : undefined;
      })(),
      ...(builtIn?.profileMap ? { profileMap: builtIn.profileMap } : undefined),
    };
    return descriptor;
  }

  const apple = readAppleKey(env, prefix);
  const clientAuth = apple
    ? "apple_es256"
    : clientSecret
      ? "client_secret_post"
      : "none";
  const responseMode =
    clientAuth === "apple_es256" ? "form_post" : builtIn?.responseMode;
  const descriptor: OidcProviderDescriptor = {
    id,
    kind: "oidc",
    label,
    issuer: normalizeIssuer(issuer),
    scopes:
      readEnv(env, `${prefix}SCOPES`) ?? builtIn?.scopes ?? DEFAULT_OIDC_SCOPES,
    clientAuth,
    ...(clientId !== undefined ? { clientId } : undefined),
    ...(clientSecret !== undefined ? { clientSecret } : undefined),
    ...(responseMode !== undefined ? { responseMode } : undefined),
    ...(apple !== undefined ? { apple } : undefined),
  };
  return descriptor;
}

/**
 * The pre-registry confidential credential (`OPENSESAME_UPSTREAM_ISSUER` and
 * friends) as a registry entry, so trust resolution has one shape to reason
 * about. `config.upstreamClientCredentials` keeps its own field for the
 * callers that already read it; this is the same three values, described.
 */
function legacyUpstreamProvider(
  env: NodeJS.ProcessEnv,
): ProviderDescriptor | undefined {
  const issuer = normalizeIssuer(env.OPENSESAME_UPSTREAM_ISSUER ?? "");
  const clientId = readEnv(env, "OPENSESAME_UPSTREAM_CLIENT_ID");
  const clientSecret = readEnv(env, "OPENSESAME_UPSTREAM_CLIENT_SECRET");
  if (!issuer || !clientId || !clientSecret) return undefined;
  const { id, label } = describeIssuer(issuer);
  return {
    id,
    kind: "oidc",
    label,
    issuer,
    scopes: DEFAULT_OIDC_SCOPES,
    clientAuth: "client_secret_post",
    clientId,
    clientSecret,
  };
}

/** Parse `OPENSESAME_PROVIDERS` and its per-provider variables (D1). */
export function loadProviderRegistry(
  env: NodeJS.ProcessEnv,
): ProviderDescriptor[] {
  const ids = (env.OPENSESAME_PROVIDERS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const providers: ProviderDescriptor[] = [];
  const seenIds = new Set<string>();
  const seenIssuers = new Set<string>();
  for (const id of ids) {
    if (seenIds.has(id)) continue;
    const descriptor = readProvider(env, id);
    assertProviderDescriptor(descriptor);
    const issuer = normalizeIssuer(descriptor.issuer);
    if (seenIssuers.has(issuer)) {
      throw new ProviderConfigError(
        `two OPENSESAME_PROVIDERS entries configure the same issuer \`${issuer}\`; trust resolution must map an issuer to exactly one provider`,
      );
    }
    seenIds.add(id);
    seenIssuers.add(issuer);
    providers.push(descriptor);
  }

  const legacy = legacyUpstreamProvider(env);
  if (
    legacy &&
    !seenIds.has(legacy.id) &&
    !seenIssuers.has(normalizeIssuer(legacy.issuer))
  ) {
    providers.push(legacy);
  }
  return providers;
}

/**
 * Registry issuers merged into the trusted allowlist. A configured provider is
 * a trusted provider by construction: leaving the two apart would mean an
 * operator could list google in `OPENSESAME_PROVIDERS`, have every sign-in
 * refused as `untrusted_issuer`, and read nothing about why.
 */
export function mergeProviderIssuers(
  allowlist: readonly string[],
  providers: readonly ProviderDescriptor[],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const issuer of [
    ...allowlist,
    ...providers.map((provider) => provider.issuer),
  ]) {
    const normalized = normalizeIssuer(issuer);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

/**
 * The registry as configured. `providers` is a required field, but
 * `assertSecureConfig` is documented as the boundary that fails closed after a
 * `Partial<ControlPlaneConfig>` merge, so reads go through here rather than
 * assuming every caller-built config carries it.
 */
export function configuredProviders(
  config: ControlPlaneConfig,
): readonly ProviderDescriptor[] {
  return config.providers ?? [];
}

/**
 * Descriptor for an allowlisted issuer with no registry entry: a public
 * origin-profile client (ADR 0034), or the legacy confidential credential when
 * one is configured for exactly that issuer. This is what keeps
 * `OPENSESAME_TRUSTED_UPSTREAMS`-only deployments working unchanged.
 */
function synthesizeAllowlistProvider(
  config: ControlPlaneConfig,
  issuer: string,
): OidcProviderDescriptor {
  const normalized = normalizeIssuer(issuer);
  const { id, label } = describeIssuer(normalized);
  const legacy = config.upstreamClientCredentials;
  if (legacy && normalizeIssuer(legacy.issuer) === normalized) {
    return {
      id,
      kind: "oidc",
      label,
      issuer: normalized,
      scopes: DEFAULT_OIDC_SCOPES,
      clientAuth: "client_secret_post",
      clientId: legacy.clientId,
      clientSecret: legacy.clientSecret,
    };
  }
  return {
    id,
    kind: "oidc",
    label,
    issuer: normalized,
    scopes: DEFAULT_OIDC_SCOPES,
    clientAuth: "none",
  };
}

/**
 * Every statically trusted provider, in the order the login page offers them:
 * the allowlist first (registry entries win over synthesis for the same
 * issuer), then any registry provider not in the allowlist.
 */
export function staticProviders(
  config: ControlPlaneConfig,
): ProviderDescriptor[] {
  const byIssuer = new Map<string, ProviderDescriptor>();
  for (const provider of configuredProviders(config)) {
    byIssuer.set(normalizeIssuer(provider.issuer), provider);
  }
  const ordered: ProviderDescriptor[] = [];
  const seen = new Set<string>();
  for (const issuer of config.trustedUpstreamIssuers ?? []) {
    const normalized = normalizeIssuer(issuer);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(
      byIssuer.get(normalized) ?? synthesizeAllowlistProvider(config, issuer),
    );
  }
  for (const provider of configuredProviders(config)) {
    if (seen.has(normalizeIssuer(provider.issuer))) continue;
    seen.add(normalizeIssuer(provider.issuer));
    ordered.push(provider);
  }
  return ordered;
}

/**
 * The catalog as a human should see it: one entry per provider id.
 *
 * `staticProviders` is the *trust* surface and lists one descriptor per trusted
 * issuer, which is what `providerByIssuer` and the fence need. It is not what a
 * sign-in page should render, because one provider can legitimately be trusted
 * at more than one issuer — the dev allowlist trusts the reference IdP as both
 * `http://127.0.0.1:9090` and `http://localhost:9090`, two names for one
 * server, and both synthesize the id `mock`. Rendering the trust surface
 * directly put two identical "a local test account" buttons on the login page,
 * the Pages first-run screen and the console.
 *
 * First wins, which is allowlist order, so a deployment's canonical name is the
 * one offered. Nothing is dropped from the trust surface: an authorization
 * response arriving from either alias still resolves, because that lookup goes
 * through `providerByIssuer` against the full list.
 */
export function catalogProviders(
  config: ControlPlaneConfig,
): ProviderDescriptor[] {
  const byId = new Map<string, ProviderDescriptor>();
  for (const provider of staticProviders(config)) {
    const id = provider.id.toLowerCase();
    if (!byId.has(id)) byId.set(id, provider);
  }
  return [...byId.values()];
}

/** Statically trusted provider with this registry id, if any. */
export function providerById(
  config: ControlPlaneConfig,
  id: string,
): ProviderDescriptor | undefined {
  const needle = id.trim().toLowerCase();
  if (!needle) return undefined;
  return staticProviders(config).find(
    (provider) => provider.id.toLowerCase() === needle,
  );
}

/** Statically trusted provider for this issuer, trailing slash or not. */
export function providerByIssuer(
  config: ControlPlaneConfig,
  issuer: string,
): ProviderDescriptor | undefined {
  const needle = normalizeIssuer(issuer);
  if (!needle) return undefined;
  return staticProviders(config).find(
    (provider) => normalizeIssuer(provider.issuer) === needle,
  );
}

/**
 * Can a static page finish this leg itself (D7)?
 *
 * Only the origin-profile brokers can: they serve CORS on the token endpoint
 * and take no client secret. Google, Microsoft, GitHub and Apple serve no CORS
 * there — a browser physically cannot complete the exchange, which is the
 * whole reason the control plane brokers them.
 */
export function isBrowserCapable(provider: ProviderDescriptor): boolean {
  if (provider.kind !== "oidc" || provider.clientAuth !== "none") return false;
  const issuer = normalizeIssuer(provider.issuer);
  return issuer === SHOO_ISSUER || isLoopbackIssuer(issuer);
}
