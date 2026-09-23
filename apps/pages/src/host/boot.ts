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
import { shellBuild } from "./shell-build.js";

configureHost(
  composeHost(browserPorts(), {
    env: {
      BASE_URL: import.meta.env.BASE_URL,
      DEV: import.meta.env.DEV,
      VITE_CONNECT_CALLBACK_BASE: import.meta.env.VITE_CONNECT_CALLBACK_BASE,
      VITE_DAEMON_API: import.meta.env.VITE_DAEMON_API,
      VITE_HOST_API: import.meta.env.VITE_HOST_API,
      VITE_IDENTITY_API: import.meta.env.VITE_IDENTITY_API,
      VITE_MFA_APP_URL: import.meta.env.VITE_MFA_APP_URL,
      VITE_OPENSESAME_CEREMONIES: import.meta.env.VITE_OPENSESAME_CEREMONIES,
      VITE_SUPPORT_AGENT_URL: import.meta.env.VITE_SUPPORT_AGENT_URL,
    },
    ...shellBuild,
  }),
);
