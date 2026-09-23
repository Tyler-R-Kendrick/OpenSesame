/**
 * Harness fixtures run core code in a bare page, with no Pages boot to
 * install the host (ADR 0133 §3). Import this first: it installs the same
 * browser ports the shell's `src/host/boot.ts` does, for the `/OpenSesame/`
 * base the harnesses serve. Never part of the Pages build.
 */
import { browserPorts } from "@opensesame/app-core/browser/host.js";
import { composeHost, configureHost } from "@opensesame/app-core/host.js";

configureHost(
  composeHost(browserPorts(), {
    env: { BASE_URL: "/OpenSesame/", DEV: false },
  }),
);
