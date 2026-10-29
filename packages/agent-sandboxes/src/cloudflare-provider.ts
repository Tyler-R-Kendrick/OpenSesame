/**
 * Cloudflare Browser Run provider: one REST allocation per run, then the
 * shared CDP driver over the session socket. No per-run provisioning
 * beyond the account token in configuration; sessions are deleted when
 * the run closes.
 */

import type { CdpConnection } from "./cdp-connection.js";
import { CdpBrowserDriver, type CdpDriverOptions } from "./cdp-driver.js";
import { connectCdp } from "./cdp-node-socket.js";
import {
  CloudflareBrowserRunClient,
  type CloudflareClientOptions,
  CloudflareSessionCleanupError,
} from "./cloudflare-client.js";
import {
  type AllocatedSandbox,
  type SandboxAllocationRequest,
  type SandboxProvider,
  allowedDomainsFor,
} from "./types.js";

export interface CloudflareProviderOptions
  extends Partial<CloudflareClientOptions> {
  /** Prebuilt client (tests); otherwise built from options/environment. */
  client?: CloudflareBrowserRunClient;
  loadTimeoutMs?: number;
}

function clientFrom(options: CloudflareProviderOptions) {
  if ("sessionTimeoutMs" in options)
    throw new Error("cloudflare: sessionTimeoutMs is unsupported");
  if (options.client) return options.client;
  const accountId =
    options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken =
    options.apiToken ??
    process.env.CLOUDFLARE_API_TOKEN ??
    process.env.BROWSER_RUN_API_TOKEN ??
    "";
  const clientOptions: CloudflareClientOptions = { accountId, apiToken };
  if (options.baseUrl) clientOptions.baseUrl = options.baseUrl;
  if (options.fetchImpl) clientOptions.fetchImpl = options.fetchImpl;
  if (options.allowInsecureLoopbackForTesting !== undefined)
    clientOptions.allowInsecureLoopbackForTesting =
      options.allowInsecureLoopbackForTesting;
  if (options.keepAliveMs !== undefined)
    clientOptions.keepAliveMs = options.keepAliveMs;
  return new CloudflareBrowserRunClient(clientOptions);
}

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly id = "cloudflare" as const;

  constructor(private readonly options: CloudflareProviderOptions = {}) {}

  async allocate(request: SandboxAllocationRequest): Promise<AllocatedSandbox> {
    const { allowedDomains } = allowedDomainsFor(request);
    const client = clientFrom(this.options);
    const session = await client.createSession(allowedDomains);
    let connection: CdpConnection | undefined;
    try {
      connection = await connectCdp(session.webSocketUrl, {
        headers: client.cdpHeaders(),
      });
      const driverOptions: CdpDriverOptions = { allowedDomains };
      if (this.options.loadTimeoutMs !== undefined)
        driverOptions.loadTimeoutMs = this.options.loadTimeoutMs;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const browser = await Promise.race([
        CdpBrowserDriver.connect(connection, driverOptions),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("cloudflare: browser initialization timed out")),
            15_000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      return {
        provider: this.id,
        session: session.sessionId,
        browser,
        allowedDomains,
        close: async () => {
          try {
            await browser.close();
          } finally {
            await client.closeSession(session.sessionId);
          }
        },
      };
    } catch (error) {
      try {
        connection?.close();
      } catch {
        // Attempt remote cleanup even if closing the local socket fails.
      }
      try {
        await client.closeSession(session.sessionId);
      } catch {
        throw new CloudflareSessionCleanupError(
          session.sessionId,
          "cloudflare: browser connection and session cleanup failed",
        );
      }
      throw error;
    }
  }
}
