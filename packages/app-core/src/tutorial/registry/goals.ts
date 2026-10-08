import { sessionGuide } from "./session-guide.js";
/**
 * Named goals, authored help, and the deterministic guides that run when no
 * model is available at all.
 *
 * The knowledge is here, in typed data, rather than only inside a prompt. That
 * is deliberate: a browser with no on-device model and no configured endpoint
 * still gets contextual help, search, and real walkthroughs — AI makes this
 * graph conversational, it is not the place the knowledge is stored.
 */

import type { GuideGoalId } from "@opensesame/guide-lang";
import type { SupportGoalDescription } from "@opensesame/support-agent";
import { contributionsSnapshot } from "../../lib/contributions.js";
import { ACCESS_HELP } from "./access-goals.js";
import { AUTHORITY_HELP } from "./authority-help.js";
import { CONNECTIONS_HELP } from "./connections-goals.js";
import { FEATURE_GOALS } from "./feature-goals.js";
import type { GuideGoalDescriptor, HelpTopic } from "./goal-types.js";
import { HEALTH_REVIEW_GOAL } from "./health-goal.js";
import { IDENTITY_HELP } from "./identity-goals.js";
import { ITEM_REFERENCE_HELP } from "./item-reference-help.js";
import { type GuideRouteId, scopeApplies } from "./routes.js";
import { SETUP_GOALS, SETUP_HELP, SHELL_GOALS } from "./setup-goals.js";
import { SHELL_HELP } from "./shell-goals.js";
import { isKnownGuidePredicate, readGuidePredicate } from "./state.js";
export { CAPABILITY_TUTORIALS } from "./capability-tutorials.js";
export { FEATURE_TUTORIALS } from "./feature-goals.js";
export type { GuideGoalDescriptor, HelpTopic } from "./goal-types.js";

/**
 * The goals the core shell always offers. A goal that walks an optional
 * section belongs to that capability (`connections-goals.ts`,
 * `access-goals.ts`, `authority-help.ts`, `identity-goals.ts`) and arrives as
 * a `tutorial-goal` contribution while the capability is in the plan.
 */
