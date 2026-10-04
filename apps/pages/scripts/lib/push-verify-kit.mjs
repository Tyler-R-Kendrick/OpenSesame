/**
 * What `verify-push.mjs` reports with: named checks, timed steps and the
 * operator policy its last scenario serves.
 */

/** An operator policy whose service origins do not include the Identity API. */
export const OPERATOR_POLICY = {
  schemaVersion: 1,
  kind: "InstanceCapabilityPolicy",
  instanceId: "verify-push",
  revision: "r1",
  presetProvenance: null,
  capabilities: {
    default: "deny",
    required: [],
    optional: ["notifications.web-push", "notifications.routing"],
    prohibited: [],
  },
  network: {
    externalServices: "allow",
    allowedServiceOrigins: ["https://elsewhere.example.test"],
  },
  updates: {
    unknownCapabilities: "deny",
    expandedExposure: "require-approval",
  },
};

/** A run's checks and per-step timings; `finish` prints them and says the exit code. */
export function createRun() {
  const started = Date.now();
  const failures = [];
  const timings = [];
  let lap = started;
  return {
    check(condition, what) {
      console.log(condition ? "PASS" : "FAIL", what);
      if (!condition) failures.push(what);
    },
    step(what) {
      const now = Date.now();
      if (timings.length > 0) timings[timings.length - 1].ms = now - lap;
      lap = now;
      timings.push({ what, ms: 0 });
      console.log(`-- ${what} (${((now - started) / 1000).toFixed(1)}s)`);
    },
    finish(crashed) {
      const now = Date.now();
      if (timings.length > 0) timings[timings.length - 1].ms = now - lap;
      for (const { what, ms } of timings)
        console.log(`   ${(ms / 1000).toFixed(1).padStart(5)}s  ${what}`);
      console.log(`total ${((now - started) / 1000).toFixed(1)}s`);
      if (failures.length > 0)
        console.error(
          `${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
        );
      return crashed || failures.length > 0 ? 1 : 0;
    },
  };
}
