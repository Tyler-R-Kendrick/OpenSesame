/**
 * Cloudflare Browser Run provider: one REST allocation per run, then the
 * shared CDP driver over the session socket. No per-run provisioning
 * beyond the account token in configuration; sessions are deleted when
 * the run closes.
 */

import { CdpBrowserDriver, type CdpDriverOptions } from "./cdp-driver.js";
import { connectCdp } from "./cdp-node-socket.js";
import {
  CloudflareBrowserRunClient,
  type CloudflareClientOptions,
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
  if (options.sessionTimeoutMs !== undefined)
    clientOptions.sessionTimeoutMs = options.sessionTimeoutMs;
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
    const session = await client.createSession();
    try {
      const connection = await connectCdp(session.webSocketUrl, {
        headers: client.cdpHeaders(),
      });
      const driverOptions: CdpDriverOptions = { allowedDomains };
      if (this.options.loadTimeoutMs !== undefined)
        driverOptions.loadTimeoutMs = this.options.loadTimeoutMs;
      const browser = await CdpBrowserDriver.connect(connection, driverOptions);
      return {
        provider: this.id,
        session: session.sessionId,
        browser,
        allowedDomains,
        close: async () => {
          await browser.close();
          await client.closeSession(session.sessionId);
        },
      };
    } catch (error) {
      await client.closeSession(session.sessionId);
      throw error;
    }
  }
}
