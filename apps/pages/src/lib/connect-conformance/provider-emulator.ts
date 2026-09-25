/**
 * A strict OAuth 2.0 authorization server standing in for one provider
 * (ADR 0146 conformance). It speaks RFC 6749 authorization code with the
 * client authentication the connector was configured for, RFC 7636 PKCE when
 * the preset says the provider supports it, RFC 7591 registration for
 * self-registering servers, and answers the preset's own verify call — so a
 * connector whose settings are wrong fails here the way it would at the
 * provider, and one whose settings are right ends with a working token.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type JsonValue,
  isJsonObject,
  isString,
  readString,
} from "@opensesame/os-domain";

export type ClientRecord = {
  clientId: string;
  clientSecret: string;
  tokenAuth: "client_secret_post" | "client_secret_basic" | "none";
  redirectUris: string[];
};

export type ProviderProfile = {
  /** Endpoints by path, whatever host the preset names. */
  authorizePath: string;
  tokenPath: string;
  registerPath: string;
  /** PKCE: required refuses a request without it; none ignores it. */
  pkce: "S256" | "none" | "required";
  /** Extra authorization parameters the provider insists on. */
  requiredParams: Record<string, string>;
  verify: {
    method: string;
    path: string;
    header: string | null;
    scheme: string | null;
    basic: { username: string; password: string } | null;
    headers: Record<string, string>;
    accountField: string | null;
    mcp: boolean;
  } | null;
  /** Accept any https client id without registration (CIMD). */
  cimd: boolean;
};

type Code = {
  clientId: string;
  redirectUri: string;
  challenge: string | null;
  scope: string;
  used: boolean;
};

const ACCOUNT = "Acme Conformance Account";

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oauthError(error: string, description: string, status = 400) {
  return json({ error, error_description: description }, status);
}

/** `{ a: { b: [ { c: value } ] } }` for the dot path `a.b.0.c`. */
export function accountReplyFor(path: string | null, value: string): JsonValue {
  if (!path) return { ok: true, id: "conformance" };
  const parts = path.split(".");
  let out: JsonValue = value;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i] ?? "";
    out = /^\d+$/.test(part) ? [out] : { [part]: out };
  }
  return out;
}

/** `Authorization: Basic` → [user, pass], URL-decoded, or null. */
function basicPair(header: string): [string, string] | null {
  if (!header.startsWith("Basic ")) return null;
  const [user, pass] = Buffer.from(header.slice(6), "base64")
    .toString("utf8")
    .split(":");
  return [decodeURIComponent(user ?? ""), decodeURIComponent(pass ?? "")];
}

const TOKEN_AUTHS: readonly ClientRecord["tokenAuth"][] = [
  "client_secret_post",
  "client_secret_basic",
  "none",
];

function isTokenAuth(
  value: JsonValue | undefined,
): value is ClientRecord["tokenAuth"] {
  return TOKEN_AUTHS.some((known) => known === value);
}

/** RFC 6749 §2.3: the client authenticates the way it registered, or not at all. */
function clientAuthRefusal(
  client: ClientRecord,
  claimed: [string, string] | null,
  posted: string | null,
): string | null {
  if (client.tokenAuth === "none") {
    return posted || claimed ? "public client sent a secret" : null;
  }
  if (client.tokenAuth === "client_secret_basic") {
    if (!claimed) return "client_secret_basic expected";
    return claimed[1] === client.clientSecret ? null : "bad secret";
  }
  if (claimed) return "client_secret_post expected";
  return posted === client.clientSecret ? null : "bad secret";
}

/** The key inside a Basic pair shaped like the preset's (`api:{key}`). */
function basicCredential(
  raw: string,
  basic: { username: string; password: string },
): string | null {
  const pair = basicPair(raw);
  if (!pair) return null;
  const [user, pass] = pair;
  if (
    basic.username === "{key}" &&
    pass === basic.password.replace("{key}", "")
  ) {
    return user;
  }
  if (basic.password === "{key}" && user === basic.username) return pass;
  return null;
}

export class ProviderEmulator {
  readonly clients = new Map<string, ClientRecord>();
  readonly issued = new Set<string>();
  readonly apiKeys = new Set<string>();
  readonly log: string[] = [];
  private readonly codes = new Map<string, Code>();

  constructor(readonly profile: ProviderProfile) {}

  /** What a person does at the provider's developer console. */
  registerByHand(client: ClientRecord): void {
    this.clients.set(client.clientId, client);
  }

  /** What a person does at the provider's key page. */
  issueApiKey(): string {
    const key = `key_${b64url(randomBytes(18))}`;
    this.apiKeys.add(key);
    return key;
  }

  private client(id: string): ClientRecord | undefined {
    const known = this.clients.get(id);
    if (known) return known;
    if (this.profile.cimd && id.startsWith("https://")) {
      return {
        clientId: id,
        clientSecret: "",
        tokenAuth: "none",
        redirectUris: [],
      };
    }
    return undefined;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.log.push(`${request.method} ${url.pathname}`);
    if (
      request.method === "GET" &&
      url.pathname === this.profile.authorizePath
    ) {
      return this.authorize(url);
    }
    if (request.method === "POST" && url.pathname === this.profile.tokenPath) {
      return this.token(request);
    }
    if (
      request.method === "POST" &&
      url.pathname === this.profile.registerPath
    ) {
      return this.register(request);
    }
    if (this.profile.verify && this.verifyPath(url.pathname)) {
      return this.verify(request);
    }
    return json({ error: "not_found", path: url.pathname }, 404);
  }

  private verifyPath(pathname: string): boolean {
    const want = this.profile.verify?.path ?? "";
    if (!want.includes("{key}")) return pathname === want;
    const [head, tail] = want.split("{key}");
    return pathname.startsWith(head ?? "") && pathname.endsWith(tail ?? "");
  }

