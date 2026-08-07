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
  const b64 =
    typeof btoa !== "undefined"
      ? btoa(s)
      : Buffer.from(u8).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function getSubtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  const { webcrypto } = await import("node:crypto");
  return webcrypto.subtle as SubtleCrypto;
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
      jti: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
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

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
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
          return {
            resource: typeof body.resource === "string" ? body.resource : undefined,
            authorizationServers: Array.isArray(body.authorization_servers)
              ? (body.authorization_servers as string[])
              : undefined,
            dpopBound: Boolean(body.dpop_bound ?? body.dpop_bound_access_tokens_required),
            source: "prm",
          };
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
              typeof Buffer !== "undefined"
                ? Buffer.from(b.ciphertextB64, "base64")
                : Uint8Array.from(atob(b.ciphertextB64), (c) => c.charCodeAt(0)),
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
