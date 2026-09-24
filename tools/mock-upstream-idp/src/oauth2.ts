import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonObject } from "@opensesame/os-domain";
import type { MockIdpConfig } from "./config.js";
import {
  basicClientId,
  basicClientSecret,
  bearerToken,
  parseForm,
  readBody,
  sendForm,
  sendJson,
} from "./http.js";

/**
 * A real GitHub-shaped OAuth2 authorization server.
 *
 * GitHub is the reason the generic OAuth2 leg exists: it issues no id_token,
 * and its token endpoint has three quirks that a JSON-only client silently
 * mis-reads. All three are implemented here, not simulated per test:
 *
 *  1. the token response is `application/x-www-form-urlencoded` UNLESS the
 *     request carried `Accept: application/json`;
 *  2. protocol errors arrive as HTTP **200** with an `error` key in the body;
 *  3. the user profile's `id` is a number (and is the only stable subject —
 *     `login` is renameable, so binding to it is an account-takeover path).
 *
 * There is no refresh grant: GitHub OAuth apps do not issue refresh tokens.
 */

export const OAUTH2_AUTHORIZE_PATH = "/login/oauth/authorize";
export const OAUTH2_TOKEN_PATH = "/login/oauth/access_token";
export const OAUTH2_USERINFO_PATH = "/api/user";
/**
 * GitHub's `/user/emails`. Separate from the profile because the answers are
 * different: the profile carries whatever address the account chose to make
 * public, this carries every address with the `verified` flag GitHub set.
 */
export const OAUTH2_EMAILS_PATH = "/api/user/emails";
export const OAUTH2_METADATA_PATH = "/.well-known/oauth-authorization-server";

export interface OAuth2Urls {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  emailsUrl: string;
  metadataUrl: string;
}

export function oauth2Urls(issuer: string): OAuth2Urls {
  return {
    authorizeUrl: `${issuer}${OAUTH2_AUTHORIZE_PATH}`,
    tokenUrl: `${issuer}${OAUTH2_TOKEN_PATH}`,
    userinfoUrl: `${issuer}${OAUTH2_USERINFO_PATH}`,
    emailsUrl: `${issuer}${OAUTH2_EMAILS_PATH}`,
    metadataUrl: `${issuer}${OAUTH2_METADATA_PATH}`,
  };
}

interface OAuth2Code {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge?: string;
}

export interface OAuth2Surface {
  /** Returns `true` when the request belonged to the OAuth2 surface. */
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> | boolean;
}

