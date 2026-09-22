/**
 * The host this process runs in (ADR 0133 §2–3).
 *
 * The shared core runs in a browser tab, a CLI process and an Android
 * isolate. What differs between them — storage, navigation, WebAuthn, build
 * configuration — reaches the core through one `Host`, installed once, before
 * any other module does work. Standard web APIs that all three provide
 * (`crypto`, `fetch`, `URL`, timers …) are not ports; they are the runtime
 * contract.
 *
 * A port is read when it is used, never while a module loads, so importing any
 * part of the core with no host installed must not throw.
 */

/**
 * Build-time configuration. In the browser this is Vite's `import.meta.env`;
 * elsewhere the embedding shell supplies the same shape.
 */
export type RuntimeEnv = {
  /** Public base path the app is served under, ending in `/`. */
  readonly BASE_URL: string;
  /** True in development and test builds. */
  readonly DEV: boolean;
  readonly VITE_CONNECT_CALLBACK_BASE?: string;
  readonly VITE_DAEMON_API?: string;
  readonly VITE_HOST_API?: string;
  readonly VITE_IDENTITY_API?: string;
  readonly VITE_MFA_APP_URL?: string;
  readonly VITE_OPENSESAME_CEREMONIES?: string;
  readonly VITE_SUPPORT_AGENT_URL?: string;
};

export type Host = {
  readonly env: RuntimeEnv;
};

/**
 * One host per process, so it lives on the global object: a second copy of
 * this module (a test's module reset, a duplicated bundle) still sees the host
 * the shell installed.
 */
declare global {
  var __opensesameAppCoreHost: Host | undefined;
}

/** Install the host. The shell calls this once, before loading the app. */
export function configureHost(next: Host): void {
  globalThis.__opensesameAppCoreHost = next;
}

/** The installed host; throws when the shell never installed one. */
export function host(): Host {
  const installed = globalThis.__opensesameAppCoreHost;
  if (!installed) {
    throw new Error(
      "app-core: no host installed — call configureHost() before using the core",
    );
  }
  return installed;
}

/** Shorthand for `host().env`. */
export function env(): RuntimeEnv {
  return host().env;
}
