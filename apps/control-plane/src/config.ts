export interface ControlPlaneConfig {
  host: string;
  port: number;
  publicUrl: string;
  issuer: string;
  claimPepper: string;
  provisionalCookieName: string;
  provisionalTtlMs: number;
  databaseUrl?: string;
  logLevel: string;
  /**
   * When true, `Authorization: Bearer prn_…` is accepted (tests/dev only).
   * Must never be enabled in production.
   */
  allowPrincipalBearer: boolean;
  /** Explicit opt-in to default claim pepper and other local-only shortcuts. */
  allowDevDefaults: boolean;
  /** Give a local provisional principal one owner workspace for the bundled Host. */
  bootstrapPersonalOrganization: boolean;
  isProduction: boolean;
  /** Explicit CORS allowlist (comma-separated origins via OPENSESAME_CORS_ORIGINS). */
  corsOrigins: string[];
  /** Host API base for server-side device approve proxy (never expose operator token to browsers). */
  hostApiUrl: string;
  /** Server-only operator token for Host API mutations. Empty in production if unset. */
  operatorToken: string;
  /**
   * Shared secret for Host → Identity principal mapping resolve.
   * Empty rejects mapping resolve in production; allowDevDefaults may omit in tests.
   */
  mappingResolveToken: string;
  /**
   * Issuers allowed to promote a provisional principal via a verified
   * `id_token` on POST /v1/principals/link-identities (ADR 0033).
   */
  trustedUpstreamIssuers: string[];
  protocolFeatures: {
    oid4vp: boolean;
    oid4vci: boolean;
    fedcm: boolean;
    digitalCredentialsApi: boolean;
    openidFederation: boolean;
    sdJwtVc: boolean;
    tokenStatusList: boolean;
    presentationAgentIntents: boolean;
  };
}

const DEV_CLAIM_PEPPER = "dev-claim-pepper-change-me";

function truthy(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

/** True when a bind host is loopback (matches Rust host-core daemon policy). */
export function listenHostIsLoopback(host: string): boolean {
  const h = host.trim().replace(/^\[/, "").replace(/\]$/, "");
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1"
  );
}

