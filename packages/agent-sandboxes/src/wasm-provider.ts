/**
 * WASM lane provider: allocates the DOM-level driver whose entire network
 * is virtualized through a user-controlled relay. The driver itself is
 * host-agnostic TypeScript (Node, browser tab, or WASM host); this
 * provider only binds it to a relay endpoint and session.
 */

import { randomUUID } from "node:crypto";
import {
  type AllocatedSandbox,
  type SandboxAllocationRequest,
  type SandboxProvider,
  allowedDomainsFor,
} from "./types.js";
import { type VirtualFetch, virtualFetchOverHttp } from "./vnet.js";
import { WasmDomDriver } from "./wasm-dom-driver.js";

export interface WasmRelayProviderOptions {
  /** Base URL of the virtual-network relay. */
  relayUrl?: string;
  relayToken?: string;
  /** Inject a virtual fetch directly (tests, in-process relay). */
  virtualFetch?: VirtualFetch;
}

export class WasmRelayProvider implements SandboxProvider {
  readonly id = "wasm-relay" as const;

  constructor(private readonly options: WasmRelayProviderOptions = {}) {}

  async allocate(request: SandboxAllocationRequest): Promise<AllocatedSandbox> {
    const { url, allowedDomains } = allowedDomainsFor(request);
    const session = request.session ?? `wasm-${randomUUID()}`;
    let virtualFetch = this.options.virtualFetch;
    if (!virtualFetch) {
      if (!this.options.relayUrl || !this.options.relayToken)
        throw new Error(
          "wasm-relay provider needs a relay URL and token (or an injected virtual fetch)",
        );
      virtualFetch = virtualFetchOverHttp(
        this.options.relayUrl,
        this.options.relayToken,
      );
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
          await boundFetch.closeSession?.(session);
        }
      },
    };
  }
}
