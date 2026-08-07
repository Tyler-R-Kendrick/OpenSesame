import type { OAuthProviderEnv } from "./types.js";

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Resolve OpenSesame OAuth provider feature flags from process env.
 */
export function readOAuthProviderEnv(
  env: NodeJS.ProcessEnv = process.env,
): OAuthProviderEnv {
  return {
    originClientsEnabled: truthy(env.OPENSESAME_ORIGIN_CLIENTS_ENABLED),
    dcrEnabled: truthy(env.OPENSESAME_DCR_ENABLED),
    cimdEnabled: truthy(env.OPENSESAME_CIMD_ENABLED),
    issuer: env.OPENSESAME_ISSUER ?? "http://127.0.0.1:3000",
  };
}