export const CORE_GUIDE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.lock",
    title: "Lock the vault",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.lock"',
      'say "Locking drops the keys held in memory; your unlock method opens it again."',
      'focus "shell.lock" "This is the lock. Press it whenever you step away." side=top',
      'wait target "shell.lock" event=activate timeout=30000',
      'success "Locked. The vault is sealed until you unlock it again."',
      "end",
    ].join("\n"),
  },
  {
    id: "vaults.switch",
    title: "Switch to another vault on this device",
    routes: [],
    get guide() {
      return sessionGuide([
        "guide/1",
        'goal "vaults.switch"',
        'say "A device can hold several vaults: the personal one, one per project, and a guest session beside them. Switching locks the open vault unless the other shares its key."',
        'focus "prompt.tomb" "This control names the open vault. Press it to see every vault on this device." side=bottom',
        'wait target "prompt.tomb" event=activate timeout=30000',
        'say "Each row says when it was sealed and whether it opens without a prompt. Settings → Vaults is where a vault is sealed with a choice, or deleted."',
        "end",
      ]);
    },
  },
  {
    id: "host.health.check",
    title: "Check whether OpenSesame is healthy",
    routes: [],
    guide: [
      "guide/1",
      'goal "host.health.check"',
      'say "Vault health lists weak, reused and aging items. Whether this device is connected lives in Settings → Connections."',
      'navigate "/vault/health"',
      'wait route "/vault/health" timeout=15000',
      'focus "vault.health.summary" "The verdict: how many passwords were reviewed, and how many are weak, reused or aging." side=bottom',
      'success "This is Vault health."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.item.create",
    title: "Add an item to the vault",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.item.create"',
      'say "Items are sealed on this device. Nothing you type here is uploaded anywhere."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.list" "Everything the vault holds is listed here, grouped by folder and narrowed by whichever filter is active." side=right',
      'focus "vault.create" "New item opens the editor for the kind the current filter names — an account unless you narrowed the list. Nothing is stored until you save. The n key does the same from the list." side=bottom',
      'wait target "vault.create" event=activate timeout=60000',
      'success "Name it, enter the secret and save. The item is sealed with the rest of the vault."',
      "end",
    ].join("\n"),
  },
  HEALTH_REVIEW_GOAL,
  {
    id: "settings.security.review",
    title: "Review the security settings",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.security.review"',
      'say "Security holds the keys that open this vault, and the second steps asked after one."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.vault-key-protection" "The keys enrolled on this vault. Add opens one sheet for a recovery key, a passkey, an age recipient or a cloud key; each row can be tested, and most removed." side=top',
      'focus "settings.second-step" "Second steps are asked after a key. Nothing turns on until a code from the new method matches." side=top',
      'success "Every row here has one action, and each opens the same sheet."',
      "end",
    ].join("\n"),
  },
  ...SETUP_GOALS,
  {
    id: "vault.recovery-codes",
    title: "Save the recovery codes",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.recovery-codes"',
      'say "Recovery codes stand in for the second step once each. They are made when the first second step turns on and shown once; save them somewhere the phone is not."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.second-step" "Turn on a second step here. The first one makes the recovery codes and shows them once; after that the Recovery row opens the list — View shows which are left, and Make a new set replaces them all." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.item-types.install",
    title: "Install a vault item type",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.item-types.install"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/vaults"',
      'wait route "/settings/vaults" timeout=15000',
      'focus "settings.item-types" "A type is a JSON manifest, never code. Each built-in type is a switch: turning one on downloads and installs it, and it is not in the app until then. The branch key reads the git repositories you list for more types, each shown field by field before it installs." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.export",
    title: "Export the vault",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.export"',
      'say "An export is one encrypted backup file: the sealed vault body plus its key-wrapping header. It is opened again with the unlock the vault already has, for moving to another device."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.export" "Export opens the export sheet; on a phone, hold the + and slide down, then let go on Export. Nothing is written until you choose where to save it." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "app.install",
    title: "Install this app on the device",
    routes: ["/settings"],
    requires: ["install.offered"],
    guide: [
      "guide/1",
      'goal "app.install"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.install" "This keeps the vault as an installed app, with no browser chrome." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "client.support",
    title: "Ask in-product support",
    routes: [],
    guide: [
      "guide/1",
      'goal "client.support"',
      'say "Support has two halves. Ask answers a question about the screen — in your own words when a model is available, from the written help when not. Tutorials lists every walkthrough, and each can be replayed."',
      'focus "shell.support" "Press this to open it. It is always one press away." side=right',
      'wait target "shell.support" event=activate timeout=30000',
      'success "Ask a question, or choose a tutorial from the list."',
      "end",
    ].join("\n"),
  },
  ...SHELL_GOALS,
  ...FEATURE_GOALS,
];

/** Authored help whose walkthrough is a core goal. */
export const CORE_HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "help.lock",
    title: "Where do I lock the vault?",
    answer:
      "The lock sits beside your profile and vault switcher, in the sidebar or the phone header. Locking drops the vault keys held in memory; your enrolled unlock method opens it again. Settings → Security can also lock automatically after a period of inactivity.",
    routes: [],
    goal: "vault.lock",
    keywords: [
      "lock",
      "locking",
      "logout",
      "log out",
      "sign out",
      "leave",
      "away",
      "idle",
      "auto-lock",
    ],
  },
  {
    id: "help.health",
    title: "How do I tell whether OpenSesame is healthy?",
    answer:
      "Vault health, under Vault, lists weak, reused and aging credentials.",
    routes: [],
    goal: "host.health.check",
    keywords: [
      "health",
      "healthy",
      "status",
      "reachable",
      "online",
      "down",
      "connectivity",
      "plane",
      "statusline",
      "working",
    ],
  },
  {
    id: "help.vault.item.create",
    title: "How do I add an account or a secret?",
    answer:
      "Vault → New item. The kind follows whichever filter is active, so narrowing to Accounts first gives you an account. Everything you enter — the name and the folder as much as the secret — is encrypted into the vault body on this device.",
    routes: [],
    goal: "vault.item.create",
    keywords: [
      "login",
      "account",
      "secret",
      "password",
      "item",
      "entry",
      "credential",
      "new",
      "create",
      "store",
      "save",
      "api key",
      "note",
      "card",
    ],
  },
  {
    id: "help.vault.health.review",
    title: "Which of my passwords are weak or reused?",
    answer:
      "Vault → Health scores every stored password for strength, reuse and age. It runs entirely on this device over the already-decrypted collection: no password, and no hash of one, is sent anywhere.",
    routes: [],
    goal: "vault.health.review",
    keywords: [
      "weak",
      "reused",
      "reuse",
      "old",
      "aging",
      "strength",
      "audit",
      "health",
      "report",
      "compromised",
      "score",
    ],
  },
  {
    id: "help.settings.security.review",
    title: "Where are the unlock settings?",
    answer:
      "Settings → Security. It holds the unlock methods enrolled on this device — passkey and PIN — and the second steps asked after one. A new vault is sealed with a passkey; a master password is never added, and an older vault that still has one can remove it once a passkey is enrolled.",
    routes: [],
    goal: "settings.security.review",
    keywords: [
      "unlock",
      "master password",
      "passphrase",
      "pin",
      "passkey",
      "biometric",
      "security",
      "change password",
      "reset",
      "settings",
      "lock timer",
    ],
  },
  ...SETUP_HELP,
  ...SHELL_HELP,
  ...ITEM_REFERENCE_HELP,
];

