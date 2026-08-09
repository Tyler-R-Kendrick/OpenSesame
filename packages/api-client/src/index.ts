import type { SyncBlob, SyncCursor } from "@opensesame/client-core";

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
      headers.set(
        "DPoP",
        await dpop.createDpopProof(url, method, options.accessToken),
      );
    }
    return fetchFn(url, { ...init, headers });
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

    async listConnections(): Promise<unknown> {
      const res = await request("/api/v1/connections");
      if (!res.ok) throw new Error(`connections_failed:${res.status}`);
      return res.json();
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
