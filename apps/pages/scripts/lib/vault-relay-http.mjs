/**
 * Relay HTTP harness for ADR 0181.
 *
 * The in-process routes match `crates/gateway/src/vault_relay`: health,
 * snapshot compare-and-set, and the org-vault directory. Host routes are
 * absent. `/join.html` is the page two browser contexts use to join one
 * session. The snapshot this page publishes has no item name.
 *
 * `startVaultRelay({ live: true })` does not use that process. It spawns
 * `opensesame host run --profile relay` when one is not already named by
 * `OPENSESAME_RELAY_URL`, and serves the join page beside it.
 */

import { startRelayHarness } from "./vault-relay-harness.mjs";
import { startLiveRelay } from "./vault-relay-live.mjs";

export { createRelayHandler } from "./vault-relay-harness.mjs";
export { startLiveRelay } from "./vault-relay-live.mjs";
export { startRelayHarness } from "./vault-relay-harness.mjs";

/**
 * Listen on loopback. `live: true` spawns the gateway relay profile.
 * The default is the in-process harness. The journeys-1 shard passes
 * `live: true`.
 */
export function startVaultRelay(options = {}) {
  if (options.live) return startLiveRelay();
  return startRelayHarness();
}
