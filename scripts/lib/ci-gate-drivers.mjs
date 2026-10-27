// --- the driver scripts of apps/pages/scripts -----------------------------

// Each `verify-*.mjs` and the gate whose shard or job runs it. A driver that
// no CI job runs is `null`: changing it starts nothing. The contract test
// fails on a driver missing from this table, so a new one forces a decision.
export const DRIVER_GATES = {
  "verify-keyboard.mjs": ["keyboard"],
  "verify-kdbx-native-dom.mjs": ["customer-crypto"],
  "verify-siop.mjs": ["keyboard"],
  "verify-mobile.mjs": ["mobile"],
  "verify-header-layout.mjs": ["mobile"],
  "verify-local-iam.mjs": ["sign-in"],
  "verify-quorum-browser.mjs": ["sign-in"],
  "verify-static-origin.mjs": ["static"],
  "verify-encrypted-search.mjs": ["static"],
  "verify-portable-drop.mjs": ["static"],
  "verify-auth-flow.mjs": ["auth"],
  "verify-trusted-unlock.mjs": ["auth"],
  "verify-experience-journeys.mjs": ["journeys"],
  "verify-webmcp.mjs": ["budgets"],
  "verify-push-worker.mjs": ["budgets"],
  // P8-6: a dirty edit holds a service-worker release reload.
  "verify-sw-dirty-edit.mjs": ["budgets"],
  "verify-capability-graph.mjs": ["budgets"],
  "verify-schema-csp.mjs": ["budgets"],
  "verify-self-hosted-connectors.mjs": ["budgets"],
  "verify-native-connectors-journey.mjs": ["native-connectors"],
  "verify-native-public-protocol.mjs": ["native-public-protocol"],
  "verify-origin-app.mjs": ["native-public-protocol"],
  "verify-provider-auth.mjs": ["native-public-protocol"],
  "verify-identity-connections.mjs": ["native-public-protocol"],
  "verify-secret-backends.mjs": ["native-public-backends"],
  "verify-github-app-browser.mjs": ["native-public-backends"],
  // Separate jobs use the bundle changed area and report through Bundle budgets.
  "verify-ai-connections.mjs": ["budgets"],
  "verify-tailnet-browser-node.mjs": ["budgets"],
  "verify-tailscale-provisioning.mjs": ["budgets"],
  "verify-device-identity.mjs": ["device-identity"],
  "verify-device-inbox.mjs": ["device-inbox"],
  "verify-tutorials.mjs": ["tutorials"],
  "verify-tutorials-profiles.mjs": ["tutorials"],
  "verify-push.mjs": ["push"],
  // ADR 0150: every walk, every ordered pair of browsers, three shards.
  "verify-live-join.mjs": ["live-join"],
  // The contract suite's vitest blocks run in the TypeScript job; its browser
  // half is the gates above.
  "verify-experience.mjs": null,
  // Password parity has its own workflow and is not a ci.yml shard.
  "verify-password-agent.mjs": null,
  // Not run by any job of ci.yml.
  "verify-access-pathbar.mjs": null,
  "verify-ambient-sso.mjs": null,
  "verify-browser-cert.mjs": null,
  "verify-browser-session-lifecycle.mjs": null,
  "verify-browser-sessions.mjs": null,
  "verify-duress-browser.mjs": null,
  "verify-duress-offline.mjs": null,
  "verify-duress.mjs": null,
  // Same-machine direct join: two contexts, no ICE servers (journeys-2).
  "verify-live-local-pair.mjs": ["journeys"],
  // Peer-trust peering: two contexts, SAS, verified join, crossed signal,
  // changed key, duplicate names (journeys-2).
  "verify-peer-trust-two-context.mjs": ["journeys"],
  // P8-3: ICE diagnostics line on joiner while connecting (journeys-2).
  "verify-peering-diagnostics.mjs": ["journeys"],
  "verify-peering-diagnostic-observation.mjs": ["journeys"],
  // P8-4: fresh-vault Passwords onboarding and a saved account (journeys-2).
  "verify-fresh-vault-login.mjs": ["journeys"],
  // P8-5: CLI pairing on the public static site (journeys-2).
  "verify-cli-public-site.mjs": ["journeys"],
  // ADR 0181: the journeys shard runs the relay join walk.
  "verify-relay-join.mjs": ["journeys"],
  "verify-relay-join-live.mjs": ["journeys"],
  "verify-live-netns.mjs": null,
  "verify-mutations.mjs": null,
  "verify-tailnet-devices.mjs": null,
  "verify-tailnet-sync.mjs": null,
  "verify-transport.mjs": null,
};
