import { randomBytes } from "node:crypto";
import type { NotificationChannelKind } from "@opensesame/os-domain";
import { parseChannelKinds } from "./config-channels.js";
import {
  assertServiceEndpoints,
  deploymentExposure,
  loopbackHost,
  resolveDeploymentMode,
} from "./deployment-mode.js";
import {
  type ProviderDescriptor,
  assertProviderDescriptor,
  configuredProviders,
  loadProviderRegistry,
  mergeProviderIssuers,
  normalizeIssuer,
} from "./interactions/registry.js";
import { readSupportProxyConfig } from "./services/support-proxy.js";

export interface ControlPlaneConfig {
  supportProxy?:
    | import("./services/support-proxy.js").SupportProxyConfig
    | undefined;
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
  /**
   * A login interaction whose provider hint matches a registry provider 303s
   * straight into that provider's leg instead of rendering the login page —
   * one silent hop, with a per-interaction cookie as the loop guard so an
   * upstream refusal always comes back to a rendered page (T14).
   *
   * **On by default** (`OPENSESAME_INTERACTION_AUTO_CONTINUE=false` opts out),
   * because it is what makes this deployment a broker rather than a login
   * site. A static page with no backend of its own signs in by naming a
   * provider and being sent to it; interposing our own picker at that point
   * asks the visitor to choose something their relying party already chose,
   * and is the one behaviour that made this broker feel unlike the
   * public brokers static sites already use (shoo.dev fronting Google).
   *
   * Safe by construction, and narrow: it fires ONLY when the relying party
   * named a provider (`preferredProviderForDetails` returns undefined without
   * a hint, so a hint-less visitor always gets the full page), ONLY once per
   * interaction, never when an upstream refusal is coming back (`fed_error`)
   * or an organization slug is being resolved, and never past the choice —
   * a leg that cannot start falls back to rendering the page. The trust
   * fence in `/federated/start` still decides what may be federated to; this
   * only removes a click the relying party already made.
   */
  interactionAutoContinue: boolean;
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
  /**
   * Confidential-client credentials for ONE upstream issuer, when that broker
   * cannot serve the secret-less origin-profile contract (ADR 0034). Present
   * only when an issuer, a client id, AND a non-empty secret are all
   * configured together; the issuer is matched exactly, so a secret is never
   * offered to an issuer it was not configured for.
   */
  upstreamClientCredentials?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
  };
  /**
   * The federated provider catalog (ADR 0055): every upstream this deployment
   * offers, from `OPENSESAME_PROVIDERS` plus its per-provider variables. Every
   * entry's issuer is also merged into `trustedUpstreamIssuers`, so a
   * configured provider is a trusted provider by construction.
   */
  providers: ProviderDescriptor[];
  /**
   * Where prompts may be delivered, and which of those destinations an
   * operator has allowed to settle a decision by themselves (ADR 0084).
   *
   * `directApprovalChannels` and `directDenialChannels` are empty unless a
   * human wrote a channel down. A deployment that has not thought about Slack
   * has not permitted Slack to approve anything, and the adapter secrets
   * below are what make a callback's provenance checkable at all — a channel
   * listed without its secret cannot authenticate anything and is refused at
   * boot in production.
   */
  notifications: {
    /** Kinds whose adapter is actually configured here. */
    availableChannels: NotificationChannelKind[];
    /** Kinds allowed to settle an approval by provider callback. */
    directApprovalChannels: NotificationChannelKind[];
    /** Kinds allowed to settle a denial by provider callback. */
    directDenialChannels: NotificationChannelKind[];
    /** VAPID application server public key, base64url. Public by design. */
    pushPublicKey: string;
    /** Slack request-signing secret (v0 signatures over the raw body). */
    slackSigningSecret: string;
    /** Telegram `secret_token` echoed on every webhook update. */
    telegramSecretToken: string;
    /**
     * Accept a provider identity the *caller* supplied when completing a
     * binding ceremony.
     *
     * Development only. A destination is authority-adjacent — it decides
     * where an approval prompt appears and, where an operator opted the
     * channel in, which provider subject may settle it — so outside dev the
     * identity has to come back through the provider, never from the browser
     * asking for the binding.
     */
    allowSelfAssertedBindings: boolean;
  };
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
  /**
   * auth.md AgentAuth profile (ADR 0092). Provider ID-JAG and SET events stay
   * off until their trust path is complete; discovery must not advertise them.
   */
  agentAuth: {
    enabled: boolean;
    anonymousEnabled: boolean;
    serviceAuthEnabled: boolean;
    providerAssertionEnabled: boolean;
    eventsEnabled: boolean;
    registrationTtlMs: number;
    claimAttemptTtlMs: number;
    assertionTtlMs: number;
    accessTokenTtlMs: number;
    pollIntervalSeconds: number;
    maxUserCodeAttempts: number;
    maxLiveAnonymous: number;
    preClaimScopes: string[];
    postClaimScopes: string[];
    resourceScopes: string[];
  };
}

