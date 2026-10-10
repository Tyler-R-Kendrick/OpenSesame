/**
 * The browser host for Storybook: what `src/host/boot.ts` installs for the
 * app, with Storybook's `import.meta.env` and no capability build. The
 * app's module table and distribution are virtual modules of the Pages
 * build plugin; a story renders one component and never resolves a
 * capability plan, so the host carries an empty table and a distribution
 * that names nothing optional.
 */
import { browserPorts } from "@opensesame/app-core/browser/host.js";
import { composeHost, configureHost } from "@opensesame/app-core/host.js";
import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
import type { SecurityProfile } from "@opensesame/app-core/lib/deployment-profile.js";
import securityProfile from "../public/security-profile.json";
import staticAuth from "../public/static-auth/manifest.json";

configureHost(
  composeHost(browserPorts(), {
    env: {
      BASE_URL: import.meta.env.BASE_URL,
      DEV: import.meta.env.DEV,
    },
    capabilities: {
      moduleTable: async () => ({}),
      distribution: async () => ({
        distributionId: "storybook",
        mode: "selective",
        capabilityIds: [],
        moduleIds: [],
        workerVariants: [],
        basePath: import.meta.env.BASE_URL,
      }),
    },
    securityProfile: securityProfile as SecurityProfile,
    staticAuth: { version: staticAuth.version, sri: staticAuth.sri },
  }),
);
void atRestReady();
