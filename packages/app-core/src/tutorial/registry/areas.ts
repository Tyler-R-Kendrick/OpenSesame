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
    id: "gates",
    title: "Getting in",
    goals: [
      "gate.front-door",
      "gate.join",
      "gate.sign-in",
      "gate.unlock",
      "gate.unlock.passkey",
      "gate.unlock.account",
      "gate.setup.choose",
      "gate.setup",
      "gate.setup.ways",
      "gate.setup.connectors",
      "gate.setup.keep",
      "gate.broker.consent",
      "gate.federation.return",
    ],
  },
  {
    id: "start",
    title: "Getting started",
    goals: ["client.support", "client.command-bar", "app.install"],
  },
  {
    id: "around",
    title: "Finding your way around",
    goals: [
      "shell.sections",
      "shell.sections.phone",
      "shell.sections.access",
      "shell.sections.activity",
      "shell.sections.connections",
      "shell.sections.identity",
      "shell.sections.wallet",
      "shell.statusline",
      "shell.more",
    ],
  },
  {
    id: "settings",
    title: "Settings, one category at a time",
    goals: [
      "settings.general.review",
      "settings.auto-lock.set",
      "settings.keybindings.review",
      "settings.capabilities.review",
      "settings.vaults.review",
      "settings.danger.review",
      "vault.recovery.view",
      "settings.live.host",
    ],
  },
  {
    id: "vault",
    title: "Your vault",
    goals: [
      "vault.item.create",
      "vault.item.find",
      "vault.item.accounts",
      "vault.item.favorite",
      "vault.item.edit",
      "vault.item.copy",
      "vault.item.trash",
      "vault.item.share",
      "vault.health.review",
      "vault.item-types.install",
      "vault.import",
      "vault.export",
      "vaults.switch",
      "vaults.manage",
      "vault.lock",
      "host.health.check",
      "feature.item-types",
      "feature.environments",
      "feature.security-checks",
    ],
  },
  {
    id: "keyboard",
    title: "The keyboard",
    goals: ["vault.keys.move", "vault.keys.bar", "vault.keys.macros"],
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
      "feature.encrypted-search",
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
      "connection.review",
      "connection.revoke",
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
      "access.review",
      "access.connectors",
      "access.relay",
      "access.requests.hosted",
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
      "identity.applications.manage",
      "identity.organizations.review",
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
      "identity.tailnet.devices.manage",
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
      "feature.notifications",
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

/**
 * Whether a walkthrough can be started from `route`.
 *
 * Tours navigate where they are going, so from the shell they start from
 * anywhere, except a goal that names only gates — screens a guide may wait on
 * and never navigate to, so a tour for one cannot be walked from another
 * screen. A gate is the opposite: it cannot navigate anywhere, so it offers
 * exactly the tutorials written for it and none of the shell's, whose
 * controls it does not draw (ADR 0166, amending ADR 0163 §4).
 */
export function tutorialStartsFrom(
  goal: GuideGoalDescriptor,
  route: GuideRouteId,
): boolean {
  if (GUIDE_OVERLAY_ROUTES.has(route)) {
    return goal.routes.some((scope) => guideRouteWithin(route, scope));
  }
  if (goal.routes.length === 0) return true;
  return goal.routes.some(
    (scope) =>
      guideRouteWithin(route, scope) || !GUIDE_OVERLAY_ROUTES.has(scope),
  );
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
  /**
   * Whether an optional capability is approved on the effective plan.
   * Omitted, every capability counts as installed, so a list that does not
   * know the plan still offers the tours the corpus names.
   */
  readonly installed?: (capability: string) => boolean;
};

/**
 * The one gate every list of walkthroughs shares — the library and the Ask
 * tab: the sections it points at are drawn, what it requires holds, and at
 * least one capability it names is installed.
 */
export function goalOffered(
  goal: GuideGoalDescriptor,
  options: LibraryOptions = {},
): boolean {
  const drawn = options.sectionDrawn ?? (() => true);
  const holds = options.holds ?? (() => true);
  const installed = options.installed ?? (() => true);
  const capabilities = goal.capabilities ?? [];
  return (
    goalSections(goal.guide).every(drawn) &&
    (goal.requires ?? []).every(holds) &&
    (capabilities.length === 0 || capabilities.some(installed))
  );
}

/**
 * Every live walkthrough that can start from `route`, grouped. A goal no area
 * names still appears, under "More", so it is never unreachable while the
 * test that forbids it is red.
 */
export function tutorialLibrary(
  route: GuideRouteId = "/vault",
  options: LibraryOptions = {},
): readonly TutorialGroup[] {
  const live = new Map(
    mergedGuideGoals()
      .filter((goal) => tutorialStartsFrom(goal, route))
      .filter((goal) => goalOffered(goal, options))
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
