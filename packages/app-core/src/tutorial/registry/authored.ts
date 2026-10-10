/**
 * The whole authored tutorial corpus — core entries and every capability's
 * partition — for the registry tests to prove every authored guide compiles
 * (`catalog.test.ts`, `optional-tutorials.test-support.ts`). Nothing at
 * runtime imports it: a module contributes its own catalog arrays directly
 * (`apps/pages/src/modules/tutorial-contributions.ts`).
 *
 * This is not the live catalog. What a guide may point at, where it may go
 * and what help it may answer with is `GUIDE_TARGETS` / `GUIDE_ROUTES` /
 * `GUIDE_GOALS` / `HELP_TOPICS`: the core plus the contributions approved
 * capabilities registered, and nothing for one that is not in the plan.
 */

import { ACCESS_ROUTES, ACCESS_TARGETS } from "./access-catalog.js";
import { ACCESS_GOALS, ACCESS_HELP } from "./access-goals.js";
import { ACTIVITY_ROUTES, ACTIVITY_TARGETS } from "./activity-catalog.js";
import { AUTHORITY_GOALS, AUTHORITY_HELP } from "./authority-help.js";
import { CORE_GUIDE_TARGETS } from "./catalog.js";
import {
  CONNECTIONS_ROUTES,
  CONNECTIONS_TARGETS,
} from "./connections-catalog.js";
import { CONNECTIONS_GOALS, CONNECTIONS_HELP } from "./connections-goals.js";
import { DROPS_GOALS, DROPS_TARGETS } from "./drops-catalog.js";
import {
  CORE_GUIDE_GOALS,
  CORE_HELP_TOPICS,
  type GuideGoalDescriptor,
  type HelpTopic,
} from "./goals.js";
import { IDENTITY_ROUTES, IDENTITY_TARGETS } from "./identity-catalog.js";
import { IDENTITY_GOALS, IDENTITY_HELP } from "./identity-goals.js";
import { LIVE_GOALS, LIVE_ROUTES, LIVE_TARGETS } from "./live-catalog.js";
import {
  LOCAL_NOTIFICATIONS_GOALS,
  LOCAL_NOTIFICATIONS_TARGETS,
  NOTIFICATIONS_GOALS,
  NOTIFICATIONS_ROUTES,
  NOTIFICATIONS_TARGETS,
} from "./notifications-catalog.js";
import {
  AUTOFILL_GOALS,
  AUTOFILL_TARGETS,
  SURROGATE_GOALS,
  SURROGATE_TARGETS,
} from "./plugins-catalog.js";
import { CORE_GUIDE_ROUTES, type GuideRouteDescriptor } from "./routes.js";
import {
  NAV_ACCESS_GOALS,
  NAV_ACTIVITY_GOALS,
  NAV_CONNECTIONS_GOALS,
  NAV_IDENTITY_GOALS,
  NAV_WALLET_GOALS,
} from "./section-nav-goals.js";
import {
  TAILNET_DEVICES_GOALS,
  TAILNET_DEVICES_HELP,
  TAILNET_DEVICES_TARGETS,
} from "./tailnet-devices-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";
import {
  TRUSTED_CONTACTS_GOALS,
  TRUSTED_CONTACTS_ROUTES,
  TRUSTED_CONTACTS_TARGETS,
} from "./trusted-contacts-catalog.js";
import { WALLET_ROUTES, WALLET_TARGETS } from "./wallet-catalog.js";

/** One capability's partition, as its module contributes it. */
export type TutorialPartition = Readonly<{
  /** The capability that owns these entries (informative; the module binds). */
  capability: string;
  /** Source files, for the tests that prove prose is checked-in literals. */
  files: Readonly<{ targets: string; goals?: string }>;
  targets: readonly GuideTargetDescriptor[];
  goals: readonly GuideGoalDescriptor[];
  help: readonly HelpTopic[];
  routes: readonly GuideRouteDescriptor[];
}>;

