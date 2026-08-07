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
  isProduction: boolean;
  /** Explicit CORS allowlist (comma-separated origins via OPENSESAME_CORS_ORIGINS). */
  corsOrigins: string[];
}

const DEV_CLAIM_PEPPER = "dev-claim-pepper-change-me";

function truthy(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig {
  const port = Number(env.OPENSESAME_CONTROL_PLANE_PORT ?? env.PORT ?? "8788");
  const host = env.OPENSESAME_CONTROL_PLANE_HOST ?? "127.0.0.1";
  const publicUrl =
    env.OPENSESAME_PUBLIC_URL ?? `http://${host}:${port}`;
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
    provisionalCookieName: env.OPENSESAME_PROVISIONAL_COOKIE ?? "os_provisional",
    provisionalTtlMs: Number(env.OPENSESAME_PROVISIONAL_TTL_MS ?? String(86_400_000)),
    logLevel: env.OPENSESAME_LOG_LEVEL ?? env.LOG_LEVEL ?? "info",
    allowPrincipalBearer,
    allowDevDefaults,
    isProduction,
    corsOrigins: (env.OPENSESAME_CORS_ORIGINS ??
      "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (env.DATABASE_URL) {
    config.databaseUrl = env.DATABASE_URL;
  }
  return config;
}

/** Fail closed after Partial\<ControlPlaneConfig\> merges (tests may override). */
export function assertSecureConfig(config: ControlPlaneConfig): void {
  if (config.isProduction && config.allowPrincipalBearer) {
    throw new Error("allowPrincipalBearer must be false in production");
  }
  if (config.isProduction && config.claimPepper === DEV_CLAIM_PEPPER) {
    throw new Error("OPENSESAME_CLAIM_PEPPER must not use the development default in production");
  }
  if (config.isProduction && config.allowDevDefaults) {
    throw new Error("allowDevDefaults must be false in production");
  }
}
