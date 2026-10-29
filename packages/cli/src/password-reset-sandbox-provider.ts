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
 * the claim token / identity assertion are kept in a `0600` state file
 * beside the reset config and reloaded on the next invocation. It is
 * never printed and never written to the config or journal.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BoatProviderState,
  BoatSandboxProvider,
  CloudflareSandboxProvider,
  LocalSandboxProvider,
  type SandboxProvider,
  type SandboxProviderId,
  WasmRelayProvider,
  type WasmRelayProviderOptions,
} from "@opensesame/agent-sandboxes";
import { z } from "zod";

export type SandboxProviderFactory = (id: SandboxProviderId) => SandboxProvider;

const boatStateSchema = z
  .object({
    claimToken: z.string().min(1).optional(),
    identityAssertion: z.string().min(1).optional(),
  })
  .strict();

const BOAT_STATE_FILE = ".boat-agent-state.json";

export function loadBoatProviderState(directory: string): BoatProviderState {
  const path = join(directory, BOAT_STATE_FILE);
  if (!existsSync(path)) return {};
  const parsed = boatStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const state: BoatProviderState = {};
  if (parsed.claimToken) state.claimToken = parsed.claimToken;
  if (parsed.identityAssertion)
    state.identityAssertion = parsed.identityAssertion;
  return state;
}

export function saveBoatProviderState(
  directory: string,
  state: BoatProviderState,
): void {
  writeFileSync(join(directory, BOAT_STATE_FILE), JSON.stringify(state), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function createSandboxProvider(
  id: SandboxProviderId,
  directory?: string,
): SandboxProvider {
  switch (id) {
    case "local":
      return new LocalSandboxProvider();
    case "boat":
      return new BoatSandboxProvider(
        directory
          ? {
              state: loadBoatProviderState(directory),
              onStateChange: (state) => saveBoatProviderState(directory, state),
            }
          : {},
      );
    case "cloudflare":
      return new CloudflareSandboxProvider();
    case "wasm-relay": {
      const options: WasmRelayProviderOptions = {};
      const relayUrl = process.env.OPENSESAME_VNET_RELAY_URL;
      const relayToken = process.env.OPENSESAME_VNET_RELAY_TOKEN;
      if (relayUrl) options.relayUrl = relayUrl;
      if (relayToken) options.relayToken = relayToken;
      return new WasmRelayProvider(options);
    }
  }
}
