/**
 * Optional import() leaves the capability partition carves out of Rollup's own
 * chunking, one chunk each (`capability-compose-plugin.mjs`).
 */

const toPosix = (path) => path.replace(/\\/g, "/");

const ONEPASSWORD_SOURCE =
  /\/packages\/app-core\/src\/lib\/secret-backends\/onepassword-(?:sdk(?:-[a-z0-9-]+|\.worker)?|worker-[a-z0-9-]+)\.[jt]s$/;

/** Native SDK implementation only; Connect and common configuration keep their ordinary leaf. */
export function secretBackendSdkChunk(id, entry) {
  if (
    entry.classification !== "optional" ||
    entry.capability !== "connectors.external" ||
    id.includes("\0") ||
    id.startsWith("virtual:")
  )
    return undefined;
  const path = toPosix(id).split(/[?#]/, 1)[0];
  return ONEPASSWORD_SOURCE.test(path)
    ? "secret-backend-onepassword-sdk"
    : undefined;
}

/**
 * Optional import() leaves, one chunk each. Rollup otherwise fused the
 * agent SDKs, so loading one evaluated the others. A row applies only
 * when classification matches that capability.
 */
const LAZY_LEAVES = [
  // Certificate issuance stays with its owner when shared RSA container
  // encoding reshapes the surrounding pure chunks.
  [
    "/packages/app-core/src/lib/x509/",
    "vault.certificate-records",
    "cap-vault.certificate-records",
  ],
  [
    "/packages/app-core/src/lib/certs-issue.ts",
    "vault.certificate-records",
    "cap-vault.certificate-records",
  ],
  [
    "/packages/app-core/src/lib/secret-backends/",
    "connectors.external",
    "secret-backends",
  ],
  // The browser Credential Management adapter belongs to the same backend
  // boundary. Otherwise the minimum chunk floor can merge it with NATS crypto.
  [
    "/packages/app-core/src/browser/secret-backend-credentials.ts",
    "connectors.external",
    "secret-backends",
  ],
  [
    "/node_modules/@1password/save-button/",
    "connectors.external",
    "vendor-1password-save",
  ],
  [
    "/src/sections/access/HostedRequestsPanel",
    "access.authority",
    "cap-access.authority",
  ],
  // Mailbox protocol/data leaves are optional password-reset code. Keep
  // their shared helpers with that capability when pure chunks coalesce.
  [
    "/packages/app-core/src/lib/password-reset/",
    "ai.password-reset",
    "cap-ai.password-reset",
  ],
  ["/src/tutorial/agents/prompt-api/", "support.local-ai", "agent-prompt-api"],
  ["/src/tutorial/agents/ag-ui/", "support.remote-ai", "agent-ag-ui"],
  ["/src/tutorial/agents/provider/", "support.remote-ai", "agent-provider"],
  ["/packages/webmcp/src/", "agents.webmcp", "webmcp-sdk"],
  // The SDKs behind the agents, which Rollup fused the same way.
  // The named SDK facade is pure: keep its owned zero-byte module in a lazy entry
  // instead of allowing the minimum chunk floor to merge it into another owner.
  [
    "/packages/app-core/src/lib/command-bar/interpret-generate-object.ts",
    "support.local-ai",
    "local-ai-sdk-entry",
  ],
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
  // The relay's HTTP client (ADR 0181) is a small pure leaf reached only by
  // the org-vault directory panels. At the 12 KB merge floor Rollup folds it
  // into a neighbour whenever the Settings sections reshuffle the chunks
  // around it, and the gate reads the fold as a static import of
  // `sharing.relay` from the bootstrap (ADR 0130 §4). Pinned to the
  // capability's own chunk, it loads with the module and stays off the entry.
  [
    "/packages/app-core/src/lib/vault-relay/client",
    "sharing.relay",
    "cap-sharing.relay",
  ],
  // Document enrolment (`push-browser`, `push-enrolment`, `push-seams`) is
  // pure. `experimentalMinChunkSize` then folds that small chunk into `main`,
  // which the gate reads as a static import of `notifications.web-push`
  // (ADR 0130 §4). The capability chunk is the dynamic entry, so these files
  // load with the module and stay off the bootstrap. `push.ts` is the worker
  // half and is not matched here.
  ["/src/lib/push-", "notifications.web-push", "cap-notifications.web-push"],
  [
    "/src/modules/identity.ceremonies/ClaimDifferentLink",
    "identity.ceremonies",
    "cap-identity.claim-different-link",
  ],
  [
    "/src/modules/identity.local-iam/cli-authorize-panel",
    "identity.local-iam",
    "cli-app-integration-crypto",
  ],
  [
    "/src/modules/identity.local-iam/cli-authorize-pairing-form",
    "identity.local-iam",
    "cli-app-integration-crypto",
  ],
  [
    "/src/modules/identity.local-iam/cli-authorize-paired-panel",
    "identity.local-iam",
    "cli-app-integration-crypto",
  ],
  [
    "/src/modules/identity.local-iam/cli-authorize-mint-proof",
    "identity.local-iam",
    "cli-app-integration-crypto",
  ],
  [
    "/src/modules/identity.local-iam/cli-authorize-panel-model",
    "identity.local-iam",
    "cli-app-integration-crypto",
  ],
  // Device signing, oschip2 formatters, pairing confirm, and vault-session-root
  // (dynamic vault/store) load only with the authorize sheet — one lazy chunk.
  [
    "/packages/app-core/src/lib/cli-app-integration/",
    "identity.local-iam",
    "cli-app-integration-crypto",
  ],
  // The organization settings model is a pure directory leaf. At the 32 KB
  // merge floor Rollup can fold it into main although every value importer
  // is lazy. Keep the model in its own owner chunk without loading the full
  // directory UI when a configured identity connection requests it.
  [
    "/packages/app-core/src/lib/org-signin.ts",
    "enterprise.directory-provisioning",
    "directory-signin-model",
  ],
  // Keep the shared broker binding separate from both its panels and runtime.
  // Folding it into main makes the optional capability statically reachable;
  // folding it into the runtime makes session-connections import that runtime
  // before its own policy and tutorial constants have initialized.
  [
    "/packages/app-core/src/lib/model-keys/active",
    "connectors.external",
    "model-key-state",
  ],
  // Panels call these pure predicates before capability activation. Sharing
  // their chunk with the activation runtime creates the same reverse edge.
  [
    "/src/modules/connectors.external/native-oauth-resource-runtime.ts",
    "connectors.external",
    "native-oauth-resource-runtime",
  ],
];

export function lazyLeafChunk(id, entry) {
  const sdk = secretBackendSdkChunk(id, entry);
  if (sdk) return sdk;
  const path = toPosix(id);
  for (const [dir, capability, name] of LAZY_LEAVES) {
    if (!path.includes(dir)) continue;
    const pinSharedVaultLeaf =
      entry.classification === "shared" &&
      dir.startsWith("/packages/app-core/src/lib/vault/");
    const pinSharedCliAppLeaf =
      entry.classification === "shared" &&
      dir.startsWith("/packages/app-core/src/lib/cli-app-integration/");
    const pinAppCoreCliAppCrypto =
      dir === "/packages/app-core/src/lib/cli-app-integration/";
    if (
      entry.capability === capability ||
      pinSharedVaultLeaf ||
      pinSharedCliAppLeaf ||
      pinAppCoreCliAppCrypto
    )
      return name;
  }
  return undefined;
}
