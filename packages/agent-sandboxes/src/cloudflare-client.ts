/**
 * Cloudflare Browser Run (Browser Rendering) session client.
 *
 * Allocation is one REST call (`POST /devtools/browser`); the browser is
 * then driven over its per-session CDP WebSocket. The API token is
 * provider configuration (environment), never a page secret, and sessions
 * are closed with `DELETE` when the run ends.
 *
 * API shape: https://developers.cloudflare.com/browser-run/cdp/
 */

import { z } from "zod";

export interface CloudflareClientOptions {
  accountId: string;
  apiToken: string;
  /** Defaults to the public Cloudflare API; injectable for tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** How long a session may idle before Browser Run closes it. */
  sessionTimeoutMs?: number;
  keepAliveMs?: number;
}

interface CreateSessionBody {
  sessionTimeout?: number;
  keepAlive?: number;
}

export interface CloudflareSession {
  sessionId: string;
  /** Browser-level CDP WebSocket URL for this session. */
  webSocketUrl: string;
}

const sessionResponseSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ message: z.string() })).optional(),
  result: z
    .object({
      sessionId: z.string(),
      webSocketDebuggerUrl: z.string().optional(),
    })
    .optional(),
});

export class CloudflareBrowserRunClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CloudflareClientOptions) {
    if (!options.accountId || !options.apiToken)
      throw new Error(
        "cloudflare provider needs an account id and API token (environment)",
      );
    this.baseUrl = (
      options.baseUrl ??
      `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/browser-run`
    ).replace(/\/$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers() {
    return {
      authorization: `Bearer ${this.options.apiToken}`,
      "content-type": "application/json",
    };
  }

  /** Headers the CDP WebSocket upgrade must carry for this account. */
  cdpHeaders() {
    return { authorization: `Bearer ${this.options.apiToken}` };
  }

  async createSession(): Promise<CloudflareSession> {
    const body: CreateSessionBody = {};
    if (this.options.sessionTimeoutMs !== undefined)
      body.sessionTimeout = this.options.sessionTimeoutMs;
    if (this.options.keepAliveMs !== undefined)
      body.keepAlive = this.options.keepAliveMs;
    const response = await this.fetchImpl(`${this.baseUrl}/devtools/browser`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const parsed = sessionResponseSchema.parse(await response.json());
    if (!response.ok || !parsed.success || !parsed.result) {
      const detail =
        parsed.errors?.map((error) => error.message).join("; ") ||
        `HTTP ${response.status}`;
      throw new Error(`cloudflare: session allocation failed (${detail})`);
    }
    const { sessionId } = parsed.result;
    const webSocketUrl =
      parsed.result.webSocketDebuggerUrl ??
      `${this.baseUrl.replace(/^http/u, "ws")}/devtools/browser/${sessionId}`;
    return { sessionId, webSocketUrl };
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.fetchImpl(
      `${this.baseUrl}/devtools/browser/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", headers: this.headers() },
    ).catch(() => {});
  }
}
