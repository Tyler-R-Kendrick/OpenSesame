/**
 * Installs the browser host before any part of the shared core runs
 * (ADR 0133). main.tsx imports this module first, so module evaluation order
 * guarantees the host exists before the app's own modules load.
 *
 * The env is spelled out key by key. Vite inlines `import.meta.env` whole when
 * the object itself is referenced, which would put every `VITE_*` variable in
 * the build environment into the public bundle; naming each key inlines only
 * the ones the core reads.
 */
import { browserPorts } from "@opensesame/app-core/browser/host.js";
import { composeHost, configureHost } from "@opensesame/app-core/host.js";
import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
import { zodJitless } from "@opensesame/app-core/lib/zod-jitless.js";
import { shellBuild } from "./shell-build.js";

// Before any schema module loads: zod must not probe for eval under the CSP.
zodJitless();

configureHost(
  composeHost(browserPorts(), {
    env: {
      BASE_URL: import.meta.env.BASE_URL,
      DEV: import.meta.env.DEV,
      VITE_CONNECT_CALLBACK_BASE: import.meta.env.VITE_CONNECT_CALLBACK_BASE,
      VITE_DAEMON_API: import.meta.env.VITE_DAEMON_API,
      VITE_HOST_API: import.meta.env.VITE_HOST_API,
      VITE_IDENTITY_API: import.meta.env.VITE_IDENTITY_API,
      VITE_SUPPORT_AGENT_URL: import.meta.env.VITE_SUPPORT_AGENT_URL,
    },
    ...shellBuild,
  }),
);
// Start loading the at-rest key (ADR 0149) now: every stored value is sealed
// under it, and boot waits for it before reading anything. A write made
// before it lands waits in memory.
void atRestReady();
