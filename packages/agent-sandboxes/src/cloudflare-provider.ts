/**
 * Cloudflare Browser Run provider: one REST allocation per run, then the
 * shared CDP driver over the session socket; sessions are deleted when
 * the run closes.
 *
 * With no account configured, allocation provisions a temporary
 * Cloudflare account instead (see `cloudflare-provisioning.ts`).
 * Temporary credentials cannot call Browser Run, so the first allocation
 * surfaces the account claim URL as a `SandboxClaimRequiredError`; once
 * the operator claims the account and supplies a normal API token,
 * later allocations use it directly.
 */

import type { CdpConnection } from "./cdp-connection.js";
import { CdpBrowserDriver, type CdpDriverOptions } from "./cdp-driver.js";
import { connectCdp } from "./cdp-node-socket.js";
import {
  CloudflareBrowserRunClient,
  type CloudflareClientOptions,
  CloudflareSessionAllocationError,
  CloudflareSessionCleanupError,
} from "./cloudflare-client.js";
import {
  type CloudflareProvisioningOptions,
  type CloudflareTemporaryAccount,
  provisionCloudflareTemporaryAccount,
} from "./cloudflare-provisioning.js";
import {
  type AllocatedSandbox,
  type SandboxAllocationRequest,
  SandboxClaimRequiredError,
  type SandboxProvider,
  allowedDomainsFor,
} from "./types.js";

export interface CloudflareProviderOptions
  extends Partial<CloudflareClientOptions> {
  /** Prebuilt client (tests); otherwise built from options/environment. */
  client?: CloudflareBrowserRunClient;
  loadTimeoutMs?: number;
  /** Temporary account provisioned by an earlier allocation. */
  temporaryAccount?: CloudflareTemporaryAccount;
  /** Called with fresh temporary credentials, to persist them sealed. */
  onTemporaryAccount?: (
    account: CloudflareTemporaryAccount,
  ) => void | Promise<void>;
  /** Provisioning seam (tests); defaults to the real previews API. */
  provisionTemporaryAccount?: () => Promise<CloudflareTemporaryAccount>;
  /** Set false to require configured credentials instead of provisioning. */
  allowTemporaryProvisioning?: boolean;
}

interface ResolvedClient {
  client: CloudflareBrowserRunClient;
  /** Claim URL to surface when temporary credentials are rejected. */
  claimUrl?: string;
}

function clientWithCredentials(
  options: CloudflareProviderOptions,
  accountId: string,
  apiToken: string,
): CloudflareBrowserRunClient {
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

function usableTemporaryAccount(
  options: CloudflareProviderOptions,
): CloudflareTemporaryAccount | undefined {
  const account = options.temporaryAccount;
  if (!account) return undefined;
  const expires = Date.parse(account.accountExpiresAt);
  return Number.isFinite(expires) && expires > Date.now() ? account : undefined;
}

async function resolveClient(
  options: CloudflareProviderOptions,
): Promise<ResolvedClient> {
  if ("sessionTimeoutMs" in options)
    throw new Error("cloudflare: sessionTimeoutMs is unsupported");
  if (options.client) return { client: options.client };
  const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken =
    options.apiToken ??
    process.env.CLOUDFLARE_API_TOKEN ??
    process.env.BROWSER_RUN_API_TOKEN;
  if (accountId && apiToken)
    return { client: clientWithCredentials(options, accountId, apiToken) };
  if (options.allowTemporaryProvisioning === false)
    return {
      client: clientWithCredentials(options, accountId ?? "", apiToken ?? ""),
    };
  const persisted = usableTemporaryAccount(options);
  const provision =
    options.provisionTemporaryAccount ??
    (() => {
      const provisioning: CloudflareProvisioningOptions = {};
      if (options.fetchImpl) provisioning.fetchImpl = options.fetchImpl;
      if (options.allowInsecureLoopbackForTesting !== undefined)
        provisioning.allowInsecureLoopbackForTesting =
          options.allowInsecureLoopbackForTesting;
      return provisionCloudflareTemporaryAccount(provisioning);
    });
  const temporary = persisted ?? (await provision());
  if (!persisted) await options.onTemporaryAccount?.(temporary);
  return {
    client: clientWithCredentials(
      options,
      temporary.accountId,
      temporary.apiToken,
    ),
    claimUrl: temporary.claimUrl,
  };
}

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly id = "cloudflare" as const;

  constructor(private readonly options: CloudflareProviderOptions = {}) {}

  async allocate(request: SandboxAllocationRequest): Promise<AllocatedSandbox> {
    const { allowedDomains } = allowedDomainsFor(request);
    const { client, claimUrl } = await resolveClient(this.options);
    let session;
    try {
      session = await client.createSession(allowedDomains);
    } catch (error) {
      // Temporary preview credentials cannot call Browser Run; the fix
      // is a person claiming the account, not another allocation.
      if (
        claimUrl &&
        error instanceof CloudflareSessionAllocationError &&
        (error.status === 401 || error.status === 403)
      )
        throw new SandboxClaimRequiredError({ verificationUri: claimUrl });
      throw error;
    }
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
