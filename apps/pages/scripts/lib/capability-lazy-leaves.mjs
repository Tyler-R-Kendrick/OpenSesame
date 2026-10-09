/**
 * Optional import() leaves the capability partition carves out of Rollup's own
 * chunking, one chunk each (`capability-compose-plugin.mjs`).
 */

const toPosix = (path) => path.replace(/\\/g, "/");

/**
 * Optional import() leaves, one chunk each. Rollup otherwise fused the
 * agent SDKs, so loading one evaluated the others. A row applies only
 * when classification matches that capability.
 */
const LAZY_LEAVES = [
  ["/src/tutorial/agents/prompt-api/", "support.local-ai", "agent-prompt-api"],
  ["/src/tutorial/agents/ag-ui/", "support.remote-ai", "agent-ag-ui"],
  ["/src/tutorial/agents/provider/", "support.remote-ai", "agent-provider"],
  ["/packages/webmcp/src/", "agents.webmcp", "webmcp-sdk"],
  // The SDKs behind the agents, which Rollup fused the same way.
  ["/node_modules/ai/", "support.local-ai", "vendor-ai-sdk"],
  ["/node_modules/@ai-sdk/", "support.local-ai", "vendor-ai-sdk"],
  ["/node_modules/@ag-ui/client/", "support.remote-ai", "vendor-ag-ui"],
  // MSAL, reached only through lib/ambient-auth/entra.ts's import(): Rollup
  // otherwise fused a small Access chunk into it, so one chunk named two
  // capabilities.
  ["/node_modules/@azure/msal-", "identity.ambient-sso", "vendor-msal"],
  // Live sessions' carriers (ADR 0150 §6): each client loads only when a
  // session names its kind, never when the capability activates.
  ["/src/modules/sharing.live/carriers/mqtt", "sharing.live", "live-mqtt"],
  ["/node_modules/mqtt/", "sharing.live", "live-mqtt"],
  ["/src/modules/sharing.live/carriers/nats", "sharing.live", "live-nats"],
  ["/node_modules/@nats-io/", "sharing.live", "live-nats"],
  // A session's minted NATS credential (ADR 0167), reached only through
  // transport.ts's import() when a profile mints: it loads with the client.
  [
    "/packages/app-core/src/lib/live/nats-credentials",
    "sharing.live",
    "live-nats",
  ],
  ["/packages/app-core/src/lib/live/nats-jwt", "sharing.live", "live-nats"],
  [
    "/packages/app-core/src/lib/vault/environments",
    "vault.environments",
    "cap-vault.environments",
  ],
  [
    "/packages/app-core/src/lib/vault/security-checks",
    "vault.security-checks",
    "cap-vault.security-checks",
  ],
  ["/src/modules/sharing.live/carriers/nostr", "sharing.live", "live-nostr"],
  ["/node_modules/nostr-tools/", "sharing.live", "live-nostr"],
  // Plugin pairing is reached by the tailnet sync and device-management
  // runtimes. Its pure shared leaf can fold into the entry at the 12 KB
  // merge floor when record navigation changes the surrounding chunks.
  // Keep the optional pairing parser/store off the bootstrap (ADR 0130 §4).
  [
    "/packages/app-core/src/lib/tailnet-sync/plugin-pairing.ts",
    "networking.tailnet",
    "tailnet-plugin-pairing",
  ],
  // Document enrolment (`push-browser`, `push-enrolment`, `push-seams`) is
  // pure. `experimentalMinChunkSize` then folds that small chunk into `main`,
  // which the gate reads as a static import of `notifications.web-push`
  // (ADR 0130 §4). The capability chunk is the dynamic entry, so these files
  // load with the module and stay off the bootstrap. `push.ts` is the worker
  // half and is not matched here.
  ["/src/lib/push-", "notifications.web-push", "cap-notifications.web-push"],
];

export function lazyLeafChunk(id, entry) {
  const path = toPosix(id);
  for (const [dir, capability, name] of LAZY_LEAVES) {
    if (path.includes(dir) && entry.capability === capability) return name;
  }
  return undefined;
}
