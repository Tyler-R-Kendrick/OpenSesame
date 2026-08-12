import type { SyncBlob, SyncCursor } from "@opensesame/client-core";
import {
  type AuthorizeRequest,
  type AuthorizeResponse,
  AuthorizeResponseSchema,
  type Connection,
  ConnectionSchema,
  type CreateBindingRequest,
  type CreateConnectionRequest,
  type CreateIntegrationRequest,
  type DiscoverConnectionsResponse,
  DiscoverConnectionsResponseSchema,
  type Integration,
  IntegrationSchema,
  type ListConnectionsResponse,
  ListConnectionsResponseSchema,
  type ListEventsResponse,
  ListEventsResponseSchema,
  type ListIntegrationsResponse,
  ListIntegrationsResponseSchema,
  type ListProvidersResponse,
  ListProvidersResponseSchema,
  type RevokeResponse,
  RevokeResponseSchema,
  type UpdateIntegrationRequest,
} from "@opensesame/contracts";

export interface ApiClientOptions {
  /** Host API base URL, e.g. http://127.0.0.1:8787 */
  baseUrl: string;
  /** Optional bearer / capability token */
  accessToken?: string;
  /** When true, attach DPoP proofs (ES256) on mutating/authenticated calls */
  dpop?: boolean;
  fetchImpl?: typeof fetch;
}

export interface InvokeInput {
  connectionRef: string;
  operation: string;
  resource: string;
  invokeLevel?: number;
  input?: unknown;
}

export interface DaemonProbe {
  available: boolean;
  url: string;
  health?: unknown;
}

export interface HostDiscovery {
  resource?: string;
  authorizationServers?: string[];
  dpopBound?: boolean;
  ready?: boolean;
  source: "prm" | "ready" | "none";
}

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

async function requestFailure(op: string, res: Response): Promise<Error> {
  let code = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string") code = body.error;
  } catch {
    /* non-JSON error body */
  }
  return new Error(
    code ? `${op}_failed:${res.status}:${code}` : `${op}_failed:${res.status}`,
  );
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Cryptographically strong jti — never Math.random. */
function randomJti(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return b64url(bytes);
  }
  throw new Error("crypto_unavailable_for_dpop_jti");
}

async function getSubtle(): Promise<SubtleCrypto> {
  // Prefer Web Crypto (browsers + Node 19+). Avoid new Function / eval for node:crypto
  // fallback — that trips structural SAST and is unnecessary once subtle is global.
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return subtle;
  throw new Error("crypto_subtle_unavailable");
}

/**
 * RFC 9449 §4.3 `ath`: the hash of the access token the proof travels with.
 *
 * Without it a proof is bound to a key and a request but not to a token, so a
 * proof observed alongside one token can be replayed alongside another. The
 * verifier in `crates/proof` requires it whenever a token is present, so a proof
 * minted without it was never going to be accepted either.
 */
export async function accessTokenHash(accessToken: string): Promise<string> {
  const subtle = await getSubtle();
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(accessToken),
  );
  return b64url(digest);
}

/** Create an in-memory ES256 keypair and DPoP proof factory. */
export async function createDpopKeyPair() {
  const subtle = await getSubtle();
  const keyPair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  // Explicit reads (not destructuring): the extension bundler targets firefox78,
  // where esbuild refuses to transform this destructuring pattern.
  const kty = jwk.kty;
  const crv = jwk.crv;
  const x = jwk.x;
  const y = jwk.y;

  async function createDpopProof(
    htu: string,
    htm: string,
    accessToken?: string,
    nonce?: string,
  ): Promise<string> {
    const header = {
      alg: "ES256",
      typ: "dpop+jwt",
      jwk: { kty, crv, x, y },
    };
    const payload: Record<string, unknown> = {
      iat: Math.floor(Date.now() / 1000),
      jti: randomJti(),
      // A query string is not part of the bound URI (RFC 9449 §4.2).
      htu: htuFor(htu),
      htm: htm.toUpperCase(),
    };
    if (accessToken) {
      payload.ath = await accessTokenHash(accessToken);
    }
    // RFC 9449 §8: a server may require its own nonce so it, not the client,
    // decides how fresh a proof is.
    if (nonce) {
      payload.nonce = nonce;
    }
    const enc = new TextEncoder();
    const h = b64url(enc.encode(JSON.stringify(header)));
    const p = b64url(enc.encode(JSON.stringify(payload)));
    const data = enc.encode(`${h}.${p}`);
    const sig = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      data,
    );
    return `${h}.${p}.${b64url(sig)}`;
  }

  return { createDpopProof, jwk: { kty, crv, x, y } };
}