  /** Why an authorization request is refused, or null. */
  private refusal(
    q: URLSearchParams,
    client: ClientRecord | undefined,
  ): Response | null {
    if (q.get("response_type") !== "code") {
      return oauthError("unsupported_response_type", "code only");
    }
    if (!client) return oauthError("invalid_client", "unknown client_id");
    const redirectUri = q.get("redirect_uri") ?? "";
    if (
      client.redirectUris.length > 0 &&
      !client.redirectUris.includes(redirectUri)
    ) {
      return oauthError("invalid_request", "redirect_uri is not registered");
    }
    for (const [key, value] of Object.entries(this.profile.requiredParams)) {
      if (q.get(key) !== value) {
        return oauthError("invalid_request", `missing ${key}=${value}`);
      }
    }
    const challenge = q.get("code_challenge");
    if (this.profile.pkce === "required" && !challenge) {
      return oauthError("invalid_request", "code_challenge required");
    }
    if (challenge && q.get("code_challenge_method") !== "S256") {
      return oauthError("invalid_request", "S256 only");
    }
    return null;
  }

  private authorize(url: URL): Response {
    const q = url.searchParams;
    const client = this.client(q.get("client_id") ?? "");
    const refused = this.refusal(q, client);
    if (refused || !client)
      return refused ?? oauthError("invalid_client", "unknown client_id");
    const redirectUri = q.get("redirect_uri") ?? "";
    const code = b64url(randomBytes(16));
    this.codes.set(code, {
      clientId: client.clientId,
      redirectUri,
      challenge: this.profile.pkce === "none" ? null : q.get("code_challenge"),
      scope: q.get("scope") ?? "",
      used: false,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    const state = q.get("state");
    if (state) back.searchParams.set("state", state);
    return new Response(null, {
      status: 302,
      headers: { location: back.toString() },
    });
  }

  private authenticate(
    request: Request,
    form: URLSearchParams,
  ): ClientRecord | string {
    const claimed = basicPair(request.headers.get("authorization") ?? "");
    const client = this.client(
      claimed ? claimed[0] : (form.get("client_id") ?? ""),
    );
    if (!client) return "unknown client";
    const refusal = clientAuthRefusal(
      client,
      claimed,
      form.get("client_secret"),
    );
    return refusal ?? client;
  }

  private async token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const client = this.authenticate(request, form);
    if (isString(client)) return oauthError("invalid_client", client, 401);
    if (form.get("grant_type") !== "authorization_code") {
      return oauthError("unsupported_grant_type", "authorization_code only");
    }
    const code = this.codes.get(form.get("code") ?? "");
    if (!code || code.used || code.clientId !== client.clientId) {
      return oauthError("invalid_grant", "code unknown, spent or not yours");
    }
    code.used = true;
    if (code.redirectUri !== (form.get("redirect_uri") ?? "")) {
      return oauthError("invalid_grant", "redirect_uri mismatch");
    }
    if (code.challenge) {
      const verifier = form.get("code_verifier") ?? "";
      const expected = b64url(createHash("sha256").update(verifier).digest());
      if (expected !== code.challenge) {
        return oauthError("invalid_grant", "PKCE verifier mismatch");
      }
    }
    const accessToken = `at_${b64url(randomBytes(24))}`;
    this.issued.add(accessToken);
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: `rt_${b64url(randomBytes(24))}`,
      scope: code.scope,
    });
  }

  private async register(request: Request): Promise<Response> {
    const parsed: JsonValue = await request.json();
    const body = isJsonObject(parsed) ? parsed : {};
    const tokenAuth = body.token_endpoint_auth_method;
    const redirectUris = body.redirect_uris;
    const client: ClientRecord = {
      clientId: `dcr_${b64url(randomBytes(9))}`,
      clientSecret: "",
      tokenAuth: isTokenAuth(tokenAuth) ? tokenAuth : "none",
      redirectUris: Array.isArray(redirectUris)
        ? redirectUris.flatMap((uri) => readString(uri) ?? [])
        : [],
    };
    if (client.tokenAuth !== "none")
      client.clientSecret = b64url(randomBytes(18));
    this.clients.set(client.clientId, client);
    return json(
      {
        client_id: client.clientId,
        client_secret: client.clientSecret || undefined,
        token_endpoint_auth_method: client.tokenAuth,
        redirect_uris: client.redirectUris,
      },
      201,
    );
  }

  /** The credential the preset says the service reads, or null. */
  private presented(request: Request): string | null {
    const verify = this.profile.verify;
    if (!verify) return null;
    for (const [name, value] of Object.entries(verify.headers)) {
      if (request.headers.get(name) !== value) return null;
    }
    if (!verify.header) {
      const path = new URL(request.url).pathname;
      return [...this.apiKeys].find((key) => path.includes(key)) ?? null;
    }
    const raw = request.headers.get(verify.header) ?? "";
    if (verify.basic) return basicCredential(raw, verify.basic);
    if (!verify.scheme) return raw || null;
    return raw.startsWith(`${verify.scheme} `)
      ? raw.slice(verify.scheme.length + 1)
      : null;
  }

  private verify(request: Request): Response {
    const verify = this.profile.verify;
    const credential = this.presented(request);
    const known =
      credential !== null &&
      (this.issued.has(credential) || this.apiKeys.has(credential));
    if (!verify || !known) return json({ error: "unauthorized" }, 401);
    if (request.method !== verify.method) return json({ error: "method" }, 405);
    if (verify.mcp) {
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: ACCOUNT },
        },
      });
    }
    return json(accountReplyFor(verify.accountField, ACCOUNT));
  }
}

export const CONFORMANCE_ACCOUNT = ACCOUNT;
