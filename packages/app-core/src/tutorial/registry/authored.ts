/**
 * The whole authored tutorial corpus — core entries and every capability's
 * partition — for a module to pick its own entries from by id
 * (`modules/tutorial-contributions.ts`) and for the registry tests to prove
 * every authored guide compiles.
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
import {
  CORE_GUIDE_GOALS,
  CORE_HELP_TOPICS,
  type GuideGoalDescriptor,
  type HelpTopic,
} from "./goals.js";
import { IDENTITY_ROUTES, IDENTITY_TARGETS } from "./identity-catalog.js";
import { IDENTITY_GOALS, IDENTITY_HELP } from "./identity-goals.js";
import {
  NOTIFICATIONS_GOALS,
  NOTIFICATIONS_ROUTES,
  NOTIFICATIONS_TARGETS,
} from "./notifications-catalog.js";
import { CORE_GUIDE_ROUTES, type GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";
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
    goals: CONNECTIONS_GOALS,
    help: CONNECTIONS_HELP,
    routes: CONNECTIONS_ROUTES,
  },
  {
    capability: "access.authority",
    files: { targets: "access-catalog.ts", goals: "access-goals.ts" },
    targets: ACCESS_TARGETS,
    goals: [...ACCESS_GOALS, ...AUTHORITY_GOALS],
    help: [...ACCESS_HELP, ...AUTHORITY_HELP],
    routes: ACCESS_ROUTES,
  },
  {
    capability: "identity.federation",
    files: { targets: "identity-catalog.ts", goals: "identity-goals.ts" },
    targets: IDENTITY_TARGETS,
    goals: IDENTITY_GOALS,
    help: IDENTITY_HELP,
    routes: IDENTITY_ROUTES,
  },
  {
    capability: "wallet.spending",
    files: { targets: "wallet-catalog.ts" },
    targets: WALLET_TARGETS,
    goals: [],
    help: [],
    routes: WALLET_ROUTES,
  },
  {
    capability: "activity.log",
    files: { targets: "activity-catalog.ts" },
    targets: ACTIVITY_TARGETS,
    goals: [],
    help: [],
    routes: ACTIVITY_ROUTES,
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