function wantsJson(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("application/json");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isLoopbackRedirect(redirectUri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function createOAuth2Surface(config: MockIdpConfig): OAuth2Surface {
  const codes = new Map<string, OAuth2Code>();
  const accessTokens = new Map<string, string>();

  function redirectAllowed(redirectUri: string): boolean {
    const registered = config.oauth2.redirectUris;
    if (registered.length > 0) return registered.includes(redirectUri);
    return isLoopbackRedirect(redirectUri);
  }

  /**
   * GitHub answers protocol failures with 200 and an `error` key — the shape a
   * client that only branches on HTTP status will read as a success.
   */
  function sendTokenBody(
    req: IncomingMessage,
    res: ServerResponse,
    body: URLSearchParams,
  ): void {
    if (wantsJson(req)) {
      const asJson: JsonObject = {};
      for (const [key, value] of body.entries()) asJson[key] = value;
      sendJson(res, 200, asJson, config.issuer);
      return;
    }
    sendForm(res, 200, body, config.issuer);
  }

  function tokenError(
    req: IncomingMessage,
    res: ServerResponse,
    error: string,
    description: string,
  ): void {
    sendTokenBody(
      req,
      res,
      new URLSearchParams({
        error,
        error_description: description,
        error_uri: `${config.issuer}/docs/oauth2#${error}`,
      }),
    );
  }

  function handleAuthorize(res: ServerResponse, url: URL): void {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state");
    const scope = url.searchParams.get("scope") ?? "read:user";
    const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;

    if (!constantTimeEquals(clientId, config.oauth2.clientId)) {
      sendJson(
        res,
        400,
        {
          error: "application_suspended",
          error_description: "unknown client_id",
        },
        config.issuer,
      );
      return;
    }
    if (!redirectAllowed(redirectUri)) {
      sendJson(
        res,
        400,
        {
          error: "redirect_uri_mismatch",
          error_description: "redirect_uri is not registered for this client",
        },
        config.issuer,
      );
      return;
    }

    const code = `gho_code_${randomBytes(16).toString("hex")}`;
    codes.set(code, {
      clientId,
      redirectUri,
      scope,
      ...(codeChallenge !== undefined ? { codeChallenge } : undefined),
    });

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state !== null) target.searchParams.set("state", state);
    res.writeHead(302, {
      location: target.toString(),
      "cache-control": "no-store",
    });
    res.end();
  }

  async function handleToken(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const form = parseForm(await readBody(req));
    const clientId = form.get("client_id") ?? basicClientId(req) ?? "";
    const clientSecret =
      form.get("client_secret") ?? basicClientSecret(req) ?? "";

    if (
      !constantTimeEquals(clientId, config.oauth2.clientId) ||
      !constantTimeEquals(clientSecret, config.oauth2.clientSecret)
    ) {
      tokenError(
        req,
        res,
        "incorrect_client_credentials",
        "The client_id and/or client_secret passed are incorrect.",
      );
      return;
    }

    const grantType = form.get("grant_type") ?? "authorization_code";
    if (grantType === "refresh_token") {
      tokenError(
        req,
        res,
        "unsupported_grant_type",
        "This OAuth app does not issue refresh tokens.",
      );
      return;
    }
    if (grantType !== "authorization_code") {
      tokenError(
        req,
        res,
        "unsupported_grant_type",
        `grant_type ${grantType} is not supported.`,
      );
      return;
    }

    const code = form.get("code") ?? "";
    const record = codes.get(code);
    // Single-use: the code is burned even when the rest of the request is bad.
    codes.delete(code);
    if (!record) {
      tokenError(
        req,
        res,
        "bad_verification_code",
        "The code passed is incorrect or expired.",
      );
      return;
    }

    const redirectUri = form.get("redirect_uri");
    if (redirectUri !== null && redirectUri !== record.redirectUri) {
      tokenError(
        req,
        res,
        "redirect_uri_mismatch",
        "The redirect_uri MUST match the registered callback URL for this application.",
      );
      return;
    }

    if (record.codeChallenge !== undefined) {
      const verifier = form.get("code_verifier") ?? "";
      if (
        verifier.length === 0 ||
        !constantTimeEquals(s256(verifier), record.codeChallenge)
      ) {
        tokenError(
          req,
          res,
          "bad_verification_code",
          "The code passed is incorrect or expired.",
        );
        return;
      }
    }

    const accessToken = `gho_${randomBytes(20).toString("hex")}`;
    accessTokens.set(accessToken, record.scope);
    sendTokenBody(
      req,
      res,
      new URLSearchParams({
        access_token: accessToken,
        scope: record.scope,
        token_type: "bearer",
      }),
    );
  }

  function handleUserinfo(req: IncomingMessage, res: ServerResponse): void {
    const token = bearerToken(req);
    if (token === undefined || !accessTokens.has(token)) {
      sendJson(
        res,
        401,
        {
          message: "Bad credentials",
          documentation_url: `${config.issuer}/docs/oauth2`,
        },
        config.issuer,
      );
      return;
    }
    sendJson(
      res,
      200,
      {
        login: config.oauth2.login,
        // Numeric, immutable: the only field safe to use as the subject.
        id: config.oauth2.userId,
        node_id: `MDQ6VXNlcg${config.oauth2.userId}`,
        type: "User",
        name: config.testUser.name,
        // `null` for an account that keeps its address off the public
        // profile — GitHub's real answer, and the case that makes the
        // separate emails read necessary rather than merely better.
        email: config.oauth2.emailPrivate ? null : config.testUser.email,
        avatar_url: `${config.issuer}/avatars/${config.oauth2.login}.png`,
      },
      config.issuer,
    );
  }

  /**
   * GitHub's `/user/emails`: every address on the account, each with the
   * `primary` and `verified` booleans GitHub itself set. Requires the same
   * bearer as the profile; a token without the `user:email` scope would get a
   * 403 from the real thing, and an unauthenticated one a 401, which is why
   * this refuses the same way the profile does.
   */
  function handleEmails(req: IncomingMessage, res: ServerResponse): void {
    const token = bearerToken(req);
    if (token === undefined || !accessTokens.has(token)) {
      sendJson(
        res,
        401,
        {
          message: "Bad credentials",
          documentation_url: `${config.issuer}/docs/oauth2`,
        },
        config.issuer,
      );
      return;
    }
    sendJson(res, 200, config.oauth2.emails, config.issuer);
  }

  function handleMetadata(res: ServerResponse): void {
    const urls = oauth2Urls(config.issuer);
    sendJson(
      res,
      200,
      {
        issuer: config.issuer,
        authorization_endpoint: urls.authorizeUrl,
        token_endpoint: urls.tokenUrl,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
        ],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["read:user", "user:email"],
      },
      config.issuer,
    );
  }

  return {
    handle(req, res, url) {
      const path = url.pathname;
      if (req.method === "GET" && path === OAUTH2_AUTHORIZE_PATH) {
        handleAuthorize(res, url);
        return true;
      }
      if (req.method === "POST" && path === OAUTH2_TOKEN_PATH) {
        return handleToken(req, res).then(() => true);
      }
      if (req.method === "GET" && path === OAUTH2_EMAILS_PATH) {
        handleEmails(req, res);
        return true;
      }
      if (req.method === "GET" && path === OAUTH2_USERINFO_PATH) {
        handleUserinfo(req, res);
        return true;
      }
      if (req.method === "GET" && path === OAUTH2_METADATA_PATH) {
        handleMetadata(res);
        return true;
      }
      return false;
    },
  };
}