/**
 * Authored help whose walkthrough is an optional capability's goal. A topic
 * is live exactly when its goal is: a help answer never names a screen the
 * plan does not have, and no second contribution kind is needed for it.
 */
export const OPTIONAL_HELP_TOPICS: readonly HelpTopic[] = [
  ...CONNECTIONS_HELP,
  ...ACCESS_HELP,
  ...AUTHORITY_HELP,
  ...IDENTITY_HELP,
];

let contributedGoals: readonly GuideGoalDescriptor[] | null = null;

/** The live goals: core plus contributed. A live binding; see `mergedGuideGoals`. */
export let GUIDE_GOALS: readonly GuideGoalDescriptor[] = CORE_GUIDE_GOALS;
/** The live help: core topics plus the optional ones whose goal is live. */
export let HELP_TOPICS: readonly HelpTopic[] = CORE_HELP_TOPICS;

export function mergedGuideGoals(): readonly GuideGoalDescriptor[] {
  const contributed = contributionsSnapshot("tutorial-goal");
  if (contributed === contributedGoals) return GUIDE_GOALS;
  contributedGoals = contributed;
  const seen = new Set(CORE_GUIDE_GOALS.map((goal) => goal.id));
  const extra: GuideGoalDescriptor[] = [];
  for (const goal of contributed) {
    if (seen.has(goal.id)) continue;
    seen.add(goal.id);
    extra.push(goal);
  }
  GUIDE_GOALS =
    extra.length === 0
      ? CORE_GUIDE_GOALS
      : Object.freeze([...CORE_GUIDE_GOALS, ...extra]);
  HELP_TOPICS =
    extra.length === 0
      ? CORE_HELP_TOPICS
      : Object.freeze([
          ...CORE_HELP_TOPICS,
          ...OPTIONAL_HELP_TOPICS.filter(
            (topic) => topic.goal !== null && seen.has(topic.goal),
          ),
        ]);
  return GUIDE_GOALS;
}

export function mergedHelpTopics(): readonly HelpTopic[] {
  mergedGuideGoals();
  return HELP_TOPICS;
}

/** A requirement holds only when its predicate is declared and true now. */
function guidePredicateHolds(id: string): boolean {
  return isKnownGuidePredicate(id) && readGuidePredicate(id);
}

export function describeGuideGoals(
  route: GuideRouteId,
): readonly SupportGoalDescription[] {
  return mergedGuideGoals()
    .filter((goal) => goal.libraryOnly !== true)
    .filter((goal) => (goal.requires ?? []).every(guidePredicateHolds))
    .filter((goal) => scopeApplies(goal.routes, route))
    .map((goal) => ({ id: goal.id, title: goal.title }));
}

export function guideGoalIds(): readonly GuideGoalId[] {
  return mergedGuideGoals().map((goal) => goal.id);
}

export function guideGoal(id: GuideGoalId): GuideGoalDescriptor | null {
  return mergedGuideGoals().find((goal) => goal.id === id) ?? null;
}

/** Authored topics relevant to where the person currently is. */
export function helpTopicsForRoute(route: GuideRouteId): readonly HelpTopic[] {
  return mergedHelpTopics().filter((topic) =>
    scopeApplies(topic.routes, route),
  );
}
