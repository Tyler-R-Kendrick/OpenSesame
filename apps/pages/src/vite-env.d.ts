/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /**
   * PostHog project API key, inlined into the built bundle at build time.
   * Unset (the default) means `src/lib/telemetry.ts` never calls
   * `posthog.init()` and every `track()` call is a documented no-op — see
   * docs/operators/posthog-setup.md.
   */
  readonly VITE_OPENSESAME_TELEMETRY_KEY?: string;
  /** PostHog ingestion host override; defaults to https://us.i.posthog.com. */
  readonly VITE_OPENSESAME_TELEMETRY_HOST?: string;
}
