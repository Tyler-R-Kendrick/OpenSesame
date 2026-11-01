/**
 * Maps the configured sandbox provider id to its implementation.
 *
 * Provider credentials are environment-only and read by the providers at
 * allocation time (`BOAT_*`, `CLOUDFLARE_*`); they never enter the reset
 * config file. The WASM lane's virtual-network relay is named by
 * `OPENSESAME_VNET_RELAY_URL` / `OPENSESAME_VNET_RELAY_TOKEN`.
 *
 * Boat registration state is the one credential the CLI itself persists:
 * the claim ceremony spans processes (the run stops for a person), so
 * the claim token / identity assertion are kept in a plaintext `0600` state file
 * beside the reset config and reloaded on the next invocation. It is
 * never printed and never written to the config or journal. Cloudflare
 * temporary-account credentials get the same treatment so the claim
 * link survives until the operator claims the account.
 */

import { realpathSync } from "node:fs";
import {
  BoatSandboxProvider,
  type CloudflareProviderOptions,
  CloudflareSandboxProvider,
  LocalSandboxProvider,
  type SandboxProvider,
  type SandboxProviderId,
  VercelAnonProvider,
  WasmRelayProvider,
  type WasmRelayProviderOptions,
} from "@opensesame/agent-sandboxes";
import {
  acquireBoatStateLock,
  loadBoatProviderState,
  saveBoatProviderState,
} from "./boat-provider-state.js";
export {
  loadBoatProviderState,
  saveBoatProviderState,
} from "./boat-provider-state.js";
import {
  loadCloudflareTemporaryAccount,
  saveCloudflareTemporaryAccount,
} from "./cloudflare-provider-state.js";
export {
  loadCloudflareTemporaryAccount,
  saveCloudflareTemporaryAccount,
} from "./cloudflare-provider-state.js";

export type SandboxProviderFactory = (id: SandboxProviderId) => SandboxProvider;

// Keep only providers with an unsaved rotated state across same-process retries.
const pendingBoatProviders = new Map<string, SandboxProvider>();

export function createSandboxProvider(
  id: SandboxProviderId,
  directory?: string,
): SandboxProvider {
  switch (id) {
    case "local":
      return new LocalSandboxProvider();
    case "boat": {
      if (!directory) return new BoatSandboxProvider();
      const stateDirectory = realpathSync(directory);
      const pending = pendingBoatProviders.get(stateDirectory);
      if (pending) return pending;
      let provider: BoatSandboxProvider | undefined;
      let releaseLock: (() => void) | undefined;
      let busy = false;
      const wrapper: SandboxProvider = {
        id: "boat",
        allocate: async (request) => {
          if (busy)
            throw new Error("Boat state allocation is already in progress");
          busy = true;
          try {
            releaseLock ??= acquireBoatStateLock(stateDirectory);
            provider ??= new BoatSandboxProvider({
              state: loadBoatProviderState(stateDirectory),
              onStateChange: (state) =>
                saveBoatProviderState(stateDirectory, state),
            });
            return await provider.allocate(request);
          } finally {
            busy = false;
            if (!provider?.hasUnpersistedState()) {
              const release = releaseLock;
              releaseLock = undefined;
              provider = undefined;
              release?.();
              if (pendingBoatProviders.get(stateDirectory) === wrapper)
                pendingBoatProviders.delete(stateDirectory);
            }
          }
        },
      };
      pendingBoatProviders.set(stateDirectory, wrapper);
      return wrapper;
    }
    case "cloudflare": {
      if (!directory) return new CloudflareSandboxProvider();
      const stateDirectory = realpathSync(directory);
      const providerOptions: CloudflareProviderOptions = {
        onTemporaryAccount: (account) =>
          saveCloudflareTemporaryAccount(stateDirectory, account),
      };
      const temporaryAccount = loadCloudflareTemporaryAccount(stateDirectory);
      if (temporaryAccount) providerOptions.temporaryAccount = temporaryAccount;
      return new CloudflareSandboxProvider(providerOptions);
    }
    case "vercel":
      // Zero-config: deploy an anonymous Vercel relay per run
      // (temporary project; no signup and no claim).
      return new VercelAnonProvider();
    case "wasm-relay": {
      const options: WasmRelayProviderOptions = {};
      const relayUrl = process.env.OPENSESAME_VNET_RELAY_URL;
      const relayToken = process.env.OPENSESAME_VNET_RELAY_TOKEN;
      if (relayUrl) options.relayUrl = relayUrl;
      if (relayToken) options.relayToken = relayToken;
      // Zero-config: deploy an anonymous Cloudflare relay per run
      // (temporary account; no signup and no claim).
      if (!relayUrl) options.anonymousCloudflare = true;
      return new WasmRelayProvider(options);
    }
  }
}
