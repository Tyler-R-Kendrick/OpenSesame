/**
 * Vercel Connect, emulated for conformance (ADR 0146): the create, read,
 * update, authorize, callback and token routes the relay calls. Every create
 * body is held to Vercel's published schema first. An OAuth connector runs a
 * real authorization-code exchange against the provider emulator with the
 * client authentication, PKCE and parameters it was configured with; a
 * preset (assisted) connector registers its own client the way Vercel does
 * (RFC 7591, or a client ID metadata document URL); an API-key connector
 * with a user subject collects each person's key at authorization.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { assertConnectAccepts } from "@opensesame/app-core/lib/vercel-connect-schema.test-support.js";
import {
  type JsonObject,
  type JsonValue,
  isString,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";
import { CALLBACK, type Stored, resolveClient } from "./connect-clients.js";

export const CONNECT_ORIGIN = "https://api.vercel.com";
const KEY_ENTRY = `${CONNECT_ORIGIN}/v1/connect/key-entry`;

type Pending = {
  connectorId: string;
  subject: string;
  verifier: string;
  returnUrl: string;
  scopes: string[];
};

function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refuse(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}

function subjectKey(subject: JsonValue | undefined): string {
  const s = readJsonObject(subject) ?? {};
  return s.type === "user" ? `user:${String(s.id)}` : "app";
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");

/** The scopes a connector was created with, when a request names none. */
function configuredScopes(data: JsonObject): string[] {
  const scopes = readJsonObject(data.userAuthorization)?.scopes;
  return Array.isArray(scopes) ? scopes.map(String) : [];
}

