/**
 * Paths whose change has to run the relay-join walk (the journeys shard).
 * A gateway `vault_relay` file is not in the Pages bundle area; `selectGates`
 * still counts it so the walk runs when the relay process changes.
 */
export function relayJoinPath(path) {
  if (relayProcessGate(path)) return true;
  if (path.startsWith("apps/pages/scripts/lib/vault-relay")) return true;
  if (
    path === "apps/pages/scripts/verify-relay-join.mjs" ||
    path === "apps/pages/scripts/verify-relay-join-live.mjs" ||
    path === "apps/pages/scripts/verify-live-local-pair.mjs"
  ) {
    return true;
  }
  if (path.startsWith("apps/pages/src/modules/sharing.relay/")) return true;
  return (
    path.startsWith("apps/pages/") &&
    path.includes("relay") &&
    path.includes("join")
  );
}

/** The relay process itself. Pages files keep their own bundle rules. */
export function relayProcessGate(path) {
  return path.startsWith("crates/gateway/") && path.includes("vault_relay");
}
