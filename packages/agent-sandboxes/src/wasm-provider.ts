/**
 * WASM lane provider: allocates the DOM-level driver whose entire network
 * is virtualized through a user-controlled relay. The driver itself is
 * host-agnostic TypeScript (Node, browser tab, or WASM host); this
 * provider only binds it to a relay endpoint and session.
 */

import { randomUUID } from "node:crypto";
import { deployAnonymousCloudflareRelay } from "./cloudflare-anon-relay.js";
import {
  type AllocatedSandbox,
  type SandboxAllocationRequest,
  type SandboxProvider,
  type SandboxProviderId,
  allowedDomainsFor,
} from "./types.js";
import { type VirtualFetch, virtualFetchOverHttp } from "./vnet.js";
import { WasmDomDriver } from "./wasm-dom-driver.js";

/** A per-run anonymously deployed relay (no account, no claim). */
export interface AnonymousRelayDeployment {
  relayUrl: string;
  relayToken: string;
  close(): Promise<void>;
}

export interface WasmRelayProviderOptions {
  /** Base URL of the virtual-network relay. */
  relayUrl?: string;
  relayToken?: string;
  /** Inject a virtual fetch directly (tests, in-process relay). */
  virtualFetch?: VirtualFetch;
  /**
   * With no relay configured, deploy an anonymous Cloudflare relay
   * per allocation (temporary account, no signup, no claim).
   */
  anonymousCloudflare?: boolean;
  /**
   * With no relay configured, deploy an anonymous relay per
   * allocation on the named vendor (temporary project/account, no
   * signup, no claim).
   */
  anonymousRelay?: "cloudflare" | "vercel";
  /** Readiness poll budget forwarded to the anonymous deploy. */
  readyTimeoutMs?: number;
  /** Relay deployment seam (tests); defaults to the anonymous deploy. */
  deployRelay?: () => Promise<AnonymousRelayDeployment>;
}

export class WasmRelayProvider implements SandboxProvider {
  readonly id: SandboxProviderId = "wasm-relay";

  constructor(private readonly options: WasmRelayProviderOptions = {}) {}

  async allocate(request: SandboxAllocationRequest): Promise<AllocatedSandbox> {
    const { url, allowedDomains } = allowedDomainsFor(request);
    const session = request.session ?? `wasm-${randomUUID()}`;
    let deployed: AnonymousRelayDeployment | undefined;
    let virtualFetch = this.options.virtualFetch;
    if (!virtualFetch) {
      let relayUrl = this.options.relayUrl;
      let relayToken = this.options.relayToken;
      const anonymousVendor =
        this.options.anonymousRelay ??
        (this.options.anonymousCloudflare ? "cloudflare" : undefined);
      if ((!relayUrl || !relayToken) && anonymousVendor) {
        deployed = await (this.options.deployRelay?.() ??
          (anonymousVendor === "vercel"
            ? (await import("./vercel-anon-relay.js")).deployAnonymousVercelRelay(
                this.options.readyTimeoutMs !== undefined
                  ? { readyTimeoutMs: this.options.readyTimeoutMs }
                  : {},
              )
            : deployAnonymousCloudflareRelay(
                this.options.readyTimeoutMs !== undefined
                  ? { readyTimeoutMs: this.options.readyTimeoutMs }
                  : {},
              )));
        relayUrl = deployed.relayUrl;
        relayToken = deployed.relayToken;
      }
      if (!relayUrl || !relayToken) {
        await deployed?.close().catch(() => {});
        throw new Error(
          "wasm-relay provider needs a relay URL and token (or an injected virtual fetch)",
        );
      }
      virtualFetch = virtualFetchOverHttp(relayUrl, relayToken);
    }
    const allowedOrigins = [
      ...new Set([
        url.origin,
        ...allowedDomains
          .filter((domain) => domain !== url.hostname)
          .map((domain) => `https://${domain}`),
      ]),
    ];
    const boundFetch = virtualFetch;
    const browser = new WasmDomDriver({
      virtualFetch: (input) => boundFetch({ ...input, allowedOrigins }),
      sessionId: session,
      allowedDomains,
    });
    return {
      provider: this.id,
      session,
      browser,
      allowedDomains,
      close: async () => {
        try {
          await browser.close();
        } finally {
          try {
            // Deleting the per-run deployment supersedes its session.
            if (deployed) await boundFetch.closeSession?.(session).catch(() => {});
            else await boundFetch.closeSession?.(session);
          } finally {
            await deployed?.close().catch(() => {});
          }
        }
      },
    };
  }
}