/** Refuse non-loopback listen unless OPENSESAME_ALLOW_NONLOCAL=1. */
export function assertListenHostAllowed(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allow =
    env.OPENSESAME_ALLOW_NONLOCAL === "1" ||
    env.OPENSESAME_DAEMON_ALLOW_NONLOCAL === "1";
  if (allow || listenHostIsLoopback(host)) return;
  throw new Error(
    `listen host \`${host}\` is not loopback; set OPENSESAME_ALLOW_NONLOCAL=1 to override`,
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig {
  const port = Number(env.OPENSESAME_CONTROL_PLANE_PORT ?? env.PORT ?? "8788");
  const host = env.OPENSESAME_CONTROL_PLANE_HOST ?? "127.0.0.1";
  const publicUrl = env.OPENSESAME_PUBLIC_URL ?? `http://${host}:${port}`;
  const issuer = env.OPENSESAME_ISSUER ?? publicUrl;
  const isProduction =
    (env.NODE_ENV ?? "") === "production" ||
    env.OPENSESAME_ENV === "production";
  const isTest =
    env.VITEST === "true" ||
    env.NODE_ENV === "test" ||
    env.OPENSESAME_ENV === "test";
  const allowDevDefaults =
    !isProduction &&
    (isTest ||
      truthy(env.OPENSESAME_ALLOW_DEV_DEFAULTS) ||
      env.NODE_ENV === "development" ||
      env.OPENSESAME_ENV === "development");

  const allowPrincipalBearer =
    !isProduction &&
    allowDevDefaults &&
    truthy(env.OPENSESAME_ALLOW_PRINCIPAL_BEARER);

  const claimPepper = env.OPENSESAME_CLAIM_PEPPER;
  const usingDefaultPepper = !claimPepper || claimPepper === DEV_CLAIM_PEPPER;
  if (usingDefaultPepper && !allowDevDefaults) {
    throw new Error(
      "OPENSESAME_CLAIM_PEPPER must be set to a unique secret (set OPENSESAME_ALLOW_DEV_DEFAULTS=true only for local/dev)",
    );
  }

  const config: ControlPlaneConfig = {
    host,
    port,
    publicUrl,
    issuer,
    claimPepper: claimPepper ?? DEV_CLAIM_PEPPER,
    provisionalCookieName:
      env.OPENSESAME_PROVISIONAL_COOKIE ?? "os_provisional",
    provisionalTtlMs: Number(
      env.OPENSESAME_PROVISIONAL_TTL_MS ?? String(86_400_000),
    ),
    logLevel: env.OPENSESAME_LOG_LEVEL ?? env.LOG_LEVEL ?? "info",
    allowPrincipalBearer,
    allowDevDefaults,
    // Pages (and Host device sessions) need an organization claim. Local/dev
    // stacks mint a personal workspace with the provisional principal — do not
    // gate that on OPENSESAME_DEV_BOOTSTRAP (Host demo seed only).
    bootstrapPersonalOrganization: !isProduction && allowDevDefaults,
    isProduction,
    corsOrigins: (
      env.OPENSESAME_CORS_ORIGINS ??
      "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174,http://127.0.0.1:5176,http://localhost:5176,http://127.0.0.1:5180,http://localhost:5180,http://127.0.0.1:5181,http://localhost:5181,https://tyler-r-kendrick.github.io"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    hostApiUrl: (
      env.OPENSESAME_HOST_API ??
      env.OPENSESAME_SERVER ??
      "http://127.0.0.1:8787"
    ).replace(/\/$/, ""),
    operatorToken: (() => {
      const t = env.OPENSESAME_OPERATOR_TOKEN ?? "";
      if (t) return t;
      if (isProduction) return "";
      return "opensesame-dev-operator";
    })(),
    mappingResolveToken: (() => {
      const t =
        env.OPENSESAME_MAPPING_RESOLVE_TOKEN ??
        env.OPENSESAME_NATS_CALLOUT_SECRET ??
        "";
      if (t) return t;
      if (isProduction) return "";
      // Local/dev default aligned with gateway callout shared secret.
      return allowDevDefaults ? "opensesame-dev-mapping-resolve" : "";
    })(),
    trustedUpstreamIssuers: (
      env.OPENSESAME_TRUSTED_UPSTREAMS ??
      (allowDevDefaults
        ? "https://shoo.dev,http://127.0.0.1:9090,http://localhost:9090"
        : "https://shoo.dev")
    )
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    protocolFeatures: {
      oid4vp: truthy(env.OPENSESAME_OID4VP_ENABLED),
      oid4vci: truthy(env.OPENSESAME_OID4VCI_ENABLED),
      fedcm: truthy(env.OPENSESAME_FEDCM_ENABLED),
      digitalCredentialsApi: truthy(
        env.OPENSESAME_DIGITAL_CREDENTIALS_API_ENABLED,
      ),
      openidFederation: truthy(env.OPENSESAME_OPENID_FEDERATION_ENABLED),
      sdJwtVc: truthy(env.OPENSESAME_SD_JWT_VC_ENABLED),
      tokenStatusList: truthy(env.OPENSESAME_TOKEN_STATUS_LIST_ENABLED),
      presentationAgentIntents: truthy(
        env.OPENSESAME_PRESENTATION_AGENT_INTENTS_ENABLED,
      ),
    },
  };
  if (env.DATABASE_URL) {
    config.databaseUrl = env.DATABASE_URL;
  }
  return config;
}

/** Fail closed after Partial\<ControlPlaneConfig\> merges (tests may override). */
export function assertSecureConfig(
  config: ControlPlaneConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (config.isProduction && config.allowPrincipalBearer) {
    throw new Error("allowPrincipalBearer must be false in production");
  }
  if (config.isProduction && config.claimPepper === DEV_CLAIM_PEPPER) {
    throw new Error(
      "OPENSESAME_CLAIM_PEPPER must not use the development default in production",
    );
  }
  if (config.isProduction && config.allowDevDefaults) {
    throw new Error("allowDevDefaults must be false in production");
  }
  if (config.isProduction && !config.operatorToken) {
    throw new Error(
      "OPENSESAME_OPERATOR_TOKEN must be set in production for Host API device-approve proxy",
    );
  }
  if (config.isProduction && !config.mappingResolveToken) {
    throw new Error(
      "OPENSESAME_MAPPING_RESOLVE_TOKEN (or OPENSESAME_NATS_CALLOUT_SECRET) must be set in production",
    );
  }
  if (config.isProduction && !config.corsOrigins.length) {
    throw new Error(
      "OPENSESAME_CORS_ORIGINS must list at least one origin in production",
    );
  }
  const wildcardCors = config.corsOrigins.some(
    (o) => o === "*" || o === "null",
  );
  if (config.isProduction && wildcardCors) {
    throw new Error(
      "OPENSESAME_CORS_ORIGINS must not include * or null in production",
    );
  }
  // A deployment with no trusted broker can admit no durable principal
  // (ADR 0033 §1/§2). Refusing to boot is louder than silently denying every
  // sign-in. Development stays permissive: the mock IdP is plain http.
  if (config.isProduction && !config.trustedUpstreamIssuers.length) {
    throw new Error(
      "OPENSESAME_TRUSTED_UPSTREAMS must list at least one issuer in production",
    );
  }
  const insecureUpstream = config.trustedUpstreamIssuers.find(
    (issuer) => !issuer.startsWith("https://"),
  );
  if (config.isProduction && insecureUpstream) {
    throw new Error(
      `OPENSESAME_TRUSTED_UPSTREAMS must use https in production; got \`${insecureUpstream}\``,
    );
  }
  assertListenHostAllowed(config.host, env);
}
