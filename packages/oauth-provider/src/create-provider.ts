import { generateKeyPairSync } from "node:crypto";
import Provider, { errors, type ClientMetadata, type Configuration } from "oidc-provider";
import { createMemoryAdapterConstructor } from "./adapter/memory-adapter.js";
import type { OidcAdapterConstructor } from "./adapter/types.js";
import { createClientAdmissionPolicy } from "./clients/admission.js";
import { readOAuthProviderEnv } from "./env.js";
import { SafeMetadataFetcher } from "./metadata/safe-fetcher.js";
import {
  createPairwiseIdentifierCallback,
  MemoryPairwiseSubjectStore,
} from "./pairwise/store.js";
import type { OAuthProviderEnv, PairwiseSubjectStore } from "./types.js";

export interface CreateOpenSesameProviderOptions {
  issuer?: string;
  env?: Partial<OAuthProviderEnv>;
  processEnv?: NodeJS.ProcessEnv;
  adapter?: OidcAdapterConstructor;
  pairwiseStore?: PairwiseSubjectStore;
  clients?: ClientMetadata[];
  /** When omitted, MemoryAdapter is used (tests / local). Production should pass Postgres adapter. */
  jwks?: Configuration["jwks"];
}

export interface OpenSesameProviderBundle {
  provider: Provider;
  env: OAuthProviderEnv;
  pairwiseStore: PairwiseSubjectStore;
  admission: ReturnType<typeof createClientAdmissionPolicy>;
  metadataFetcher: SafeMetadataFetcher;
  configuration: Configuration;
}

/**
 * Canonical form of a resource indicator (RFC 8707 §2): absolute URI, no
 * fragment, no query, case-normalized scheme/host, no trailing slash.
 * Returns null when the value is not usable as a resource indicator.
 */
export function canonicalResource(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || url.search) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
}

/**
 * Whether this issuer will mint an access token audienced to `resource`.
 * With no configured allowlist the only accepted audience is the issuer itself.
 */
export function isResourceAllowed(
  resource: string,
  allowed: readonly string[],
  issuer: string,
): boolean {
  const target = canonicalResource(resource);
  if (!target) return false;
  const permitted = (allowed.length > 0 ? allowed : [issuer])
    .map((entry) => canonicalResource(entry))
    .filter((entry): entry is string => entry !== null);
  return permitted.includes(target);
}

function buildJwks(): NonNullable<Configuration["jwks"]> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwk.kid = "opensesame-1";
  return { keys: [jwk] };
}

/**
 * Signing keys, in order: explicit option, `OPENSESAME_JWKS_JSON`, then a
 * process-local dev keypair. Production never reaches the dev keypair.
 */
function resolveJwks(
  options: CreateOpenSesameProviderOptions,
  env: OAuthProviderEnv,
  processEnv: NodeJS.ProcessEnv,
): NonNullable<Configuration["jwks"]> {
  if (options.jwks) return options.jwks;
  const raw = processEnv.OPENSESAME_JWKS_JSON;
  if (raw) {
    let parsed: { keys?: Record<string, unknown>[] };
    try {
      parsed = JSON.parse(raw) as { keys?: Record<string, unknown>[] };
    } catch {
      throw new Error("OPENSESAME_JWKS_JSON is not valid JSON");
    }
    if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
      throw new Error("OPENSESAME_JWKS_JSON must contain a non-empty `keys` array");
    }
    return { keys: parsed.keys };
  }
  if (env.isProduction) {
    throw new Error(
      "createOpenSesameProvider: signing keys are required in production — pass `jwks` or set OPENSESAME_JWKS_JSON (refusing an ephemeral per-process keypair)",
    );
  }
  return buildJwks();
}

/**
 * Configure panva `oidc-provider` for the OpenSesame downstream issuer.
 *
 * Features: authorization_code (+ PKCE S256 required), refresh, device_authorization,
 * revocation, introspection, userinfo, PAR, resourceIndicators, dPoP.
 * DCR/CIMD off by default; origin clients gated by OPENSESAME_ORIGIN_CLIENTS_ENABLED.
 */
