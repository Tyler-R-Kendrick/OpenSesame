import type { SyncBlob, SyncCursor } from "@opensesame/client-core";
import {
  type AuthorizeRequest,
  type AuthorizeResponse,
  AuthorizeResponseSchema,
  type Connection,
  ConnectionSchema,
  type CreateBindingRequest,
  type CreateConnectionRequest,
  type ListConnectionsResponse,
  ListConnectionsResponseSchema,
  type ListEventsResponse,
  ListEventsResponseSchema,
  type ListProvidersResponse,
  ListProvidersResponseSchema,
  type RevokeResponse,
  RevokeResponseSchema,
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

/** Structural view of a zod schema, so the client needs no zod dependency of its own. */
interface ResponseSchema<T> {
  parse(value: unknown): T;
}

/**
 * The broker answers failures with `{ error, hint }` (ADR 0032). Carry the code
 * into the message so callers can branch on it instead of on the status alone.
 */
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

/** Create an in-memory ES256 keypair and DPoP proof factory. */
export async function createDpopKeyPair() {
  const subtle = await getSubtle();
  const keyPair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  const { kty, crv, x, y } = jwk;

  async function createDpopProof(htu: string, htm: string): Promise<string> {
    const header = {
      alg: "ES256",
      typ: "dpop+jwt",
      jwk: { kty, crv, x, y },
    };
    const payload = {
      iat: Math.floor(Date.now() / 1000),
      jti: randomJti(),
      htu,
      htm: htm.toUpperCase(),
    };
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

export function createApiClient(options: ApiClientOptions) {
  const fetchFn = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  let dpopFactory: Awaited<ReturnType<typeof createDpopKeyPair>> | null = null;

  async function ensureDpop() {
    if (!options.dpop) return null;
    if (!dpopFactory) dpopFactory = await createDpopKeyPair();
    return dpopFactory;
  }

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (options.accessToken) {
      headers.set("authorization", `Bearer ${options.accessToken}`);
    }
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const method = (init.method ?? "GET").toUpperCase();
    const url = `${base}${path}`;
    const dpop = await ensureDpop();
    if (dpop) {
      headers.set("DPoP", await dpop.createDpopProof(url, method));
    }
    return fetchFn(url, { ...init, headers });
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
            discovery.authorizationServers =
              body.authorization_servers as string[];
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

    async getConnection(id: string): Promise<Connection> {
      return requestParsed("connection", ConnectionSchema, connectionPath(id));
    },

    async createConnection(body: CreateConnectionRequest): Promise<Connection> {
      return requestParsed(
        "connection_create",
        ConnectionSchema,
        "/api/v1/connections",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
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

    /** api_key providers only; the value is write-only and never read back. */
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
