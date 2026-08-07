import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { SignJWT } from "jose";
import {
  createMockIdpKeys,
  readMockIdpConfig,
  type MockIdpConfig,
  type MockIdpKeys,
} from "./config.js";

type AuthCode = {
  clientId: string;
  redirectUri: string;
  nonce?: string;
  scope: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
};

export interface MockUpstreamIdp {
  config: MockIdpConfig;
  keys: MockIdpKeys;
  server: Server;
  listen(): Promise<string>;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseForm(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

/**
 * Minimal deterministic OIDC provider for local OpenSesame tests.
 * Auto-approves the seeded test user on /authorize.
 */
export async function createMockUpstreamIdp(
  overrides?: Partial<MockIdpConfig>,
): Promise<MockUpstreamIdp> {
  const config: MockIdpConfig = { ...readMockIdpConfig(), ...overrides };
  const keys = await createMockIdpKeys();
  const codes = new Map<string, AuthCode>();

  const discovery = {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    jwks_uri: `${config.issuer}/jwks`,
    userinfo_endpoint: `${config.issuer}/userinfo`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256", "plain"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    claims_supported: ["sub", "email", "name", "iss", "aud", "exp", "iat", "nonce"],
  };

  async function issueTokens(params: {
    clientId: string;
    nonce?: string;
    scope: string;
  }): Promise<Record<string, unknown>> {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = `mock-access-${now}`;
    const idToken = await new SignJWT({
      sub: config.testUser.sub,
      email: config.testUser.email,
      name: config.testUser.name,
      ...(params.nonce ? { nonce: params.nonce } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: keys.kid })
      .setIssuer(config.issuer)
      .setAudience(params.clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(keys.privateKey);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken,
      refresh_token: `mock-refresh-${config.testUser.sub}`,
      scope: params.scope,
    };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", config.issuer);
      const path = url.pathname;

      if (req.method === "GET" && path === "/.well-known/openid-configuration") {
        return sendJson(res, 200, discovery);
      }

      if (req.method === "GET" && path === "/jwks") {
        return sendJson(res, 200, { keys: [keys.publicJwk] });
      }

      if (req.method === "GET" && path === "/authorize") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const responseType = url.searchParams.get("response_type") ?? "";
        const state = url.searchParams.get("state");
        const nonce = url.searchParams.get("nonce") ?? undefined;
        const scope = url.searchParams.get("scope") ?? "openid";
        const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
        const codeChallengeMethod =
          url.searchParams.get("code_challenge_method") ?? undefined;

        if (clientId !== config.clientId) {
          return sendJson(res, 400, { error: "invalid_client" });
        }
        if (!config.redirectUris.includes(redirectUri)) {
          return sendJson(res, 400, { error: "invalid_redirect_uri" });
        }
        if (responseType !== "code") {
          return sendJson(res, 400, { error: "unsupported_response_type" });
        }

        const code = `code_${cryptoRandom()}`;
        const entry: AuthCode = {
          clientId,
          redirectUri,
          scope,
          ...(nonce !== undefined ? { nonce } : {}),
          ...(codeChallenge !== undefined ? { codeChallenge } : {}),
          ...(codeChallengeMethod !== undefined ? { codeChallengeMethod } : {}),
        };
        codes.set(code, entry);

        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        if (state) target.searchParams.set("state", state);
        res.writeHead(302, { location: target.toString() });
        return res.end();
      }

      if (req.method === "POST" && path === "/token") {
        const body = parseForm(await readBody(req));
        const grantType = body.get("grant_type");
        const clientId = body.get("client_id") ?? basicClientId(req) ?? "";
        const clientSecret = body.get("client_secret") ?? basicClientSecret(req) ?? "";

        if (clientId !== config.clientId || clientSecret !== config.clientSecret) {
          return sendJson(res, 401, { error: "invalid_client" });
        }

        if (grantType === "authorization_code") {
          const code = body.get("code") ?? "";
          const redirectUri = body.get("redirect_uri") ?? "";
          const stored = codes.get(code);
          codes.delete(code);
          if (!stored || stored.redirectUri !== redirectUri) {
            return sendJson(res, 400, { error: "invalid_grant" });
          }
          const tokens = await issueTokens({
            clientId,
            scope: stored.scope,
            ...(stored.nonce !== undefined ? { nonce: stored.nonce } : {}),
          });
          return sendJson(res, 200, tokens);
        }

        if (grantType === "refresh_token") {
          const tokens = await issueTokens({
            clientId,
            scope: "openid profile email",
          });
          return sendJson(res, 200, tokens);
        }

        return sendJson(res, 400, { error: "unsupported_grant_type" });
      }

      if (req.method === "GET" && path === "/userinfo") {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ")) {
          return sendJson(res, 401, { error: "invalid_token" });
        }
        return sendJson(res, 200, {
          sub: config.testUser.sub,
          email: config.testUser.email,
          name: config.testUser.name,
        });
      }

      if (req.method === "GET" && path === "/health") {
        return sendJson(res, 200, { ok: true, issuer: config.issuer });
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      sendJson(res, 500, {
        error: "server_error",
        error_description: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    config,
    keys,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          resolve(config.issuer);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function cryptoRandom(): string {
  return randomBytes(16).toString("hex");
}

function basicClientId(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded.split(":")[0];
}

function basicClientSecret(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  return idx >= 0 ? decoded.slice(idx + 1) : undefined;
}
