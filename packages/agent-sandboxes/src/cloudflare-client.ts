/**
 * Browser Run REST session client.
 * https://developers.cloudflare.com/browser-run/cdp/session-management/
 * https://developers.cloudflare.com/browser-run/features/guardrails/
 */
import { z } from "zod";

export interface CloudflareClientOptions {
  accountId: string;
  apiToken: string;
  /** Defaults to the public Cloudflare API. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Explicit test-only opt-in for a local fake API and CDP socket. */
  allowInsecureLoopbackForTesting?: boolean;
  /** Browser Run's keep_alive query parameter, in milliseconds. */
  keepAliveMs?: number;
}

export interface CloudflareSession {
  sessionId: string;
  webSocketUrl: string;
}

export class CloudflareSessionAllocationError extends Error {
  constructor(readonly status: number) {
    super(`cloudflare: session allocation failed (HTTP ${status})`);
    this.name = "CloudflareSessionAllocationError";
  }
}

export class CloudflareSessionCleanupError extends Error {
  constructor(
    readonly sessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareSessionCleanupError";
  }
}

const sessionResponseSchema = z.object({
  sessionId: z.string(),
  webSocketDebuggerUrl: z.string().optional(),
});

const identifier = /^[A-Za-z0-9_-]{1,128}$/u;
const hostname =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u;
const guardrailHostnamesSchema = z
  .array(z.string().regex(hostname))
  .min(1)
  .max(50);

function validateOptions(options: CloudflareClientOptions): void {
  if (!options.accountId || !options.apiToken)
    throw new Error(
      "cloudflare provider needs an account id and API token (environment)",
    );
  if (!identifier.test(options.accountId))
    throw new Error("cloudflare: invalid account id");
  if ("sessionTimeoutMs" in options)
    throw new Error("cloudflare: sessionTimeoutMs is unsupported");
  if (!/^[A-Za-z0-9._~+/-]+=*$/u.test(options.apiToken))
    throw new Error("cloudflare: invalid API token");
  if (
    options.keepAliveMs !== undefined &&
    (!Number.isInteger(options.keepAliveMs) ||
      options.keepAliveMs < 10_000 ||
      options.keepAliveMs > 1_200_000)
  )
    throw new Error("cloudflare: invalid keep_alive");
}

function providerBaseUrl(options: CloudflareClientOptions): string {
  const expectedPath = `/client/v4/accounts/${options.accountId}/browser-run`;
  let base: URL;
  try {
    base = new URL(
      options.baseUrl ?? `https://api.cloudflare.com${expectedPath}`,
    );
  } catch {
    throw new Error("cloudflare: untrusted API endpoint");
  }
  const production =
    base.protocol === "https:" &&
    base.hostname === "api.cloudflare.com" &&
    !base.port &&
    base.pathname.replace(/\/$/u, "") === expectedPath;
  const testLoopback =
    options.allowInsecureLoopbackForTesting === true &&
    base.protocol === "http:" &&
    base.hostname === "127.0.0.1";
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !(production || testLoopback)
  )
    throw new Error("cloudflare: untrusted API endpoint");
  return base.href.replace(/\/$/u, "");
}

export class CloudflareBrowserRunClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiToken: string;
  private readonly keepAliveMs: number | undefined;

  constructor(options: CloudflareClientOptions) {
    validateOptions(options);
    this.baseUrl = providerBaseUrl(options);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiToken = options.apiToken;
    this.keepAliveMs = options.keepAliveMs;
  }

  private headers() {
    return {
      authorization: `Bearer ${this.apiToken}`,
      "content-type": "application/json",
    };
  }

  cdpHeaders() {
    return { authorization: `Bearer ${this.apiToken}` };
  }

  async createSession(
    allowedDomains: readonly string[],
  ): Promise<CloudflareSession> {
    const parsedDomains = guardrailHostnamesSchema.safeParse(allowedDomains);
    if (!parsedDomains.success)
      throw new Error("cloudflare: invalid guardrail hostnames");
    const endpoint = new URL(`${this.baseUrl}/devtools/browser`);
    if (this.keepAliveMs !== undefined)
      endpoint.searchParams.set("keep_alive", String(this.keepAliveMs));
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.href, {
        method: "POST",
        redirect: "error",
        headers: this.headers(),
        body: JSON.stringify({
          guardrails: { allowedDomains: parsedDomains.data },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("cloudflare: session allocation request failed");
    }
    if (!response.ok)
      throw new CloudflareSessionAllocationError(response.status);
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error("cloudflare: invalid session response");
    }
    const idResult = z.object({ sessionId: z.string() }).safeParse(raw);
    if (!idResult.success)
      throw new Error("cloudflare: invalid session response");
    const { sessionId } = idResult.data;
    if (!identifier.test(sessionId))
      throw new Error("cloudflare: invalid session id");
    const result = sessionResponseSchema.safeParse(raw);
    if (!result.success)
      return this.rejectSession(sessionId, "invalid session response");
    const parsed = result.data;
    const expected = `${this.baseUrl.replace(/^http/u, "ws")}/devtools/browser/${sessionId}`;
    const webSocketUrl = parsed.webSocketDebuggerUrl ?? expected;
    if (webSocketUrl !== expected) {
      return this.rejectSession(sessionId, "untrusted CDP endpoint");
    }
    return { sessionId, webSocketUrl };
  }

  private async rejectSession(
    sessionId: string,
    reason: string,
  ): Promise<never> {
    try {
      await this.closeSession(sessionId);
    } catch {
      throw new CloudflareSessionCleanupError(
        sessionId,
        `cloudflare: ${reason}; session cleanup failed`,
      );
    }
    throw new Error(`cloudflare: ${reason}`);
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!identifier.test(sessionId))
      throw new Error("cloudflare: invalid session id");
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/devtools/browser/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          redirect: "error",
          headers: this.headers(),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new CloudflareSessionCleanupError(
        sessionId,
        "cloudflare: session cleanup request failed",
      );
    }
    if (!response.ok)
      throw new CloudflareSessionCleanupError(
        sessionId,
        `cloudflare: session cleanup failed (HTTP ${response.status})`,
      );
  }
}
