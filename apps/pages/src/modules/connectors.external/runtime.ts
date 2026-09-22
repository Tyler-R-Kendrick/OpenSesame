/**
 * `connectors.external` — provider connections by reference (ADR 0115):
 * the Connections section and its rail entries, the connector settings
 * pages, the Connections settings category, the setup connectors tab, the
 * connection WebMCP tools, and the unlock effects that seal a parked
 * directory sync and arm Connect.
 *
 * Egress this module wraps (existing transport code, listed for the
 * catalog's declaration; new code goes through `ctx.egress`):
 *  - Vercel Connect relay at `connectCallbackBase()` — `/api/connect/*`
 *    (`lib/vercel-connect-relay.ts`, `lib/vercel-connect-ops.ts`); or the
 *    Connect API `https://api.vercel.com/v1/connect/*` with a sealed session
 *    token (`lib/vercel-connect-ops.ts`) — user-initiated (list on page
 *    open, authorize, revoke).
 *  - `@vercel/connect` SDK (`startAuthorization`, `getConnectorMetadata`,
 *    `revokeToken`) — user-initiated; exclusive to this chunk.
 *  - Host API `/api/v1/connections*`, `/api/v1/providers*` via `hostFetch`
 *    (`lib/connections.ts`) — automatic on page open when a Host is
 *    configured.
 *  - Nango-compatible directory: the two listing routes only
 *    (`lib/nango-directory.ts`) — user-initiated Sync.
 *  - A consent popup (`window.open`) to the provider's authorization URL —
 *    user-initiated.
 */

import { resetConnectionsNavigation } from "../../components/ConnectionsNavigation.js";
import { ConnectionsTreeEntries } from "../../components/ConnectionsTree.js";
import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { applyConnectCallbackBase } from "../../lib/connect-callback.js";
import { DIRECTORY_KEY } from "../../lib/connector-directory.js";
import { FIRST_RUN_KEY } from "../../lib/identity-graph.js";
import { disarmVercelConnectAuth } from "../../lib/vercel-connect-session.js";
import { ConnectorsStep } from "../../screens/setup/steps/ConnectorsStep.js";
import { ConnectionsSection } from "../../sections/ConnectionsSection.js";
import {
  CONNECTIONS_ROUTES,
  CONNECTIONS_TARGETS,
} from "../../tutorial/registry/connections-catalog.js";
import { CONNECTIONS_GOALS } from "../../tutorial/registry/connections-goals.js";
import {
  CONNECTIONS_READ_TOOL,
  OPEN_CONNECT_CEREMONY_TOOL,
} from "../../webmcp/connections-tools.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { ConnectionsSettingsPanel } from "./ConnectionsSettingsPanel.js";
import { connectorUnlockEffects } from "./unlock-effects.js";

export const CAPABILITY = "connectors.external";

/** Plaintext keys this capability hydrates before its first read. */
export const HYDRATE_KEYS: readonly string[] = [DIRECTORY_KEY, FIRST_RUN_KEY];

/**
 * Authored beside the registry (`connections-catalog.ts`, `-goals.ts`):
 * the Connections targets and route, plus the settings ceremonies that live
 * on connector pages (`settings.backup`, `settings.model-provider`,
 * `settings.secret-configs`, `settings.sync-targets`). `backup.git-remote`
 * depends on this capability, so `settings.backup` is declared whenever its
 * category link can mount. `CONNECTIONS_HELP` has no contribution kind yet.
 */
export const TUTORIAL = {
  targets: CONNECTIONS_TARGETS,
  goals: CONNECTIONS_GOALS,
  routes: CONNECTIONS_ROUTES,
} as const;

/**
 * The connection tools, each tagged with the operations it performs
 * (`connections.list` / `.inspect`, `connections.create` / `.bindings`).
 * The core keeps only those the plan approves before `agents.webmcp`
 * registers anything with the browser, so an unapproved operation has no
 * tool and the connection client is never imported by that surface.
 */
export const WEBMCP_TOOLS = [
  CONNECTIONS_READ_TOOL,
  OPEN_CONNECT_CEREMONY_TOOL,
] as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);

    // The relay address is deployment data the core parsed; only this
    // capability applies it, and disabling it forgets the address again.
    applyConnectCallbackBase(ctx.runtimeConfig.endpoints.connectCallbackBase);
    activation.onDispose(() => applyConnectCallbackBase(undefined));

    await ctx.hydrate(HYDRATE_KEYS);
    if (activation.disposed()) return activation.handle();

    activation.register("section", {
      id: "connections",
      to: "/connections",
      label: "Connections",
      segment: "connections",
      jump: "c",
      icon: "connection",
      order: 20,
      Tree: ConnectionsTreeEntries,
    });
    activation.register("route", {
      id: "connections",
      path: "/connections/:providerId?/:connectionId?",
      element: ConnectionsSection,
      framed: true,
      order: 20,
    });
    activation.register("route", {
      id: "settings-connections",
      path: "/settings/connections/:providerId/:connectionId?",
      element: ConnectionsSection,
      framed: true,
      order: 21,
    });
    activation.register("settings-category", {
      id: "connections",
      label: "Connections",
      guideId: "settings.connections",
      Panel: ConnectionsSettingsPanel,
      order: 40,
    });
    activation.register("setup-panel", {
      id: "connectors",
      tab: "connectors",
      rail: "Connectors",
      Panel: ConnectorsStep,
      order: 10,
    });
    activation.register("command-path", {
      path: "/connections",
      label: "Connections",
    });
    activation.register("keymap-jump", { key: "c", path: "/connections" });
    registerTutorial(activation, TUTORIAL);
    for (const tool of WEBMCP_TOOLS) {
      activation.register("webmcp-tool", tool);
    }
    for (const effect of connectorUnlockEffects(ctx.lease.signal)) {
      activation.register("unlock-effect", effect);
    }

    // Disable: the live Connect bearer leaves memory and the rail forgets
    // the page's snapshot. A staged token or parked directory sync is data
    // waiting for a tomb, not running code, and the next activation's
    // unlock effect seals it — nothing here writes, fetches or ceremonies.
    activation.onDispose(() => {
      disarmVercelConnectAuth();
      resetConnectionsNavigation();
    });

    return activation.handle();
  },
};