export function createOpenSesameProvider(
  options: CreateOpenSesameProviderOptions = {},
): OpenSesameProviderBundle {
  const baseEnv = readOAuthProviderEnv(options.processEnv ?? process.env);
  const env: OAuthProviderEnv = {
    originClientsEnabled: options.env?.originClientsEnabled ?? baseEnv.originClientsEnabled,
    dcrEnabled: options.env?.dcrEnabled ?? baseEnv.dcrEnabled,
    cimdEnabled: options.env?.cimdEnabled ?? baseEnv.cimdEnabled,
    issuer: options.issuer ?? options.env?.issuer ?? baseEnv.issuer,
    allowedResources: options.env?.allowedResources ?? baseEnv.allowedResources,
    isProduction: options.env?.isProduction ?? baseEnv.isProduction,
  };

  // Fail closed: an ephemeral keypair or in-memory grant state in production means
  // tokens die on restart, replicas cannot verify each other, and revocation is
  // per-process. Both must be supplied explicitly.
  const jwks = resolveJwks(options, env, options.processEnv ?? process.env);
  if (env.isProduction && !options.adapter) {
    throw new Error(
      "createOpenSesameProvider: a persistent adapter is required in production (refusing MemoryAdapter, which loses grants and makes revocation per-process)",
    );
  }

  const pairwiseStore = options.pairwiseStore ?? new MemoryPairwiseSubjectStore();
  const admission = createClientAdmissionPolicy(env);
  const metadataFetcher = new SafeMetadataFetcher(env);
  const adapter: OidcAdapterConstructor =
    options.adapter ?? createMemoryAdapterConstructor();

  const configuration: Configuration = {
    adapter,
    clients: options.clients ?? [],
    jwks,
    subjectTypes: ["pairwise"],
    pairwiseIdentifier: createPairwiseIdentifierCallback(pairwiseStore),
    pkce: {
      // Always require PKCE. oidc-provider only supports S256 challenge method.
      required: () => true,
    },
    scopes: ["openid", "offline_access", "profile", "email"],
    features: {
      devInteractions: { enabled: false },
      deviceFlow: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
      userinfo: { enabled: true },
      pushedAuthorizationRequests: { enabled: true },
      dPoP: { enabled: true, allowReplay: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => undefined,
        getResourceServerInfo: async (_ctx: unknown, resourceIndicator: string) => {
          // Without this check any client could obtain a signed JWT audienced to
          // an arbitrary resource server (RFC 8707 invalid_target).
          if (!isResourceAllowed(resourceIndicator, env.allowedResources, env.issuer)) {
            throw new errors.InvalidTarget(
              "resource indicator is not an allowed resource server",
            );
          }
          return {
            scope: "openid",
            audience: canonicalResource(resourceIndicator) ?? resourceIndicator,
            accessTokenFormat: "jwt",
          };
        },
        useGrantedResource: async () => false,
      },
      registration: { enabled: env.dcrEnabled },
      registrationManagement: { enabled: env.dcrEnabled },
      clientCredentials: { enabled: false },
    },
    claims: {
      openid: ["sub"],
      profile: ["name"],
      email: ["email"],
    },
    findAccount: async (_ctx, id) => ({
      accountId: id,
      async claims() {
        return { sub: id };
      },
    }),
  };

  const provider = new Provider(env.issuer, configuration);

  return {
    provider,
    env,
    pairwiseStore,
    admission,
    metadataFetcher,
    configuration,
  };
}

/** Whether PKCE is required under the current configuration. */
export function isPkceRequired(
  bundle: OpenSesameProviderBundle,
  ctx: unknown = {},
  client: unknown = {},
): boolean {
  const required = bundle.configuration.pkce?.required;
  if (!required) return false;
  return required(ctx as never, client);
}