/** The bound URI: scheme, authority and path, without query or fragment. */
function htuFor(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Host API base URLs must stay on loopback for local-first clients (extension,
 * PWA, toolbar) — the same fence the daemon and gateway enforce on bind.
 * Returns a normalized origin+path, or null when the value is not loopback http(s).
 */
/**
 * Base URL for a service that may legitimately be remote (an issuer, a hosted Host
 * API). Plaintext HTTP is confined to loopback, because these clients send a
 * session bearer with every call and cleartext hands it to the network.
 * Returns a normalized origin+path, or null when the value is unusable.
 */
export function normalizeHttpBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  const normalized = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  if (
    url.protocol === "http:" &&
    normalizeLoopbackBaseUrl(normalized) === null
  ) {
    return null;
  }
  return normalized;
}

export function normalizeLoopbackBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const isLoopbackV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (
    !LOOPBACK_HOSTS.has(host) &&
    !host.endsWith(".localhost") &&
    !isLoopbackV4
  ) {
    return null;
  }
  if (url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

export function createApiClient(options: ApiClientOptions) {
  const fetchFn = options.fetchImpl ?? fetch;
  // This client sends a bearer with every call, so the destination is checked here
  // rather than left to each caller to remember: http is confined to loopback, and
  // credentials, queries and fragments in a base URL are refused.
  const base = normalizeHttpBaseUrl(options.baseUrl);
  if (base === null) {
    throw new Error("baseUrl must be an https URL, or http on loopback");
  }
  let dpopFactory: Awaited<ReturnType<typeof createDpopKeyPair>> | null = null;

  /** Most recent nonce this server handed out, for the next proof. */
  let dpopNonce: string | undefined;

  async function ensureDpop() {
    if (!options.dpop) return null;
    if (!dpopFactory) dpopFactory = await createDpopKeyPair();
    return dpopFactory;
  }

  /**
   * True when a response is refusing a proof only because it wants a nonce.
   * Anything else is a real refusal and is handed back to the caller untouched.
   */
  function asksForNonce(res: Response): boolean {
    if (res.status !== 401) return false;
    const challenge = res.headers.get("www-authenticate") ?? "";
    return (
      /use_dpop_nonce/iu.test(challenge) ||
      (res.headers.get("dpop-nonce") !== null && /dpop/iu.test(challenge))
    );
  }

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const url = `${base}${path}`;
    const dpop = await ensureDpop();

    const send = async (): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      if (options.accessToken) {
        headers.set("authorization", `Bearer ${options.accessToken}`);
      }
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      if (dpop) {
        headers.set(
          "DPoP",
          await dpop.createDpopProof(
            url,
            method,
            options.accessToken,
            dpopNonce,
          ),
        );
      }
      const res = await fetchFn(url, { ...init, headers });
      const issued = res.headers.get("dpop-nonce");
      if (issued) dpopNonce = issued;
      return res;
    };

    const first = await send();
    if (dpop && asksForNonce(first) && dpopNonce !== undefined) {
      // Once. A server that keeps asking will not be satisfied by asking again,
      // and a loop here is a loop against somebody else's endpoint.
      return send();
    }
    return first;
  }

  async function requestParsed<T>(
    op: string,
    schema: ResponseSchema<T>,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const res = await request(path, init);
    if (!res.ok) throw await requestFailure(op, res);
    return schema.parse(await res.json());
  }

  function connectionPath(id: string, suffix = ""): string {
    return `/api/v1/connections/${encodeURIComponent(id)}${suffix}`;
  }

  function integrationPath(id: string): string {
    return `/api/v1/integrations/${encodeURIComponent(id)}`;
  }

  return {
    baseUrl: base,

    async health(): Promise<{ ok: boolean; body: string }> {
      const res = await request("/health/live");
      return { ok: res.ok, body: await res.text() };
    },

    async discover(): Promise<HostDiscovery> {
      try {
        const prm = await request("/.well-known/oauth-protected-resource");
        if (prm.ok) {
          const body = (await prm.json()) as Record<string, unknown>;
          const discovery: HostDiscovery = {
            dpopBound: Boolean(
              body.dpop_bound ?? body.dpop_bound_access_tokens_required,
            ),
            source: "prm",
          };
          if (typeof body.resource === "string") {
            discovery.resource = body.resource;
          }
          if (Array.isArray(body.authorization_servers)) {
            // Where a client goes to be issued tokens is not a free-form string:
            // a resource that names a cleartext or malformed authorization server
            // is naming somewhere this client will not send a credential.
            discovery.authorizationServers = body.authorization_servers
              .map((value) =>
                typeof value === "string" ? normalizeHttpBaseUrl(value) : null,
              )
              .filter((value): value is string => value !== null);
          }
          return discovery;
        }
      } catch {
        /* fall through */
      }
      try {
        const ready = await request("/health/ready");
        if (ready.ok) {
          return { ready: true, source: "ready" };
        }
      } catch {
        /* fall through */
      }
      return { source: "none" };
    },

    async whoami(): Promise<unknown> {
      const res = await request("/api/v1/whoami");
      if (!res.ok) throw new Error(`whoami_failed:${res.status}`);
      return res.json();
    },

    async listProviders(): Promise<ListProvidersResponse> {
      return requestParsed(
        "providers",
        ListProvidersResponseSchema,
        "/api/v1/providers",
      );
    },

    async listConnections(): Promise<ListConnectionsResponse> {
      return requestParsed(
        "connections",
        ListConnectionsResponseSchema,
        "/api/v1/connections",
      );
    },

    async discoverConnections(): Promise<DiscoverConnectionsResponse> {
      return requestParsed(
        "connection discovery",
        DiscoverConnectionsResponseSchema,
        "/api/v1/connections/discover",
        { method: "POST" },
      );
    },

    async listIntegrations(): Promise<ListIntegrationsResponse> {
      return requestParsed(
        "integrations",
        ListIntegrationsResponseSchema,
        "/api/v1/integrations",
      );
    },

    async getIntegration(id: string): Promise<Integration> {
      return requestParsed(
        "integration",
        IntegrationSchema,
        integrationPath(id),
      );
    },

    async createIntegration(
      body: CreateIntegrationRequest,
    ): Promise<Integration> {
      return requestParsed(
        "integration_create",
        IntegrationSchema,
        "/api/v1/integrations",
        { method: "POST", body: JSON.stringify(body) },
      );
    },

    async updateIntegration(
      id: string,
      body: UpdateIntegrationRequest,
    ): Promise<Integration> {
      return requestParsed(
        "integration_update",
        IntegrationSchema,
        integrationPath(id),
        { method: "PATCH", body: JSON.stringify(body) },
      );
    },

    async deleteIntegration(id: string): Promise<void> {
      const res = await request(integrationPath(id), { method: "DELETE" });
      if (!res.ok) throw await requestFailure("integration_delete", res);
    },

    async getConnection(id: string): Promise<Connection> {
      return requestParsed("connection", ConnectionSchema, connectionPath(id));
    },

    async createConnection(body: CreateConnectionRequest): Promise<Connection> {
      return requestParsed(
        "connection_create",
        ConnectionSchema,
        "/api/v1/connections",
        { method: "POST", body: JSON.stringify(body) },
      );
    },

    async authorizeConnection(
      id: string,
      body: AuthorizeRequest = {},
    ): Promise<AuthorizeResponse> {
      return requestParsed(
        "connection_authorize",
        AuthorizeResponseSchema,
        connectionPath(id, "/authorize"),
        { method: "POST", body: JSON.stringify(body) },
      );
    },

    async refreshConnection(id: string): Promise<Connection> {
      return requestParsed(
        "connection_refresh",
        ConnectionSchema,
        connectionPath(id, "/refresh"),
        { method: "POST", body: "{}" },
      );
    },

    async setConnectionCredential(
      id: string,
      value: string,
    ): Promise<Connection> {
      return requestParsed(
        "connection_credential",
        ConnectionSchema,
        connectionPath(id, "/credential"),
        { method: "POST", body: JSON.stringify({ value }) },
      );
    },

    async revokeConnection(id: string): Promise<RevokeResponse> {
      return requestParsed(
        "connection_revoke",
        RevokeResponseSchema,
        connectionPath(id),
        { method: "DELETE" },
      );
    },

    async bindConnection(
      id: string,
      body: CreateBindingRequest,
    ): Promise<Connection> {
      return requestParsed(
        "connection_bind",
        ConnectionSchema,
        connectionPath(id, "/bindings"),
        { method: "POST", body: JSON.stringify(body) },
      );
    },

    async unbindConnection(id: string, bindingId: string): Promise<Connection> {
      return requestParsed(
        "connection_unbind",
        ConnectionSchema,
        connectionPath(id, `/bindings/${encodeURIComponent(bindingId)}`),
        { method: "DELETE" },
      );
    },

    async connectionEvents(id: string): Promise<ListEventsResponse> {
      return requestParsed(
        "connection_events",
        ListEventsResponseSchema,
        connectionPath(id, "/events"),
      );
    },

    /** L1 invoke via Host API. Never sends SecretRef. */
    async invoke(input: InvokeInput): Promise<unknown> {
      const res = await request("/api/v1/intents", {
        method: "POST",
        body: JSON.stringify({
          connection_ref: input.connectionRef,
          operation: input.operation,
          resource: input.resource,
          invoke_level: input.invokeLevel ?? 1,
          input: input.input ?? {},
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`invoke_failed:${res.status}:${text}`);
      }
      return res.json();
    },

    async syncPush(blobs: SyncBlob[]): Promise<unknown> {
      const res = await request("/api/v1/sync/push", {
        method: "POST",
        body: JSON.stringify({
          blobs: blobs.map((b) => ({
            id: b.id,
            epoch: b.epoch,
            ciphertext: Array.from(
              Uint8Array.from(atob(b.ciphertextB64), (c) => c.charCodeAt(0)),
            ),
          })),
        }),
      });
      if (!res.ok) throw new Error(`sync_push_failed:${res.status}`);
      return res.json();
    },

    async syncPull(since: SyncCursor): Promise<unknown> {
      const res = await request("/api/v1/sync/pull", {
        method: "POST",
        body: JSON.stringify({
          since_epoch: since.epoch,
          device_id: since.deviceId,
        }),
      });
      if (!res.ok) throw new Error(`sync_pull_failed:${res.status}`);
      return res.json();
    },

    /** Optional local daemon discovery — degrades cleanly if absent. */
    async probeDaemon(
      daemonUrl = "http://127.0.0.1:18790",
    ): Promise<DaemonProbe> {
      // The daemon is a process on this machine by definition; probing anywhere
      // else would announce this client to a stranger.
      if (normalizeLoopbackBaseUrl(daemonUrl) === null) {
        return { available: false, url: daemonUrl };
      }
      try {
        const res = await fetchFn(`${daemonUrl.replace(/\/$/, "")}/health`, {
          signal: AbortSignal.timeout?.(800),
        });
        if (!res.ok) return { available: false, url: daemonUrl };
        return { available: true, url: daemonUrl, health: await res.json() };
      } catch {
        return { available: false, url: daemonUrl };
      }
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