export class ConnectEmulator {
  readonly connectors = new Map<string, Stored>();
  readonly tokens = new Map<string, string>();
  readonly refusals: string[] = [];
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly plan: ConnectPlan,
    /** The provider emulator's fetch (any host → it). */
    private readonly provider: (request: Request) => Promise<Response>,
  ) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parsed: JsonValue =
      request.method === "GET" ? {} : await request.json().catch(() => ({}));
    const body = readJsonObject(parsed) ?? {};
    for (const [method, pattern, run] of this.routes) {
      const match = pattern.exec(url.pathname);
      if (match && (method === "*" || method === request.method)) {
        return run(
          decodeURIComponent(match[1] ?? ""),
          body,
          url,
          request.method,
        );
      }
    }
    return refuse(
      "not_found",
      `No route ${request.method} ${url.pathname}`,
      404,
    );
  }

  private readonly routes: [
    string,
    RegExp,
    (
      id: string,
      body: JsonObject,
      url: URL,
      method: string,
    ) => Response | Promise<Response>,
  ][] = [
    ["POST", /^\/v1\/connect\/connectors$/, (_id, body) => this.create(body)],
    [
      "*",
      /^\/v1\/connect\/connectors\/([^/]+)$/,
      (id, body, _url, method) => this.connector(id, body, method),
    ],
    [
      "POST",
      /^\/v1\/connect\/authorize\/([^/]+)$/,
      (id, body) => this.authorize(id, body),
    ],
    [
      "GET",
      /^\/v1\/connect\/callback$/,
      (_id, _body, url) => this.callback(url),
    ],
    [
      "POST",
      /^\/v1\/connect\/key-entry$/,
      (_id, body, url) => this.keyEntry(url, body),
    ],
    [
      "POST",
      /^\/v1\/connect\/token\/([^/]+)$/,
      (id, body) => this.token(id, body),
    ],
  ];

  private connector(id: string, body: JsonObject, method: string): Response {
    const stored = this.connectors.get(id);
    if (!stored) return refuse("not_found", "Connector not found.", 404);
    if (method === "PATCH") {
      Object.assign(stored.data, readJsonObject(body.data) ?? {});
      const name = readString(body.name);
      if (name !== undefined) stored.name = name;
    }
    return json({ connector: this.view(stored) });
  }

  private token(id: string, body: JsonObject): Response {
    const token = this.tokens.get(`${id}|${subjectKey(body.subject)}`);
    if (!token)
      return refuse("authorization_required", "Authorize first.", 403);
    return json({
      token,
      tokenId: `tok_${token.length}`,
      expiresAt: Date.now() + 3_600_000,
    });
  }

  private view(stored: Stored): JsonObject {
    const { oauth: _oauth, preset: _preset, ...rest } = stored;
    const { clientSecret: _secret, values: _values, ...data } = rest.data;
    return { ...rest, data, redirectUri: CALLBACK };
  }

  private async create(body: JsonObject): Promise<Response> {
    try {
      assertConnectAccepts(body);
    } catch (error) {
      this.refusals.push(String(error));
      return refuse("invalid_request", String(error).slice(0, 400));
    }
    const id = `scl_${b64url(randomBytes(8))}`;
    const service = String(body.service);
    const stored: Stored = {
      id,
      uid: readString(body.uid) ?? `${service}/${id}`,
      name: String(body.name ?? service),
      service,
      type: readString(body.type) ?? String(body.connectionMethod ?? "managed"),
      connectionMethod: readString(body.connectionMethod),
      preset: !isString(body.type),
      data: { ...(readJsonObject(body.data) ?? {}) },
    };
    const failure = await resolveClient(this.plan, this.provider, stored);
    if (failure) return refuse("invalid_configuration", failure);
    this.connectors.set(id, stored);
    this.connectors.set(stored.uid, stored);
    const values = stored.data.values;
    if (Array.isArray(values) && values.length > 0) {
      this.tokens.set(`${id}|app`, String(readJsonObject(values[0])?.value));
    }
    return json({ connector: this.view(stored) });
  }

  /** How Vercel ends up with a client for this connector. */
  private authorize(id: string, body: JsonObject): Response {
    const stored = this.connectors.get(id);
    if (!stored) return refuse("not_found", "Connector not found.", 404);
    const request = b64url(randomBytes(12));
    const verifier = b64url(randomBytes(32));
    const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
    this.pending.set(request, {
      connectorId: stored.id,
      subject: subjectKey(body.subject),
      verifier,
      returnUrl: String(body.returnUrl ?? ""),
      scopes,
    });
    if (!stored.oauth) {
      return json({
        url: `${KEY_ENTRY}?request=${request}`,
        request,
        expiresAt: Date.now() + 600_000,
      });
    }
    const o = stored.oauth;
    const url = new URL(o.authorize);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", o.clientId);
    url.searchParams.set("redirect_uri", CALLBACK);
    url.searchParams.set("state", request);
    const granted = scopes.length ? scopes : configuredScopes(stored.data);
    if (granted.length) url.searchParams.set("scope", granted.join(" "));
    if (o.pkce) {
      url.searchParams.set(
        "code_challenge",
        b64url(createHash("sha256").update(verifier).digest()),
      );
      url.searchParams.set("code_challenge_method", "S256");
    }
    for (const [key, value] of Object.entries(o.params))
      url.searchParams.set(key, value);
    return json({
      url: url.toString(),
      request,
      expiresAt: Date.now() + 600_000,
    });
  }

  private async callback(url: URL): Promise<Response> {
    const pending = this.pending.get(url.searchParams.get("state") ?? "");
    if (!pending) return refuse("invalid_state", "Unknown authorization.");
    this.pending.delete(url.searchParams.get("state") ?? "");
    const stored = this.connectors.get(pending.connectorId);
    const o = stored?.oauth;
    if (!stored || !o) return refuse("invalid_state", "No OAuth client.");
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: url.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
    });
    if (o.pkce) form.set("code_verifier", pending.verifier);
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    });
    if (o.tokenAuth === "client_secret_basic") {
      headers.set(
        "authorization",
        `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString("base64")}`,
      );
    } else {
      form.set("client_id", o.clientId);
      if (o.tokenAuth === "client_secret_post")
        form.set("client_secret", o.clientSecret);
    }
    const reply = await this.provider(
      new Request(o.token, { method: "POST", headers, body: form.toString() }),
    );
    const token: JsonValue = await reply.json().catch(() => ({}));
    const accessToken = readString(readJsonObject(token)?.access_token);
    if (reply.status !== 200 || accessToken === undefined) {
      return refuse(
        "token_exchange_failed",
        JSON.stringify(token).slice(0, 300),
        502,
      );
    }
    this.tokens.set(`${stored.id}|${pending.subject}`, accessToken);
    return new Response(null, {
      status: 302,
      headers: { location: pending.returnUrl },
    });
  }

  /** The page Connect shows a person to paste their own key. */
  private keyEntry(url: URL, body: JsonObject): Response {
    const pending = this.pending.get(url.searchParams.get("request") ?? "");
    const key = readString(body.key);
    if (!pending || key === undefined)
      return refuse("invalid_request", "No key.");
    this.pending.delete(url.searchParams.get("request") ?? "");
    this.tokens.set(`${pending.connectorId}|${pending.subject}`, key);
    return json({ location: pending.returnUrl });
  }
}
