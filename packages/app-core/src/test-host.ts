import type { Host, RuntimeEnv } from "./host.js";

export type TestHostOverrides = { readonly env?: Partial<RuntimeEnv> };

/** A host for tests: a development build served from `/`, nothing else. */
export function createTestHost(overrides: TestHostOverrides = {}): Host {
  return {
    env: { BASE_URL: "/", DEV: true, ...overrides.env },
  };
}

/** Remove the installed host, for tests of the uninstalled state. */
export function clearHostForTest(): void {
  globalThis.__opensesameAppCoreHost = undefined;
}
