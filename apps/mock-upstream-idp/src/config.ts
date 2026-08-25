import { type KeyObject, generateKeyPairSync, randomBytes } from "node:crypto";
import { type CryptoKey, type JWK, exportJWK, generateKeyPair } from "jose";
import { generate as generateSelfSignedCertificate } from "selfsigned";

/**
 * Which OIDC client modes the `/authorize` + `/token` pair admits.
 *
 * `both` is the deployed default (an `origin:<origin>` public client and the
 * seeded confidential client are simultaneously valid). The single-mode values
 * let a caller prove a mode violation is refused rather than silently accepted.
 */
export type MockIdpClientMode = "both" | "origin_profile" | "confidential";

export interface MockIdpOAuth2Config {
  /** GitHub-shaped OAuth2 client (no id_token anywhere on this leg). */
  clientId: string;
  clientSecret: string;
  /** Empty means "any loopback redirect"; a non-empty list is exact-matched. */
  redirectUris: string[];
  /** GitHub's `id` is a number — the subject-stability rule depends on it. */
  userId: number;
  login: string;
}

export interface MockIdpConfig {
  issuer: string;
  port: number;
  host: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  /** `/authorize` answers with a self-posting form instead of a 302 redirect. */
  formPost: boolean;
  /** Advertise and serve the RFC 7591 dynamic client registration endpoint. */
  registration: boolean;
  clientMode: MockIdpClientMode;
  oauth2: MockIdpOAuth2Config;
  /** Fallback ACS when an AuthnRequest omits AssertionConsumerServiceURL. */
  samlAcsUrl?: string;
  testUser: {
    sub: string;
    email: string;
    emailVerified: boolean;
    name: string;
  };
}

export interface MockIdpKeys {
  privateKey: CryptoKey | KeyObject;
  publicJwk: JWK;
  kid: string;
}

export interface MockIdpSamlKeys {
  /** PKCS#8 PEM — the XML-DSig signing key. */
  privateKeyPem: string;
  /** The self-signed X.509 certificate, PEM encoded. */
  certificatePem: string;
  /** Base64 DER, i.e. the body of `<ds:X509Certificate>` in metadata. */
  certificateBase64: string;
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

function readFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true";
}

function readClientMode(raw: string | undefined): MockIdpClientMode {
  if (raw === "origin_profile" || raw === "confidential") return raw;
  return "both";
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
    formPost: readFlag(env.OPENSESAME_MOCK_IDP_FORM_POST, false),
    registration: readFlag(env.OPENSESAME_MOCK_IDP_REGISTRATION, true),
    clientMode: readClientMode(env.OPENSESAME_MOCK_IDP_CLIENT_MODE),
    oauth2: {
      clientId: env.OPENSESAME_MOCK_IDP_OAUTH2_CLIENT_ID ?? "mock-oauth2-app",
      // Generated per process when unset: no credential-shaped literal ships
      // in the repository, and every run gets a fresh secret.
      clientSecret:
        env.OPENSESAME_MOCK_IDP_OAUTH2_CLIENT_SECRET ??
        randomBytes(24).toString("hex"),
      redirectUris: (env.OPENSESAME_MOCK_IDP_OAUTH2_REDIRECT_URIS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      userId: Number(env.OPENSESAME_MOCK_IDP_OAUTH2_USER_ID ?? "4242001"),
      login: env.OPENSESAME_MOCK_IDP_OAUTH2_LOGIN ?? "mock-octocat",
    },
    ...(env.OPENSESAME_MOCK_IDP_SAML_ACS_URL !== undefined
      ? { samlAcsUrl: env.OPENSESAME_MOCK_IDP_SAML_ACS_URL }
      : undefined),
    testUser: {
      sub: env.OPENSESAME_MOCK_IDP_USER_SUB ?? "mock-user-1",
      email: env.OPENSESAME_MOCK_IDP_USER_EMAIL ?? "mock@example.com",
      emailVerified: readFlag(
        env.OPENSESAME_MOCK_IDP_USER_EMAIL_VERIFIED,
        true,
      ),
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

/**
 * Generate the SAML signing material at runtime — an RSA keypair from
 * `node:crypto` wrapped in a real self-signed X.509 certificate.
 *
 * Nothing is committed: a reference IdP that shipped a keypair would be a
 * repository secret, and every consumer reads the certificate off the live
 * metadata document anyway.
 */
export async function createMockIdpSamlKeys(
  issuer: string,
): Promise<MockIdpSamlKeys> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const now = Date.now();
  const pems = await generateSelfSignedCertificate(
    [{ name: "commonName", value: new URL(issuer).hostname }],
    {
      algorithm: "sha256",
      keyPair: { privateKey: privateKeyPem, publicKey: publicKeyPem },
      notBeforeDate: new Date(now - 60_000),
      notAfterDate: new Date(now + 86_400_000),
    },
  );
  const certificateBase64 = pems.cert
    .replace("-----BEGIN CERTIFICATE-----", "")
    .replace("-----END CERTIFICATE-----", "")
    .replace(/\s+/g, "");
  return {
    privateKeyPem,
    certificatePem: pems.cert,
    certificateBase64,
  };
}
