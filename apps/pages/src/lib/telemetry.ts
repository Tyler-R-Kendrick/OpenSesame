import { createTelemetry } from "@opensesame/telemetry";
import posthog from "posthog-js";

/**
 * Fully opt-in, privacy-bounded analytics for the installable pages shell.
 *
 * `import.meta.env.VITE_OPENSESAME_TELEMETRY_KEY` is a *build-time* value —
 * Vite inlines `import.meta.env.*` when it bundles, so this decision is baked
 * into the shipped app, not toggled at runtime. Leave it unset and this
 * module is a documented no-op end to end:
 *   - `posthog.init()` below is simply never called. `posthog-js` does not
 *     send anything, start any timer, or write any storage on its own merely
 *     by being imported — it is inert until `init()` runs — so an unset key
 *     means zero network traffic and zero storage writes from this module.
 *   - The `capture` passed to `createTelemetry` below checks `initialized`
 *     before calling `posthog.capture(...)`, so even a stray `track()` call
 *     elsewhere in the app resolves to nothing.
 *   - `createTelemetry`'s own event/prop allowlist (see
 *     `@opensesame/telemetry`) still runs regardless, so this module is
 *     privacy-bounded even when a key *is* configured.
 *
 * See docs/operators/posthog-setup.md for configuring a key.
 */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const telemetryKey = import.meta.env.VITE_OPENSESAME_TELEMETRY_KEY;
const telemetryHost =
  import.meta.env.VITE_OPENSESAME_TELEMETRY_HOST || DEFAULT_POSTHOG_HOST;

let initialized = false;

if (telemetryKey) {
  posthog.init(telemetryKey, {
    api_host: telemetryHost,
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    persistence: "memory",
  });
  initialized = true;
}

const telemetry = createTelemetry({
  capture(event, props) {
    if (!initialized) return;
    // Anonymous only: posthog-js assigns its own anonymous distinct_id on
    // init. This module never calls posthog.identify(), so an event is never
    // tied to a real person, account, or durable identity.
    posthog.capture(event, props);
  },
});

/**
 * Track a privacy-bounded product event. Unknown events and non-allowlisted
 * or sensitive-looking props are dropped by `@opensesame/telemetry` before
 * they ever reach `capture`; see that package for the exact allowlist.
 */
export const track = telemetry.track;