function truthy(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

/** Like {@link truthy}, but an unset value means on. Only `false`/`0` opt out. */
function truthyDefaultOn(v: string | undefined): boolean {
  if (v === undefined || v.trim() === "") return true;
  return !(v === "false" || v === "0");
}

function parseOriginList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsOriginsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return parseOriginList(env.OPENSESAME_CORS_ORIGINS ?? "");
}

/** True when a bind host is loopback (matches Rust host-core daemon policy). */
export function listenHostIsLoopback(host: string): boolean {
  return loopbackHost(host);
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

/**
 * Read a channel list from configuration.
 *
 * Unknown names are dropped rather than passed through: a typo in
 * `OPENSESAME_DIRECT_APPROVAL_CHANNELS` must not reach the policy layer as a
 * channel kind nothing in the capability table describes.
 */
export { parseChannelKinds } from "./config-channels.js";

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig {
  const port = Number(env.OPENSESAME_CONTROL_PLANE_PORT ?? env.PORT ?? "8788");
  const host = env.OPENSESAME_CONTROL_PLANE_HOST ?? "127.0.0.1";
  const publicUrl = env.OPENSESAME_PUBLIC_URL ?? `http://${host}:${port}`;
  const issuer = env.OPENSESAME_ISSUER ?? publicUrl;
  const endpoints = [
    publicUrl,
    issuer,
    env.OPENSESAME_HOST_API,
    env.OPENSESAME_SERVER,
    env.OPENSESAME_CALLBACK_BASE,
  ].filter((value): value is string => value !== undefined);
  const deployment = resolveDeploymentMode(
    env,
    deploymentExposure(host, endpoints),
  );
  const isProduction = deployment.productionSafeguards;
  const allowDevDefaults = deployment.allowDevDefaults;

  const allowPrincipalBearer =
    !isProduction &&
    allowDevDefaults &&
    truthy(env.OPENSESAME_ALLOW_PRINCIPAL_BEARER);

  const claimPepper = env.OPENSESAME_CLAIM_PEPPER;
  const usingDefaultPepper = !claimPepper;
  if (usingDefaultPepper && !allowDevDefaults) {
    throw new Error(
      "OPENSESAME_CLAIM_PEPPER must be set to a unique secret (local development opt-in is OPENSESAME_ALLOW_DEV_DEFAULTS=1)",
    );
  }

  // Parsed before the config literal: a provider entry that configuration
  // cannot satisfy (a multi-tenant Microsoft issuer, an Apple entry with no
  // signing key) must refuse the boot rather than surface as a sign-in that
  // fails for one user at a time.
  const providers = loadProviderRegistry(env);

  const config: ControlPlaneConfig = {
    supportProxy: readSupportProxyConfig(env),
    host,
    port,
    publicUrl,
    issuer,
    claimPepper: claimPepper ?? randomBytes(32).toString("base64url"),
    provisionalCookieName:
      env.OPENSESAME_PROVISIONAL_COOKIE ?? "os_provisional",
    provisionalTtlMs: Number(
      env.OPENSESAME_PROVISIONAL_TTL_MS ?? String(86_400_000),
    ),
    logLevel: env.OPENSESAME_LOG_LEVEL ?? env.LOG_LEVEL ?? "info",
    allowPrincipalBearer,
    allowDevDefaults,
    // Default ON: absent means "broker", and only an explicit `false` opts a
    // deployment back into rendering its own picker for a hinted sign-in.
    interactionAutoContinue: truthyDefaultOn(
      env.OPENSESAME_INTERACTION_AUTO_CONTINUE,
    ),
    // Pages (and Host device sessions) need an organization claim. Local/dev
    // stacks mint a personal workspace with the provisional principal — do not
    // gate that on OPENSESAME_DEV_BOOTSTRAP (Host demo seed only).
    bootstrapPersonalOrganization: !isProduction && allowDevDefaults,
    isProduction,
    corsOrigins: corsOriginsFromEnv(env),
    hostApiUrl: (
      env.OPENSESAME_HOST_API ??
      env.OPENSESAME_SERVER ??
      "http://127.0.0.1:8787"
    ).replace(/\/$/, ""),
    operatorToken: env.OPENSESAME_OPERATOR_TOKEN ?? "",
    mappingResolveToken: env.OPENSESAME_MAPPING_RESOLVE_TOKEN ?? "",
    trustedUpstreamIssuers: mergeProviderIssuers(
      (env.OPENSESAME_TRUSTED_UPSTREAMS ?? "")
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean),
      providers,
    ),
    providers,
    notifications: {
      // `in_app` is the durable inbox and is always configured: it is the
      // surface every other channel merely points at.
      availableChannels: parseChannelKinds(
        env.OPENSESAME_NOTIFICATION_CHANNELS,
        ["in_app"],
      ),
      // Default deny, in both directions. Nothing external settles anything
      // until an operator names it.
      directApprovalChannels: parseChannelKinds(
        env.OPENSESAME_DIRECT_APPROVAL_CHANNELS,
        [],
      ),
      directDenialChannels: parseChannelKinds(
        env.OPENSESAME_DIRECT_DENIAL_CHANNELS,
        [],
      ),
      pushPublicKey: env.OPENSESAME_WEBPUSH_PUBLIC_KEY ?? "",
      slackSigningSecret: env.OPENSESAME_SLACK_SIGNING_SECRET ?? "",
      telegramSecretToken: env.OPENSESAME_TELEGRAM_WEBHOOK_SECRET ?? "",
      allowSelfAssertedBindings: allowDevDefaults,
    },
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
    agentAuth: {
      enabled: truthyDefaultOn(env.OPENSESAME_AGENT_AUTH_ENABLED),
      anonymousEnabled: truthyDefaultOn(
        env.OPENSESAME_AGENT_AUTH_ANONYMOUS_ENABLED,
      ),
      serviceAuthEnabled: truthyDefaultOn(
        env.OPENSESAME_AGENT_AUTH_SERVICE_AUTH_ENABLED,
      ),
      providerAssertionEnabled: truthy(
        env.OPENSESAME_AGENT_AUTH_PROVIDER_ASSERTION_ENABLED,
      ),
      eventsEnabled: truthy(env.OPENSESAME_AGENT_AUTH_EVENTS_ENABLED),
      registrationTtlMs: Number(
        env.OPENSESAME_AGENT_AUTH_REGISTRATION_TTL_MS ?? String(86_400_000),
      ),
      claimAttemptTtlMs: Number(
        env.OPENSESAME_AGENT_AUTH_CLAIM_ATTEMPT_TTL_MS ?? String(600_000),
      ),
      assertionTtlMs: Number(
        env.OPENSESAME_AGENT_AUTH_ASSERTION_TTL_MS ?? String(3_600_000),
      ),
      accessTokenTtlMs: Number(
        env.OPENSESAME_AGENT_AUTH_ACCESS_TOKEN_TTL_MS ?? String(3_600_000),
      ),
      pollIntervalSeconds: Number(
        env.OPENSESAME_AGENT_AUTH_POLL_INTERVAL_SECONDS ?? "5",
      ),
      maxUserCodeAttempts: Number(
        env.OPENSESAME_AGENT_AUTH_MAX_USER_CODE_ATTEMPTS ?? "5",
      ),
      maxLiveAnonymous: Number(
        env.OPENSESAME_AGENT_AUTH_MAX_LIVE_ANONYMOUS ?? "1024",
      ),
      preClaimScopes: ["resource:read", "resource:create:temporary"],
      postClaimScopes: [
        "resource:read",
        "resource:create:temporary",
        "project:create:temporary",
        "claim:create",
      ],
      resourceScopes: [
        "resource:read",
        "resource:create:temporary",
        "project:create:temporary",
        "claim:create",
      ],
    },
  };
  if (env.DATABASE_URL) {
    config.databaseUrl = env.DATABASE_URL;
  }
  // All three must be present together: a client id without a secret is the
  // origin-profile case (handled by derivation), and a secret without an
  // issuer has nobody it may legitimately be sent to.
  const upstreamIssuer = (env.OPENSESAME_UPSTREAM_ISSUER ?? "")
    .trim()
    .replace(/\/+$/, "");
  const upstreamClientId = (env.OPENSESAME_UPSTREAM_CLIENT_ID ?? "").trim();
  const upstreamClientSecret = env.OPENSESAME_UPSTREAM_CLIENT_SECRET ?? "";
  if (upstreamIssuer && upstreamClientId && upstreamClientSecret) {
    config.upstreamClientCredentials = {
      issuer: upstreamIssuer,
      clientId: upstreamClientId,
      clientSecret: upstreamClientSecret,
    };
  }
  return config;
}

