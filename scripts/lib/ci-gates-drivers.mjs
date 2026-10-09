/** The gates the bundle job's shards run, by shard name (`mobile-*` is one). */
export const SHARD_GATES = [
  "budgets",
  "keyboard",
  "sign-in",
  "static",
  "auth",
  "customer-crypto",
  "journeys",
  "mobile",
];
/** The gates that are jobs of their own. */
export const JOB_GATES = [
  "tutorials",
  "device-inbox",
  "device-identity",
  "push",
];
export const ALL_GATES = [...SHARD_GATES, ...JOB_GATES];

/** A shard's gate: `mobile-390` is the `mobile` gate, `journeys-1` the `journeys` one. */
export function gateOfShard(shard) {
  if (shard.startsWith("mobile-")) return "mobile";
  return shard.startsWith("journeys-") ? "journeys" : shard;
}

export const DRIVER_GATES = {
  "verify-keyboard.mjs": ["keyboard"],
  "verify-siop.mjs": ["keyboard"],
  "verify-mobile.mjs": ["mobile"],
  "verify-local-iam.mjs": ["sign-in"],
  "verify-static-origin.mjs": ["static"],
  "verify-encrypted-search.mjs": ["static"],
  "verify-auth-flow.mjs": ["auth"],
  "verify-experience-journeys.mjs": ["journeys"],
  "verify-share-pam.mjs": ["journeys"],
  "verify-webmcp.mjs": ["budgets"],
  "verify-push-worker.mjs": ["budgets"],
  "verify-capability-graph.mjs": ["budgets"],
  "verify-device-identity.mjs": ["device-identity"],
  "verify-device-inbox.mjs": ["device-inbox"],
  "verify-tutorials.mjs": ["tutorials"],
  "verify-tutorials-profiles.mjs": ["tutorials"],
  "verify-push.mjs": ["push"],
  "verify-experience.mjs": null,
  "verify-password-agent.mjs": null,
  "verify-access-pathbar.mjs": null,
  "verify-ambient-sso.mjs": null,
  "verify-browser-cert.mjs": null,
  "verify-browser-session-lifecycle.mjs": null,
  "verify-browser-sessions.mjs": null,
  "verify-duress-browser.mjs": null,
  "verify-duress-offline.mjs": null,
  "verify-duress.mjs": null,
  "verify-live-join.mjs": null,
  "verify-relay-join.mjs": ["journeys"],
  "verify-relay-join-live.mjs": ["journeys"],
  "verify-live-netns.mjs": null,
  "verify-mutations.mjs": null,
  "verify-tailnet-devices.mjs": null,
  "verify-tailnet-sync.mjs": null,
  "verify-transport.mjs": null,
};
