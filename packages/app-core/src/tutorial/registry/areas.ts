/**
 * The tutorial library: every walkthrough the product has, grouped the way a
 * person goes looking for one.
 *
 * A goal is authored once (`goals.ts`) and offered in two places — beside the
 * written answer it belongs to, and here, as a replayable lesson. The groups
 * are authored too: a person looking for "how do I back this up" does not
 * know which capability owns it, so the library is organised by what they
 * want to do, and `areas.test.ts` proves every live goal has exactly one
 * home, so a tour added without a place cannot be missing from the list.
 */

import type { GuideGoalId } from "@opensesame/guide-lang";
import { type GuideGoalDescriptor, mergedGuideGoals } from "./goals.js";
import {
  GUIDE_OVERLAY_ROUTES,
  type GuideRouteId,
  guideRouteWithin,
} from "./routes.js";

export type TutorialArea = {
  readonly id: string;
  readonly title: string;
  readonly goals: readonly GuideGoalId[];
};

export const TUTORIAL_AREAS: readonly TutorialArea[] = [
  {
    id: "start",
    title: "Getting started",
    goals: [
      "unlock.open",
      "setup.first-run",
      "setup.operator",
      "setup.join-session",
      "client.support",
      "client.command-bar",
      "app.install",
      "broker.authorize",
    ],
  },
  {
    id: "vault",
    title: "Your vault",
    goals: [
      "vault.item.create",
      "vault.health.review",
      "vault.item-types.install",
      "vault.import",
      "vault.export",
      "vaults.switch",
      "vault.lock",
      "host.health.check",
      "feature.item-types",
      "feature.environments",
    ],
  },
  {
    id: "security",
    title: "Keys and unlocking",
    goals: [
      "settings.security.review",
      "vault.second-step.code",
      "vault.recovery-codes",
      "vaults.duress-code",
      "vaults.travel",
      "identity.account-factors",
      "feature.encryption",
    ],
  },
  {
    id: "storage",
    title: "Backup, sync and storage",
    goals: [
      "settings.backup",
      "settings.tailnet-sync",
      "feature.local-storage",
      "feature.cloud-secret-storage",
      "feature.password-managers",
    ],
  },
  {
    id: "connections",
    title: "Connections",
    goals: [
      "connection.create",
      "connection.repair",
      "browser.pair",
      "browser.authenticate",
      "feature.connections",
    ],
  },
  {
    id: "access",
    title: "Access",
    goals: [
      "access.grant",
      "access.connectors",
      "access.relay",
      "access.sessions.review",
      "agent.control",
      "agent.observe",
      "authority.portal.templates.manage",
      "authority.portal.templates.read",
      "identity.local.access.manage",
      "identity.local.policy.manage",
      "identity.local.requests.manage",
      "feature.access",
    ],
  },
  {
    id: "identity",
    title: "Identity",
    goals: [
      "identity.sign-in",
      "identity.sign-out",
      "identity.switch-account",
      "identity.account.add",
      "identity.agents.manage",
      "identity.users.manage",
      "identity.approval.review",
      "identity.claim.accept",
      "identity.device.approve",
      "identity.drop.open",
      "identity.interaction.approve",
      "identity.local.agent.keys.manage",
      "identity.local.application.authorize",
      "identity.local.directory.manage",
      "identity.local.organizations.member",
      "identity.local.passkeys.manage",
      "identity.local.siop.authorize",
      "feature.identity",
      "feature.directory",
    ],
  },
  {
    id: "extras",
    title: "Agents, models and extras",
    goals: [
      "settings.model-provider",
      "settings.notifications",
      "settings.local-notifications",
      "settings.surrogate-credentials",
      "settings.browser-autofill",
      "feature.password-reset",
      "feature.sharing",
      "feature.payments",
      "feature.certificates",
      "feature.telemetry",
    ],
  },
];

/** The directives a person counts as steps: what a tour presents. */
const PRESENTING = /^(say|focus|hint|annotate|success)\s/;

