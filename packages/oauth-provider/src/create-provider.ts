import { generateKeyPairSync } from "node:crypto";
import Provider, { type ClientMetadata, type Configuration } from "oidc-provider";
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

function buildJwks(): NonNullable<Configuration["jwks"]> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwk.kid = "opensesame-1";
  return { keys: [jwk] };
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
  };

  const pairwiseStore = options.pairwiseStore ?? new MemoryPairwiseSubjectStore();
  const admission = createClientAdmissionPolicy(env);
  const metadataFetcher = new SafeMetadataFetcher(env);
  const adapter: OidcAdapterConstructor =
    options.adapter ?? createMemoryAdapterConstructor();

  const configuration: Configuration = {
    adapter,
    clients: options.clients ?? [],
    jwks: options.jwks ?? buildJwks(),
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
        getResourceServerInfo: async (_ctx: unknown, resourceIndicator: string) => ({
          scope: "openid",
          audience: resourceIndicator,
          accessTokenFormat: "jwt",
        }),
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
