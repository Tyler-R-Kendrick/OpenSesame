import type { SyncBlob, SyncCursor } from "@opensesame/client-core";

export interface ApiClientOptions {
  /** Host API base URL, e.g. http://127.0.0.1:8787 */
  baseUrl: string;
  /** Optional bearer / capability token */
  accessToken?: string;
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

export function createApiClient(options: ApiClientOptions) {
  const fetchFn = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (options.accessToken) {
      headers.set("authorization", `Bearer ${options.accessToken}`);
    }
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetchFn(`${base}${path}`, { ...init, headers });
  }

  return {
    baseUrl: base,

    async health(): Promise<{ ok: boolean; body: string }> {
      const res = await request("/health/live");
      return { ok: res.ok, body: await res.text() };
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
        body: JSON.stringify({ since_epoch: since.epoch }),
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
