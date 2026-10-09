/**
 * `connectors.external` — provider connections by reference (ADR 0115),
 * optional and off until chosen: the Connections section and its rail entries, the connector
 * settings pages (whose tiles Settings › Capabilities draws under each
 * feature), the setup connectors tab, the
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
 *  - No Host: Pages speaks none (ADR 0128), so a connection is made by
 *    Connect or sealed on this device, and a call no road can take is
 *    refused, never sent (`lib/connections.ts`, ADR 0151).
 *  - Nango-compatible directory: the two listing routes only
 *    (`lib/nango-directory.ts`) — user-initiated Sync.
 *  - A consent popup (`window.open`) to the provider's authorization URL —
 *    user-initiated.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { applyConnectCallbackBase } from "@opensesame/app-core/lib/connect-callback.js";
import {
  connectRoadSeams,
  notifyConnectRoads,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import { DIRECTORY_KEY } from "@opensesame/app-core/lib/connector-directory.js";
import {
  performSavedConnector,
  registerCategorySend,
} from "@opensesame/app-core/lib/feature-request-send.js";
import type { FeatureRequest } from "@opensesame/app-core/lib/feature-request.js";

import { FIRST_RUN_KEY } from "@opensesame/app-core/lib/identity-graph.js";
import { hasConnectRoute } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { disarmVercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect-session.js";
import { usesConnect } from "@opensesame/app-core/lib/vercel-connect.js";
import {
  CONNECTIONS_ROUTES,
  CONNECTIONS_TARGETS,
} from "@opensesame/app-core/tutorial/registry/connections-catalog.js";
import { CONNECTIONS_GOALS } from "@opensesame/app-core/tutorial/registry/connections-goals.js";
import { NAV_CONNECTIONS_GOALS } from "@opensesame/app-core/tutorial/registry/section-nav-goals.js";
import {
  CONNECTIONS_READ_TOOL,
  OPEN_CONNECT_CEREMONY_TOOL,
} from "@opensesame/app-core/webmcp/connections-tools.js";
import { resetConnectionsNavigation } from "../../components/ConnectionsNavigation.js";
import { ConnectionsTreeEntries } from "../../components/ConnectionsTree.js";
import { applySavedConnectors } from "../../lib/apply-saved-connectors.js";
import {
  savedLocalStorageOperation,
  savedPasswordManagerOperation,
} from "../../lib/local-connector-features.js";
import { ConnectorsStep } from "../../screens/setup/steps/ConnectorsStep.js";
import { StorageStep } from "../../screens/setup/steps/StorageStep.js";
import { ConnectionsSection } from "../../sections/ConnectionsSection.js";
import {
  connectorMarkLookup,
  resetConnectorMarkLookup,
} from "../../sections/connections/ConnectorMark.js";
import { connectorMark } from "../../sections/connections/connector-marks.js";
import { createActivation } from "../activation.js";
import { tagWebMcpTool } from "../ports-b.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { bindLinearRuntime } from "./linear-runtime.js";
import { connectorUnlockEffects } from "./unlock-effects.js";

export const CAPABILITY = "connectors.external";

/** Plaintext keys this capability hydrates before its first read. */
export const HYDRATE_KEYS: readonly string[] = [DIRECTORY_KEY, FIRST_RUN_KEY];

/**
 * Authored beside the registry (`connections-catalog.ts`, `-goals.ts`):
 * the Connections targets and route, plus the settings ceremonies that live
 * on connector pages (`settings.backup`, `settings.model-provider`).
 * `backup.git-remote` depends on this capability, so `settings.backup` is
 * declared whenever its category link can mount. `CONNECTIONS_HELP` has no contribution kind yet.
 */
export const TUTORIAL = {
  targets: CONNECTIONS_TARGETS,
  goals: [...CONNECTIONS_GOALS, ...NAV_CONNECTIONS_GOALS],
  routes: CONNECTIONS_ROUTES,
} as const;

/**
 * The connection tools, each tagged with the operations it performs
 * (`connections.list` / `.inspect`, `connections.create` / `.bindings`).
 * They exist only while this capability is active, and `agents.webmcp`
 * registers the contributed set with the browser, so the connection client
 * is never imported by that surface.
 */
export const WEBMCP_TOOLS = [
  CONNECTIONS_READ_TOOL,
  OPEN_CONNECT_CEREMONY_TOOL,
] as const;

/** Arm password-manager and local-storage connectors saved on this device. */
export function startExternalConnectors(): FeatureRequest[] {
  const managers = applySavedConnectors(
    ["password_managers"],
    savedPasswordManagerOperation,
  );
  const local = applySavedConnectors(
    ["local_storage"],
    savedLocalStorageOperation,
  );
  return [...managers, ...local].map((operation) =>
    externalOperation(operation.providerId),
  );
}

export function externalOperation(providerId: string): FeatureRequest {
  return performSavedConnector(providerId);
}

/** Send saved password-manager and local-storage connectors when connections load. */
export function runSavedExternalConnectors(): FeatureRequest[] {
  return startExternalConnectors();
}

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    // A lease that was already stale when the loader got here has nothing
    // to apply and nothing to register.
    if (activation.disposed()) return activation.handle();

    // The relay address is deployment data the core parsed; only this
    // capability applies it, and disabling it forgets the address again.
    applyConnectCallbackBase(ctx.runtimeConfig.endpoints.connectCallbackBase);
    activation.onDispose(() => applyConnectCallbackBase(undefined));

    bindLinearRuntime(ctx, activation);

    await ctx.hydrate(HYDRATE_KEYS);
    if (activation.disposed()) return activation.handle();
    const releaseManagers = registerCategorySend(
      "password_managers",
      runSavedExternalConnectors,
    );
    const releaseLocal = registerCategorySend(
      "local_storage",
      runSavedExternalConnectors,
    );
    activation.onDispose(releaseManagers);
    activation.onDispose(releaseLocal);

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
    activation.register("setup-panel", {
      id: "connectors",
      tab: "connectors",
      rail: "Connectors",
      Panel: ConnectorsStep,
      order: 10,
    });
    // Where the vault lives: the S3-compatible bucket, the same form as
    // Settings › Capabilities › Local storage (ADR 0182).
    activation.register("setup-panel", {
      id: "storage",
      tab: "storage",
      rail: "Storage",
      Panel: StorageStep,
      order: 15,
    });
    activation.register("command-path", {
      path: "/connections",
      label: "Connections",
    });
    activation.register("keymap-jump", { key: "c", path: "/connections" });
    registerTutorial(activation, TUTORIAL);
    for (const tool of WEBMCP_TOOLS) {
      activation.register("webmcp-tool", tagWebMcpTool(tool));
    }
    for (const effect of connectorUnlockEffects(ctx.lease.signal)) {
      activation.register("unlock-effect", effect);
    }

    // Disable: the live Connect bearer leaves memory and the rail forgets
    // the page's snapshot. A staged token or parked directory sync is data
    // waiting for a tomb, not running code, and the next activation's
    // unlock effect seals it — nothing here writes, fetches or ceremonies.
    connectRoadSeams.usesConnect = usesConnect;
    connectRoadSeams.hasConnectRoute = hasConnectRoute;
    // The connector pages are routed above; tiles link to them only now.
    connectRoadSeams.pagesOpen = () => true;
    connectorMarkLookup.find = connectorMark;
    notifyConnectRoads();
    activation.onDispose(() => {
      disarmVercelConnectAuth();
      resetConnectionsNavigation();
      resetConnectRoadSeams();
      resetConnectorMarkLookup();
      notifyConnectRoads();
    });

    return activation.handle();
  },
};
