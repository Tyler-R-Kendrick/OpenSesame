import type { KeyObject } from "node:crypto";
import { type CryptoKey, type JWK, exportJWK, generateKeyPair } from "jose";

export interface MockIdpConfig {
  issuer: string;
  port: number;
  host: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  testUser: {
    sub: string;
    email: string;
    name: string;
  };
}

export interface MockIdpKeys {
  privateKey: CryptoKey | KeyObject;
  publicJwk: JWK;
  kid: string;
}

function listenHostIsLoopback(host: string): boolean {
  const h = host.trim().replace(/^\[/, "").replace(/\]$/, "");
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1"
  );
}

export function assertMockIdpListenAllowed(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allow =
    env.OPENSESAME_ALLOW_NONLOCAL === "1" ||
    env.OPENSESAME_DAEMON_ALLOW_NONLOCAL === "1";
  if (allow || listenHostIsLoopback(host)) return;
  throw new Error(
    `mock-idp listen host \`${host}\` is not loopback; set OPENSESAME_ALLOW_NONLOCAL=1 to override`,
  );
}

export function readMockIdpConfig(
  env: NodeJS.ProcessEnv = process.env,
): MockIdpConfig {
  return {
    issuer:
      env.OPENSESAME_MOCK_IDP_ISSUER ??
      `http://127.0.0.1:${env.OPENSESAME_MOCK_IDP_PORT ?? "9090"}`,
    port: Number(env.OPENSESAME_MOCK_IDP_PORT ?? "9090"),
    host: env.OPENSESAME_MOCK_IDP_HOST ?? "127.0.0.1",
    clientId: env.OPENSESAME_UPSTREAM_CLIENT_ID ?? "opensesame-upstream",
    clientSecret:
      env.OPENSESAME_UPSTREAM_CLIENT_SECRET ?? "opensesame-upstream-secret",
    redirectUris: (
      env.OPENSESAME_UPSTREAM_REDIRECT_URIS ??
      "http://127.0.0.1:3000/api/auth/callback/mock"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    testUser: {
      sub: env.OPENSESAME_MOCK_IDP_USER_SUB ?? "mock-user-1",
      email: env.OPENSESAME_MOCK_IDP_USER_EMAIL ?? "mock@example.com",
      name: env.OPENSESAME_MOCK_IDP_USER_NAME ?? "Mock User",
    },
  };
}

export async function createMockIdpKeys(): Promise<MockIdpKeys> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const kid = "mock-upstream-1";
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey, publicJwk, kid };
}
