// Each `verify-*.mjs` and the gate whose shard or job runs it. A driver that
// no CI job runs is `null`: changing it starts nothing. The contract test
// fails on a driver missing from this table, so a new one forces a decision.
export const DRIVER_GATES = {
  "verify-keyboard.mjs": ["keyboard"],
  "verify-retired-credentials.mjs": ["auth"],
  "verify-controlled-security.mjs": ["auth"],
  "verify-siop.mjs": ["keyboard"],
  "verify-mobile.mjs": ["mobile"],
  "verify-local-iam.mjs": ["sign-in"],
  "verify-static-origin.mjs": ["static"],
  "verify-encrypted-search.mjs": ["static"],
  "verify-auth-flow.mjs": ["auth"],
  "verify-experience-journeys.mjs": ["journeys"],
  "verify-webmcp.mjs": ["budgets"],
  "verify-push-worker.mjs": ["budgets"],
  "verify-capability-graph.mjs": ["budgets"],
  "verify-device-identity.mjs": ["device-identity"],
  "verify-device-inbox.mjs": ["device-inbox"],
  "verify-tutorials.mjs": ["tutorials"],
  "verify-push.mjs": ["push"],
  // The contract suite's vitest blocks run in the TypeScript job; its browser
  // half is the gates above.
  "verify-experience.mjs": null,
  // Not run by any job of ci.yml.
  "verify-access-pathbar.mjs": null,
  "verify-ambient-sso.mjs": null,
  "verify-browser-cert.mjs": null,
  "verify-browser-session-lifecycle.mjs": null,
  "verify-browser-sessions.mjs": null,
  "verify-duress-browser.mjs": ["duress"],
  "verify-duress-offline.mjs": null,
  "verify-duress.mjs": null,
  "verify-live-join.mjs": ["live-transports"],
  "verify-live-netns.mjs": null,
  "verify-mutations.mjs": null,
  "verify-tailnet-devices.mjs": null,
  "verify-tailnet-sync.mjs": null,
  "verify-transport.mjs": null,
};
