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
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig {
  const port = Number(env.OPENSESAME_CONTROL_PLANE_PORT ?? env.PORT ?? "8788");
  const host = env.OPENSESAME_CONTROL_PLANE_HOST ?? "127.0.0.1";
  const publicUrl =
    env.OPENSESAME_PUBLIC_URL ?? `http://${host}:${port}`;
  const issuer = env.OPENSESAME_ISSUER ?? publicUrl;
  const config: ControlPlaneConfig = {
    host,
    port,
    publicUrl,
    issuer,
    claimPepper:
      env.OPENSESAME_CLAIM_PEPPER ?? "dev-claim-pepper-change-me",
    provisionalCookieName: env.OPENSESAME_PROVISIONAL_COOKIE ?? "os_provisional",
    provisionalTtlMs: Number(env.OPENSESAME_PROVISIONAL_TTL_MS ?? String(86_400_000)),
    logLevel: env.OPENSESAME_LOG_LEVEL ?? env.LOG_LEVEL ?? "info",
  };
  if (env.DATABASE_URL) {
    config.databaseUrl = env.DATABASE_URL;
  }
  return config;
}
