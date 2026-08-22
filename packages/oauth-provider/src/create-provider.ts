import { generateKeyPairSync } from "node:crypto";
import {
  type BoundaryValue,
  type JsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import Provider, {
  errors,
  type ClientMetadata,
  type Configuration,
} from "oidc-provider";
import { withDynamicClientLoader } from "./adapter/dynamic-client-adapter.js";
import { createMemoryAdapterConstructor } from "./adapter/memory-adapter.js";
import type { OidcAdapterConstructor } from "./adapter/types.js";
import { createClientAdmissionPolicy } from "./clients/admission.js";
import {
  findOriginClient,
  resolveOriginClient,
  toOidcClientMetadata,
} from "./clients/origin-resolve.js";
import {
  type ClientRecordStore,
  MemoryClientRecordStore,
} from "./clients/store.js";
import { readOAuthProviderEnv } from "./env.js";
import { SafeMetadataFetcher } from "./metadata/safe-fetcher.js";
import { parseOriginClientId } from "./origin/canonical.js";
import {
  MemoryPairwiseSubjectStore,
  createPairwiseIdentifierCallback,
} from "./pairwise/store.js";
import type {
  OAuthClientRecord,
  OAuthProviderEnv,
  PairwiseSubjectStore,
} from "./types.js";

export interface CreateOpenSesameProviderOptions {
  issuer?: string;
  env?: Partial<OAuthProviderEnv>;
  processEnv?: NodeJS.ProcessEnv;
  adapter?: OidcAdapterConstructor;
  pairwiseStore?: PairwiseSubjectStore;
  /**
   * Durable client records (ADR 0050 R-C). Defaults to an in-memory store
   * seeded from `options.clients`, so existing callers behave unchanged.
   */
  clientStore?: ClientRecordStore;
  clients?: ClientMetadata[];
  /**
   * Deployment/system principal that owns newly auto-admitted origin clients
   * (ADR 0050 R-A). Optional so existing callers behave unchanged; the
   * control plane always passes it.
   */
  systemOwnerPrincipalId?: string;
  /** When omitted, MemoryAdapter is used (tests / local). Production should pass Postgres adapter. */
  jwks?: Configuration["jwks"];
}

type OidcAccountContext = BoundaryValue;

export interface OpenSesameProviderBundle {
  provider: Provider;
  env: OAuthProviderEnv;
  pairwiseStore: PairwiseSubjectStore;
  clientStore: ClientRecordStore;
  admission: ReturnType<typeof createClientAdmissionPolicy>;
  metadataFetcher: SafeMetadataFetcher;
  configuration: Configuration;
  /**
   * Admit (or load) an origin_profile public client — authorization path
   * only, never the token path (ADR 0050 F2). Throws when the origin
   * admission flag is off or the origin is not canonicalizable.
   */
  ensureOriginClient: (
    rawOriginOrClientId: string,
  ) => Promise<ReturnType<typeof toOidcClientMetadata>>;
  /**
   * Lookup-only variant: never inserts, safe for unauthenticated token-path
   * decisions such as exact-origin CORS (ADR 0050 F3).
   */
  lookupOriginClient: (
    rawOriginOrClientId: string,
  ) => Promise<ReturnType<typeof toOidcClientMetadata> | undefined>;
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

/**
 * Federated upstream hints the browser SDK appends to the authorize URL
 * (`packages/sdk-browser` `signIn({ provider })`): `kc_idp_hint` for Keycloak
 * wire compatibility and `login_hint_provider` as the OpenSesame-native name.
 * oidc-provider drops unregistered authorization parameters, so both must be
 * declared here for the hosted login page to read them off
 * `interaction.details.params` and preselect an upstream provider.
 */
export const FEDERATED_PROVIDER_HINT_PARAMS = [
  "kc_idp_hint",
  "login_hint_provider",
] as const;

/**
 * Upstream provider aliases are short identifiers, never markup or URLs.
 * Anything outside this shape is a hint we cannot honour, so it is dropped
 * rather than rejected: an unusable hint must never fail an otherwise valid
 * authorization request, and must never reach the login page as a value a
 * renderer could be tempted to trust.
 */
const PROVIDER_HINT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Per-param validator. oidc-provider runs these for every registered extra
 * param regardless of presence, so this normalizes in place instead of
 * throwing: a conforming value survives to the interaction session, anything
 * else becomes `undefined` and is omitted from the persisted params.
 */
function createProviderHintValidator(
  name: string,
): (ctx: BoundaryValue, value: string | undefined) => void {
  return (ctx, value) => {
    if (value === undefined) return;
    if (isString(value) && PROVIDER_HINT_PATTERN.test(value)) return;
    const scope: { oidc?: { params?: JsonObject } } = overlapCast(ctx);
    const params = scope.oidc?.params;
    if (params) params[name] = undefined;
  };
}

/** `extraParams` entry: both hint names, each normalized on the way in. */
function buildProviderHintParams(): Record<
  string,
  (ctx: BoundaryValue, value: string | undefined) => void
> {
  return Object.fromEntries(
    FEDERATED_PROVIDER_HINT_PARAMS.map((name) => [
      name,
      createProviderHintValidator(name),
    ]),
  );
}

function buildJwks(): NonNullable<Configuration["jwks"]> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = overlapCast(privateKey.export({ format: "jwk" }));
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
    let parsed: { keys?: JsonObject[] };
    try {
      parsed = overlapCast(JSON.parse(raw));
    } catch {
      throw new Error("OPENSESAME_JWKS_JSON is not valid JSON");
    }
    if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
      throw new Error(
        "OPENSESAME_JWKS_JSON must contain a non-empty `keys` array",
      );
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
 * Map a static oidc-provider `ClientMetadata` entry into a client record for
 * the store default, so existing static-only callers behave unchanged.
 */
function recordFromClientMetadata(meta: ClientMetadata): OAuthClientRecord {
  const sectorIdentifierUri = isString(meta.sector_identifier_uri)
    ? meta.sector_identifier_uri
    : undefined;
  const scope = isString(meta.scope) ? meta.scope : undefined;
  const tokenEndpointAuthMethod = isString(meta.token_endpoint_auth_method)
    ? meta.token_endpoint_auth_method
    : "client_secret_basic";
  let sector = meta.client_id;
  if (sectorIdentifierUri) {
    sector = sectorIdentifierUri;
  } else if (meta.redirect_uris?.[0]) {
    try {
      sector = new URL(meta.redirect_uris[0]).host;
    } catch {
      /* keep client_id fallback */
    }
  }
  return {
    id: meta.client_id,
    admissionMode: "pre_registered",
    displayName: isString(meta.client_name) ? meta.client_name : meta.client_id,
    redirectUris: meta.redirect_uris ?? [],
    sectorIdentifier: sector,
    grantTypes: meta.grant_types ?? ["authorization_code"],
    responseTypes: meta.response_types ?? ["code"],
    tokenEndpointAuthMethod,
    allowedScopes: scope ? scope.split(" ") : ["openid"],
    allowedResources: [],
    state: "active",
  };
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
    originClientsEnabled:
      options.env?.originClientsEnabled ?? baseEnv.originClientsEnabled,
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
  if (env.isProduction && !options.pairwiseStore) {
    throw new Error(
      "createOpenSesameProvider: a persistent pairwise subject store is required in production (refusing MemoryPairwiseSubjectStore, which mints a new sub per process)",
    );
  }

  const pairwiseStore =
    options.pairwiseStore ?? new MemoryPairwiseSubjectStore();
  const admission = createClientAdmissionPolicy(env);
  const metadataFetcher = new SafeMetadataFetcher(env);
  const baseAdapter: OidcAdapterConstructor =
    options.adapter ?? createMemoryAdapterConstructor();

  const staticClients = options.clients ?? [];
  let clientStore: ClientRecordStore;
  if (options.clientStore) {
    clientStore = options.clientStore;
  } else {
    const memory = new MemoryClientRecordStore();
    memory.seed(staticClients.map(recordFromClientMetadata));
    clientStore = memory;
  }

  // Lookup-only dynamic resolution (ADR 0050 F2): registered/persisted clients
  // become real OIDC clients through the adapter, but a `Client` find never
  // inserts — origin auto-admission lives on the /auth prefetch path.
  const adapter = withDynamicClientLoader(baseAdapter, async (clientId) => {
    const record = await clientStore.findById(clientId);
    if (!record) return undefined;
    try {
      admission.assertAdmissible(record);
    } catch {
      // Inadmissible (suspended/revoked/flag-disabled) clients resolve as
      // unknown: oidc-provider answers invalid_client instead of a 500, and
      // the failure stays closed either way.
      return undefined;
    }
    return toOidcClientMetadata(record);
  });

  const configuration: Configuration = {
    adapter,
    clients: staticClients,
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
        getResourceServerInfo: async (
          _ctx: BoundaryValue,
          resourceIndicator: string,
        ) => {
          // Without this check any client could obtain a signed JWT audienced to
          // an arbitrary resource server (RFC 8707 invalid_target).
          if (
            !isResourceAllowed(
              resourceIndicator,
              env.allowedResources,
              env.issuer,
            )
          ) {
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
    // Federated upstream hints sent by the browser SDK survive into
    // `interaction.details.params` so the hosted login page can preselect the
    // caller's provider. Values are normalized, never trusted or echoed.
    extraParams: buildProviderHintParams(),
    findAccount: async (_ctx: OidcAccountContext, id: string) => ({
      accountId: id,
      async claims() {
        return { sub: id };
      },
    }),
  };

  const provider = new Provider(env.issuer, configuration);

  async function ensureOriginClient(rawOriginOrClientId: string) {
    const asOrigin =
      parseOriginClientId(rawOriginOrClientId) ?? rawOriginOrClientId;
    const record = await resolveOriginClient({
      store: clientStore,
      admission,
      origin: asOrigin,
      allowLoopbackHttp: true,
      production: env.isProduction,
      ...(options.systemOwnerPrincipalId
        ? { systemOwnerPrincipalId: options.systemOwnerPrincipalId }
        : undefined),
    });
    return toOidcClientMetadata(record);
  }

  async function lookupOriginClient(rawOriginOrClientId: string) {
    const asOrigin =
      parseOriginClientId(rawOriginOrClientId) ?? rawOriginOrClientId;
    const record = await findOriginClient({
      store: clientStore,
      admission,
      origin: asOrigin,
      allowLoopbackHttp: true,
      production: env.isProduction,
    });
    return record ? toOidcClientMetadata(record) : undefined;
  }

  return {
    provider,
    env,
    pairwiseStore,
    clientStore,
    admission,
    metadataFetcher,
    configuration,
    ensureOriginClient,
    lookupOriginClient,
  };
}

/** Whether PKCE is required under the current configuration. */
export function isPkceRequired(
  bundle: OpenSesameProviderBundle,
  ctx: BoundaryValue = {},
  client: BoundaryValue = {},
): boolean {
  const required = bundle.configuration.pkce?.required;
  if (!required) return false;
  return required(overlapCast(ctx), client);
}