/**
 * How many steps a walkthrough has, read off its source without parsing it.
 * The parser and the runtime own the real plan; this is only the number on a
 * list row, which has to be there before the guide engine has loaded.
 */
export function tutorialStepCount(guide: string): number {
  const presenting = guide
    .split("\n")
    .filter((line) => PRESENTING.test(line.trim())).length;
  // A closing `success` is the card after the last step, not a step itself.
  const closes = /^success\s/m.test(
    guide
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => PRESENTING.test(line))
      .at(-1) ?? "",
  );
  return Math.max(0, presenting - (closes ? 1 : 0));
}

export type Tutorial = {
  readonly goal: GuideGoalDescriptor;
  readonly steps: number;
};

export type TutorialGroup = {
  readonly id: string;
  readonly title: string;
  readonly tutorials: readonly Tutorial[];
};

/** Whether `route` is a screen with no shell: a gate a guide may wait on, never navigate to. */
function onGate(route: GuideRouteId): boolean {
  return [...GUIDE_OVERLAY_ROUTES].some((gate) =>
    guideRouteWithin(route, gate),
  );
}

/**
 * Whether a walkthrough can be started from `route`.
 *
 * Most tours navigate where they are going, so from the shell they start from
 * anywhere. A gate — the unlock screen, setup, the broker popup — has no
 * shell to navigate in, so there only the tutorials written for that gate are
 * offered; and a tutorial written for a gate is offered nowhere else.
 */
export function tutorialStartsFrom(
  goal: GuideGoalDescriptor,
  route: GuideRouteId,
): boolean {
  const here = goal.routes.some((scope) => guideRouteWithin(route, scope));
  if (onGate(route)) return here;
  if (goal.routes.length === 0) return true;
  return here || goal.routes.some((scope) => !GUIDE_OVERLAY_ROUTES.has(scope));
}

/** The Settings › Capabilities sections a walkthrough points at, by feature id. */
export function goalSections(guide: string): readonly string[] {
  return [...guide.matchAll(/^focus\s+"feature\.([a-z-]+)"/gm)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
}

export type LibraryOptions = {
  /**
   * Whether a section of Settings › Capabilities is drawn in this build and
   * plan. A tutorial that points at a section that is not there would point at
   * nothing, so it is not offered; omitted, every section counts as drawn.
   */
  readonly sectionDrawn?: (feature: string) => boolean;
  /** Whether a state predicate holds now; omitted, every requirement is met. */
  readonly holds?: (predicate: string) => boolean;
};

/**
 * Every live walkthrough that can start from `route`, grouped. A goal no area
 * names still appears, under "More", so it is never unreachable while the
 * test that forbids it is red.
 */
export function tutorialLibrary(
  route: GuideRouteId = "/vault",
  options: LibraryOptions = {},
): readonly TutorialGroup[] {
  const drawn = options.sectionDrawn ?? (() => true);
  const holds = options.holds ?? (() => true);
  const live = new Map(
    mergedGuideGoals()
      .filter((goal) => tutorialStartsFrom(goal, route))
      .filter((goal) => goalSections(goal.guide).every(drawn))
      .filter((goal) => (goal.requires ?? []).every(holds))
      .map((goal) => [goal.id, goal]),
  );
  const placed = new Set<string>();
  const groups: TutorialGroup[] = [];
  for (const area of TUTORIAL_AREAS) {
    const tutorials: Tutorial[] = [];
    for (const id of area.goals) {
      const goal = live.get(id);
      if (!goal) continue;
      placed.add(id);
      tutorials.push({ goal, steps: tutorialStepCount(goal.guide) });
    }
    if (tutorials.length > 0) {
      groups.push({ id: area.id, title: area.title, tutorials });
    }
  }
  const rest = [...live.values()].filter((goal) => !placed.has(goal.id));
  if (rest.length > 0) {
    groups.push({
      id: "more",
      title: "More",
      tutorials: rest.map((goal) => ({
        goal,
        steps: tutorialStepCount(goal.guide),
      })),
    });
  }
  return groups;
}