/** Fail closed after Partial\<ControlPlaneConfig\> merges (tests may override). */
export function assertSecureConfig(
  config: ControlPlaneConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const exposure = deploymentExposure(config.host, [
    config.publicUrl,
    config.issuer,
    config.hostApiUrl,
  ]);
  if (exposure === "networked") config.isProduction = true;
  assertServiceEndpoints(
    {
      OPENSESAME_PUBLIC_URL: config.publicUrl,
      OPENSESAME_ISSUER: config.issuer,
      OPENSESAME_HOST_API: config.hostApiUrl,
    },
    config.isProduction,
  );
  if (config.isProduction && config.allowPrincipalBearer) {
    throw new Error("allowPrincipalBearer must be false in production");
  }
  if (config.isProduction && config.claimPepper.length < 32) {
    throw new Error(
      "OPENSESAME_CLAIM_PEPPER must contain at least 32 characters in production",
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
      "OPENSESAME_MAPPING_RESOLVE_TOKEN must be set in production",
    );
  }
  if (config.isProduction && !config.databaseUrl)
    throw new Error(
      "DATABASE_URL is required for durable production security state",
    );
  const wildcardCors = config.corsOrigins.some(
    (o) => o === "*" || o === "null",
  );
  if (wildcardCors) {
    throw new Error(
      "OPENSESAME_CORS_ORIGINS must not include * or null in production",
    );
  }
  // Empty trust is valid; every explicitly trusted production issuer needs TLS.
  const insecureUpstream = config.trustedUpstreamIssuers.find(
    (issuer) => !issuer.startsWith("https://"),
  );
  if (config.isProduction && insecureUpstream) {
    throw new Error(
      `OPENSESAME_TRUSTED_UPSTREAMS must use https in production; got \`${insecureUpstream}\``,
    );
  }
  // Configured credentials require an explicitly trusted destination.
  const credentials = config.upstreamClientCredentials;
  if (credentials) {
    if (!config.trustedUpstreamIssuers.includes(credentials.issuer)) {
      throw new Error(
        "OPENSESAME_UPSTREAM_ISSUER carries client credentials but is not listed in OPENSESAME_TRUSTED_UPSTREAMS",
      );
    }
  }
  // Recheck registry providers after partial config overrides (ADR 0055).
  const trusted = new Set(config.trustedUpstreamIssuers.map(normalizeIssuer));
  for (const provider of configuredProviders(config)) {
    assertProviderDescriptor(provider);
    const issuer = normalizeIssuer(provider.issuer);
    if (config.isProduction && !issuer.startsWith("https://")) {
      throw new Error(
        `provider \`${provider.id}\` must use an https issuer in production; got \`${issuer}\``,
      );
    }
    // A client secret is only ever sent to the issuer it was configured for,
    // so that issuer must be one we actually trust. Not production-gated, for
    // the same reason the legacy check above is not.
    const carriesSecret =
      provider.kind === "oauth2" || provider.clientAuth !== "none";
    if (carriesSecret && !trusted.has(issuer)) {
      throw new Error(
        `provider \`${provider.id}\` carries client credentials but its issuer is not listed in OPENSESAME_TRUSTED_UPSTREAMS`,
      );
    }
  }
  // A channel that may settle a decision must be one whose callbacks this
  // deployment can actually authenticate. Without the provider's own signing
  // material, `callbackAuthenticated` could only ever be a guess, and the one
  // thing worse than no direct approval is direct approval nobody can verify.
  //
  // Read through a partial view because this function's whole job is to be
  // right about configs assembled by hand: a caller that supplied no
  // notification block has opted no channel in, which is the safe reading.
  const partial: Partial<ControlPlaneConfig> = config;
  const notifications = partial.notifications;
  const settling = new Set([
    ...(notifications?.directApprovalChannels ?? []),
    ...(notifications?.directDenialChannels ?? []),
  ]);
  const missingSecret = [...settling].find((kind) => {
    if (kind === "slack") return !notifications?.slackSigningSecret;
    if (kind === "telegram") return !notifications?.telegramSecretToken;
    // Any other kind has no provenance mechanism this repository implements.
    return true;
  });
  if (missingSecret) {
    throw new Error(
      `notification channel \`${missingSecret}\` is listed for direct settlement but has no verifiable callback secret configured`,
    );
  }
  if (config.isProduction && notifications?.allowSelfAssertedBindings) {
    throw new Error(
      "self-asserted notification channel bindings must be off in production",
    );
  }
  assertListenHostAllowed(config.host, env);
}