/** Every optional partition, in the order the fixture registers them. */
export const OPTIONAL_TUTORIALS: readonly TutorialPartition[] = [
  {
    capability: "connectors.external",
    files: { targets: "connections-catalog.ts", goals: "connections-goals.ts" },
    targets: CONNECTIONS_TARGETS,
    goals: [...CONNECTIONS_GOALS, ...NAV_CONNECTIONS_GOALS],
    help: CONNECTIONS_HELP,
    routes: CONNECTIONS_ROUTES,
  },
  {
    capability: "access.authority",
    files: { targets: "access-catalog.ts", goals: "access-goals.ts" },
    targets: ACCESS_TARGETS,
    goals: [...ACCESS_GOALS, ...AUTHORITY_GOALS, ...NAV_ACCESS_GOALS],
    help: [...ACCESS_HELP, ...AUTHORITY_HELP],
    routes: ACCESS_ROUTES,
  },
  {
    capability: "identity.federation",
    files: { targets: "identity-catalog.ts", goals: "identity-goals.ts" },
    targets: IDENTITY_TARGETS,
    goals: [...IDENTITY_GOALS, ...NAV_IDENTITY_GOALS],
    help: IDENTITY_HELP,
    routes: IDENTITY_ROUTES,
  },
  {
    capability: "wallet.spending",
    files: { targets: "wallet-catalog.ts" },
    targets: WALLET_TARGETS,
    goals: NAV_WALLET_GOALS,
    help: [],
    routes: WALLET_ROUTES,
  },
  {
    capability: "activity.log",
    files: { targets: "activity-catalog.ts" },
    targets: ACTIVITY_TARGETS,
    goals: NAV_ACTIVITY_GOALS,
    help: [],
    routes: ACTIVITY_ROUTES,
  },
  {
    capability: "sharing.live",
    files: { targets: "live-catalog.ts", goals: "live-catalog.ts" },
    targets: LIVE_TARGETS,
    goals: LIVE_GOALS,
    help: [],
    routes: LIVE_ROUTES,
  },
  {
    capability: "notifications.routing",
    files: {
      targets: "notifications-catalog.ts",
      goals: "notifications-catalog.ts",
    },
    targets: NOTIFICATIONS_TARGETS,
    goals: NOTIFICATIONS_GOALS,
    help: [],
    routes: NOTIFICATIONS_ROUTES,
  },
  {
    capability: "notifications.local",
    files: {
      targets: "notifications-catalog.ts",
      goals: "notifications-catalog.ts",
    },
    targets: LOCAL_NOTIFICATIONS_TARGETS,
    goals: LOCAL_NOTIFICATIONS_GOALS,
    help: [],
    routes: [],
  },
  {
    capability: "agents.surrogate-credentials",
    files: { targets: "plugins-catalog.ts", goals: "plugins-catalog.ts" },
    targets: SURROGATE_TARGETS,
    goals: SURROGATE_GOALS,
    help: [],
    routes: [],
  },
  {
    capability: "vault.browser-autofill",
    files: { targets: "plugins-catalog.ts", goals: "plugins-catalog.ts" },
    targets: AUTOFILL_TARGETS,
    goals: AUTOFILL_GOALS,
    help: [],
    routes: [],
  },
  {
    capability: "sharing.drops",
    files: { targets: "drops-catalog.ts", goals: "drops-catalog.ts" },
    targets: DROPS_TARGETS,
    goals: DROPS_GOALS,
    help: [],
    routes: [],
  },
  {
    capability: "networking.tailnet-devices",
    files: {
      targets: "tailnet-devices-catalog.ts",
      goals: "tailnet-devices-catalog.ts",
    },
    targets: TAILNET_DEVICES_TARGETS,
    goals: TAILNET_DEVICES_GOALS,
    help: TAILNET_DEVICES_HELP,
    routes: [],
  },
  {
    capability: "sharing.trusted-contacts",
    files: {
      targets: "trusted-contacts-catalog.ts",
      goals: "trusted-contacts-catalog.ts",
    },
    targets: TRUSTED_CONTACTS_TARGETS,
    goals: TRUSTED_CONTACTS_GOALS,
    help: [],
    routes: TRUSTED_CONTACTS_ROUTES,
  },
];

export const AUTHORED_GUIDE_TARGETS: readonly GuideTargetDescriptor[] = [
  ...CORE_GUIDE_TARGETS,
  ...OPTIONAL_TUTORIALS.flatMap((partition) => partition.targets),
];

export const AUTHORED_GUIDE_GOALS: readonly GuideGoalDescriptor[] = [
  ...CORE_GUIDE_GOALS,
  ...OPTIONAL_TUTORIALS.flatMap((partition) => partition.goals),
];

export const AUTHORED_HELP_TOPICS: readonly HelpTopic[] = [
  ...CORE_HELP_TOPICS,
  ...OPTIONAL_TUTORIALS.flatMap((partition) => partition.help),
];

export const AUTHORED_GUIDE_ROUTES: readonly GuideRouteDescriptor[] = [
  ...CORE_GUIDE_ROUTES,
  ...OPTIONAL_TUTORIALS.flatMap((partition) => partition.routes),
];
