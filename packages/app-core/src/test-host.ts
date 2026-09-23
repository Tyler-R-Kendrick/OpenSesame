import { browserPorts } from "./browser/host.js";
import { type Host, type RuntimeEnv, composeHost } from "./host.js";

export type TestHostOverrides = Readonly<
  Partial<Omit<Host, "env">> & { env?: Partial<RuntimeEnv> }
>;

/**
 * A host for tests: a development build served from `/`, with the browser's
 * ports read live — so a jsdom suite, or one that stubs a global, sees what
 * it set up — unless the test names its own.
 */
export function createTestHost(overrides: TestHostOverrides = {}): Host {
  const { env, ...ports } = overrides;
  return composeHost(browserPorts(), {
    env: { BASE_URL: "/", DEV: true, ...env },
    ...ports,
  });
}

/** Remove the installed host, for tests of the uninstalled state. */
export function clearHostForTest(): void {
  globalThis.__opensesameAppCoreHost = undefined;
}
