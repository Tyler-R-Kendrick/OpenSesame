import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { type JsonObject, isString } from "@opensesame/os-domain";
import { SignJWT } from "jose";
import {
  type MockIdpConfig,
  type MockIdpKeys,
  type MockIdpSamlKeys,
  assertMockIdpListenAllowed,
  createMockIdpKeys,
  createMockIdpSamlKeys,
  readMockIdpConfig,
} from "./config.js";
import {
  autoSubmitFormHtml,
  basicClientId,
  basicClientSecret,
  parseForm,
  readBody,
  securityHeaders,
  sendHtml,
  sendJson,
  sendXml,
} from "./http.js";
import { createOAuth2Surface, oauth2Urls } from "./oauth2.js";
import { type ClientRegistry, registerClient } from "./registration.js";
import {
  SAML_METADATA_PATH,
  SAML_SSO_PATH,
  type SamlMutation,
  buildIdpMetadataXml,
  buildSamlResponseXml,
  encodeSamlMessage,
  parseAuthnRequest,
  samlPostBindingHtml,
} from "./saml.js";

type AuthCode = {
  clientId: string;
  redirectUri: string;
  nonce?: string;
  scope: string;
  codeChallenge: string;
  origin?: string;
};

interface TokenIssueRequest {
  clientId: string;
  nonce?: string;
  scope: string;
}

/** What the last requests carried — the assertions callers make about wire shape. */
export interface MockIdpObservations {
  lastNonce?: string | undefined;
  tokenOrigin?: string | undefined;
  tokenClient: { id?: string; secret?: string };
}

export interface MintLogoutTokenOptions {
  /**
   * OIDC Back-Channel Logout 1.0 forbids `nonce` in a logout token — it is the
   * fence against replaying an id_token as a logout. Set this to produce the
   * malformed token an endpoint must refuse.
   */
  includeNonce?: boolean;
  audience?: string;
  sessionId?: string;
}

export interface MintSamlResponseInput {
  acsUrl: string;
  /** SP entityID; defaults to the OpenSesame SP convention on the ACS origin. */
  audience?: string;
  subject?: string;
  nameIdFormat?: string;
  inResponseTo?: string;
  assertionId?: string;
  mutate?: SamlMutation;
}

function isOriginClientId(clientId: string): boolean {
  return clientId.startsWith("origin:");
}

function originFromClientId(clientId: string): string | undefined {
  if (!isOriginClientId(clientId)) return undefined;
  const origin = clientId.slice("origin:".length);
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return undefined;
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return origin;
  } catch {
    return undefined;
  }
}

function pairwiseSub(canonicalSub: string, audience: string): string {
  return createHash("sha256")
    .update(`os-mock:${canonicalSub}:${audience}`)
    .digest("hex")
    .slice(0, 32);
}

export interface MockUpstreamIdp {
  config: MockIdpConfig;
  keys: MockIdpKeys;
  server: Server;
  /** Clients admitted through the RFC 7591 registration endpoint. */
  registrations: ClientRegistry;
  observed: MockIdpObservations;
  listen(): Promise<string>;
  close(): Promise<void>;
  samlKeys(): Promise<MockIdpSamlKeys>;
  setSamlMutation(mutation?: SamlMutation): void;
  setSamlAcsUrl(acsUrl?: string): void;
  mintLogoutToken(
    subject: string,
    options?: MintLogoutTokenOptions,
  ): Promise<string>;
  mintSamlResponse(input: MintSamlResponseInput): Promise<string>;
}

function tokenCorsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function pkceChallengesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * The repository's reference identity provider.
 *
 * It speaks real OIDC (PKCE S256 enforced, Origin-bound origin-profile
 * clients, single-use codes, RS256 over a runtime keypair), real RFC 7591
 * dynamic client registration, a real GitHub-shaped OAuth2 leg, and real
 * SAML 2.0 with XML-DSig — over one HTTP server, so the dev stack and every
 * protocol test drive the same implementation.
 */
export async function createMockUpstreamIdp(
  overrides?: Partial<MockIdpConfig>,
): Promise<MockUpstreamIdp> {
  const config: MockIdpConfig = { ...readMockIdpConfig(), ...overrides };
  const keys = await createMockIdpKeys();
  const codes = new Map<string, AuthCode>();
  const registrations: ClientRegistry = new Map();
  const observed: MockIdpObservations = { tokenClient: {} };
  const oauth2 = createOAuth2Surface(config);

  let samlKeysPromise: Promise<MockIdpSamlKeys> | undefined;
  let samlMutation: SamlMutation | undefined;
  let samlAcsOverride: string | undefined;

  function samlKeys(): Promise<MockIdpSamlKeys> {
    samlKeysPromise ??= createMockIdpSamlKeys(config.issuer);
    return samlKeysPromise;
  }

  function samlEntityId(): string {
    return `${config.issuer}${SAML_METADATA_PATH}`;
  }

  function defaultAudienceFor(acsUrl: string): string {
    try {
      return `${new URL(acsUrl).origin}/v1/saml/metadata`;
    } catch {
      return acsUrl;
    }
  }

  async function mintSamlResponse(
    input: MintSamlResponseInput,
  ): Promise<string> {
    const material = await samlKeys();
    const xml = buildSamlResponseXml(material, {
      acsUrl: input.acsUrl,
      audience: input.audience ?? defaultAudienceFor(input.acsUrl),
      issuerEntityId: samlEntityId(),
      subject: input.subject ?? config.testUser.sub,
      email: config.testUser.email,
      emailVerified: config.testUser.emailVerified,
      name: config.testUser.name,
      ...(input.nameIdFormat !== undefined
        ? { nameIdFormat: input.nameIdFormat }
        : undefined),
      ...(input.inResponseTo !== undefined
        ? { inResponseTo: input.inResponseTo }
        : undefined),
      ...(input.assertionId !== undefined
        ? { assertionId: input.assertionId }
        : undefined),
      ...(input.mutate !== undefined ? { mutate: input.mutate } : undefined),
    });
    return encodeSamlMessage(xml);
  }

  /** Discovery is derived per request: the issuer is rewritten after binding. */
  function discoveryDocument(): JsonObject {
    const oauth2Endpoints = oauth2Urls(config.issuer);
    return {
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      jwks_uri: `${config.issuer}/jwks`,
      userinfo_endpoint: `${config.issuer}/userinfo`,
      revocation_endpoint: `${config.issuer}/revoke`,
      end_session_endpoint: `${config.issuer}/logout`,
      ...(config.registration
        ? { registration_endpoint: `${config.issuer}/register` }
        : undefined),
      response_types_supported: ["code"],
      response_modes_supported: ["query", "form_post"],
      subject_types_supported: ["public", "pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
      oauth2_authorization_endpoint: oauth2Endpoints.authorizeUrl,
      claims_supported: [
        "sub",
        "email",
        "email_verified",
        "name",
        "iss",
        "aud",
        "exp",
        "iat",
        "nonce",
      ],
    };
  }

  async function issueTokens(params: TokenIssueRequest): Promise<JsonObject> {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = `mock-access-${now}`;
    const origin = originFromClientId(params.clientId);
    const subject = origin
      ? pairwiseSub(config.testUser.sub, params.clientId)
      : config.testUser.sub;
    const idToken = await new SignJWT({
      sub: subject,
      email: config.testUser.email,
      email_verified: config.testUser.emailVerified,
      name: config.testUser.name,
      ...(origin ? { pairwise_sub: subject, origin } : undefined),
      ...(params.nonce ? { nonce: params.nonce } : undefined),
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

  async function mintLogoutToken(
    subject: string,
    options?: MintLogoutTokenOptions,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
      ...(options?.sessionId !== undefined
        ? { sid: options.sessionId }
        : undefined),
      ...(options?.includeNonce
        ? { nonce: randomBytes(8).toString("hex") }
        : undefined),
    })
      .setProtectedHeader({ alg: "RS256", kid: keys.kid })
      .setIssuer(config.issuer)
      .setSubject(subject)
      .setAudience(options?.audience ?? config.clientId)
      .setIssuedAt(now)
      .setJti(randomBytes(16).toString("hex"))
      .setExpirationTime(now + 120)
      .sign(keys.privateKey);
  }

  function confidentialSecretFor(clientId: string): string | undefined {
    if (clientId === config.clientId) return config.clientSecret;
    return registrations.get(clientId)?.clientSecret;
  }

  function redirectAllowedForConfidential(
    clientId: string,
    redirectUri: string,
  ): boolean {
    if (clientId === config.clientId) {
      return config.redirectUris.includes(redirectUri);
    }
    return (
      registrations.get(clientId)?.redirectUris.includes(redirectUri) === true
    );
  }

  function clientModeRefuses(originClient: string | undefined): boolean {
    if (config.clientMode === "origin_profile")
      return originClient === undefined;
    if (config.clientMode === "confidential") return originClient !== undefined;
    return false;
  }

  async function handleSamlSso(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const params =
      req.method === "POST" ? parseForm(await readBody(req)) : url.searchParams;
    const encoded = params.get("SAMLRequest");
    const relayState = params.get("RelayState") ?? undefined;
    if (encoded === null) {
      return sendJson(
        res,
        400,
        {
          error: "invalid_saml_request",
          error_description: "SAMLRequest missing",
        },
        config.issuer,
      );
    }
    const parsed = parseAuthnRequest(encoded);
    if (!parsed) {
      return sendJson(
        res,
        400,
        {
          error: "invalid_saml_request",
          error_description: "SAMLRequest is not a parseable AuthnRequest",
        },
        config.issuer,
      );
    }
    const acsUrl = parsed.acsUrl ?? samlAcsOverride ?? config.samlAcsUrl;
    if (acsUrl === undefined) {
      return sendJson(
        res,
        400,
        {
          error: "invalid_saml_request",
          error_description:
            "no AssertionConsumerServiceURL and no default ACS",
        },
        config.issuer,
      );
    }
    const samlResponse = await mintSamlResponse({
      acsUrl,
      inResponseTo: parsed.id,
      ...(parsed.issuer !== undefined
        ? { audience: parsed.issuer }
        : undefined),
      ...(samlMutation !== undefined ? { mutate: samlMutation } : undefined),
    });
    sendHtml(
      res,
      200,
      samlPostBindingHtml(acsUrl, samlResponse, relayState),
      config.issuer,
    );
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", config.issuer);
      const path = url.pathname;

      if (await oauth2.handle(req, res, url)) return;

      if (
        req.method === "GET" &&
        path === "/.well-known/openid-configuration"
      ) {
        // Public read-only document. A browser-capable upstream must let any
        // origin read it — the Pages direct leg fetches discovery cross-origin
        // (vite :5180 → :9090) before it can navigate anywhere, and without
        // this header that fetch dies in CORS and the button can never work.
        return sendJson(res, 200, discoveryDocument(), config.issuer, {
          "access-control-allow-origin": "*",
        });
      }

      if (req.method === "GET" && path === "/jwks") {
        return sendJson(res, 200, { keys: [keys.publicJwk] }, config.issuer, {
          "access-control-allow-origin": "*",
        });
      }

      if (req.method === "POST" && path === "/register") {
        if (!config.registration) {
          return sendJson(res, 404, { error: "not_found" }, config.issuer);
        }
        const outcome = registerClient(registrations, await readBody(req));
        return sendJson(res, outcome.status, outcome.body, config.issuer);
      }

      if (req.method === "GET" && path === SAML_METADATA_PATH) {
        const material = await samlKeys();
        return sendXml(
          res,
          200,
          buildIdpMetadataXml(
            samlEntityId(),
            `${config.issuer}${SAML_SSO_PATH}`,
            material.certificateBase64,
          ),
          config.issuer,
        );
      }

      if (
        (req.method === "GET" || req.method === "POST") &&
        path === SAML_SSO_PATH
      ) {
        return await handleSamlSso(req, res, url);
      }

      if (req.method === "GET" && path === "/authorize") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const responseType = url.searchParams.get("response_type") ?? "";
        const responseMode = url.searchParams.get("response_mode") ?? "";
        const state = url.searchParams.get("state");
        const nonce = url.searchParams.get("nonce") ?? undefined;
        const scope = url.searchParams.get("scope") ?? "openid";
        const codeChallenge =
          url.searchParams.get("code_challenge") ?? undefined;
        const codeChallengeMethod =
          url.searchParams.get("code_challenge_method") ?? undefined;

        const originClient = originFromClientId(clientId);
        if (clientModeRefuses(originClient)) {
          return sendJson(
            res,
            400,
            {
              error: "invalid_client",
              error_description: `client mode ${config.clientMode} required`,
            },
            config.issuer,
          );
        }
        if (originClient) {
          let redirectOrigin: string;
          try {
            redirectOrigin = new URL(redirectUri).origin;
          } catch {
            return sendJson(
              res,
              400,
              { error: "invalid_redirect_uri" },
              config.issuer,
            );
          }
          if (redirectOrigin !== originClient) {
            return sendJson(
              res,
              400,
              { error: "invalid_redirect_uri" },
              config.issuer,
            );
          }
        } else if (confidentialSecretFor(clientId) === undefined) {
          return sendJson(res, 400, { error: "invalid_client" }, config.issuer);
        } else if (!redirectAllowedForConfidential(clientId, redirectUri)) {
          return sendJson(
            res,
            400,
            { error: "invalid_redirect_uri" },
            config.issuer,
          );
        }
        if (responseType !== "code") {
          return sendJson(
            res,
            400,
            { error: "unsupported_response_type" },
            config.issuer,
          );
        }
        if (!codeChallenge || (codeChallengeMethod ?? "") !== "S256") {
          return sendJson(
            res,
            400,
            {
              error: "invalid_request",
              error_description: "PKCE S256 required",
            },
            config.issuer,
          );
        }

        observed.lastNonce = nonce;
        const code = `code_${cryptoRandom()}`;
        const entry: AuthCode = {
          clientId,
          redirectUri,
          scope,
          codeChallenge,
          ...(nonce !== undefined ? { nonce } : undefined),
          ...(originClient !== undefined
            ? { origin: originClient }
            : undefined),
        };
        codes.set(code, entry);

        // `response_mode=form_post` (Apple) answers with a self-posting form
        // instead of a redirect: a cross-site POST that carries no SameSite=Lax
        // cookies to the relying party's callback.
        if (config.formPost || responseMode === "form_post") {
          return sendHtml(
            res,
            200,
            autoSubmitFormHtml(
              redirectUri,
              [
                { name: "code", value: code },
                ...(state !== null ? [{ name: "state", value: state }] : []),
              ],
              "Reference IdP — form_post response",
            ),
            config.issuer,
          );
        }

        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        if (state) target.searchParams.set("state", state);
        res.writeHead(
          302,
          securityHeaders({ location: target.toString() }, config.issuer),
        );
        return res.end();
      }

      if (req.method === "OPTIONS" && path === "/token") {
        const requestOrigin = req.headers.origin;
        if (isString(requestOrigin) && requestOrigin.length > 0) {
          res.writeHead(
            204,
            securityHeaders(tokenCorsHeaders(requestOrigin), config.issuer),
          );
          return res.end();
        }
        res.writeHead(204, securityHeaders({}, config.issuer));
        return res.end();
      }

      if (req.method === "POST" && path === "/token") {
        const body = parseForm(await readBody(req));
        const grantType = body.get("grant_type");
        const clientId = body.get("client_id") ?? basicClientId(req) ?? "";
        const clientSecret =
          body.get("client_secret") ?? basicClientSecret(req) ?? "";
        const originClient = originFromClientId(clientId);
        const requestOrigin = isString(req.headers.origin)
          ? req.headers.origin
          : "";

        const seenClientId = body.get("client_id");
        const seenClientSecret = body.get("client_secret");
        observed.tokenOrigin = isString(req.headers.origin)
          ? req.headers.origin
          : undefined;
        observed.tokenClient = {
          ...(seenClientId !== null ? { id: seenClientId } : undefined),
          ...(seenClientSecret !== null
            ? { secret: seenClientSecret }
            : undefined),
        };

        if (clientModeRefuses(originClient)) {
          return sendJson(res, 401, { error: "invalid_client" }, config.issuer);
        }

        if (originClient) {
          if (requestOrigin !== originClient) {
            return sendJson(
              res,
              403,
              {
                error: "unauthorized_client",
                error_description: "origin_cors_denied",
              },
              config.issuer,
            );
          }
        } else if (confidentialSecretFor(clientId) !== clientSecret) {
          return sendJson(res, 401, { error: "invalid_client" }, config.issuer);
        }

        const cors = originClient ? tokenCorsHeaders(originClient) : {};

        if (grantType === "authorization_code") {
          const code = body.get("code") ?? "";
          const redirectUri = body.get("redirect_uri") ?? "";
          const stored = codes.get(code);
          codes.delete(code);
          if (!stored || stored.redirectUri !== redirectUri) {
            return sendJson(
              res,
              400,
              { error: "invalid_grant" },
              config.issuer,
              cors,
            );
          }
          const verifier = body.get("code_verifier") ?? "";
          if (
            !verifier ||
            !pkceChallengesEqual(s256Challenge(verifier), stored.codeChallenge)
          ) {
            return sendJson(
              res,
              400,
              {
                error: "invalid_grant",
                error_description: "PKCE verification failed",
              },
              config.issuer,
              cors,
            );
          }
          const tokens = await issueTokens({
            clientId,
            scope: stored.scope,
            ...(stored.nonce !== undefined
              ? { nonce: stored.nonce }
              : undefined),
          });
          return sendJson(res, 200, tokens, config.issuer, cors);
        }

        if (grantType === "refresh_token") {
          if (originClient) {
            return sendJson(
              res,
              400,
              { error: "unauthorized_client" },
              config.issuer,
              cors,
            );
          }
          const tokens = await issueTokens({
            clientId,
            scope: "openid profile email",
          });
          return sendJson(res, 200, tokens, config.issuer);
        }

        return sendJson(
          res,
          400,
          { error: "unsupported_grant_type" },
          config.issuer,
          cors,
        );
      }

      if (req.method === "POST" && path === "/revoke") {
        // RFC 7009: a revocation endpoint answers 200 whether or not the token
        // was known, so a caller learns nothing from the response.
        await readBody(req);
        res.writeHead(200, securityHeaders({}, config.issuer));
        return res.end();
      }

      if (req.method === "GET" && path === "/userinfo") {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ")) {
          return sendJson(res, 401, { error: "invalid_token" }, config.issuer);
        }
        return sendJson(
          res,
          200,
          {
            sub: config.testUser.sub,
            email: config.testUser.email,
            email_verified: config.testUser.emailVerified,
            name: config.testUser.name,
          },
          config.issuer,
        );
      }

      if (req.method === "GET" && path === "/health") {
        return sendJson(
          res,
          200,
          { ok: true, issuer: config.issuer },
          config.issuer,
        );
      }

      sendJson(res, 404, { error: "not_found" }, config.issuer);
    } catch (err) {
      sendJson(
        res,
        500,
        {
          error: "server_error",
          error_description: err instanceof Error ? err.message : String(err),
        },
        config.issuer,
      );
    }
  });

  return {
    config,
    keys,
    server,
    registrations,
    observed,
    samlKeys,
    setSamlMutation(mutation?: SamlMutation) {
      samlMutation = mutation;
    },
    setSamlAcsUrl(acsUrl?: string) {
      samlAcsOverride = acsUrl;
    },
    mintLogoutToken,
    mintSamlResponse,
    listen() {
      return new Promise((resolve, reject) => {
        try {
          assertMockIdpListenAllowed(config.host);
        } catch (err) {
          reject(err);
          return;
        }
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
