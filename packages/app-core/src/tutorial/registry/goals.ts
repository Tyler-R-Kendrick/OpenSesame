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
import { IDENTITY_HELP } from "./identity-goals.js";
import { type GuideRouteId, guideRouteWithin } from "./routes.js";
import { SETUP_GOALS, SHELL_GOALS, TRANSPORT_GOALS } from "./setup-goals.js";
export { CAPABILITY_TUTORIALS } from "./capability-tutorials.js";
export type GuideGoalDescriptor = {
  readonly id: GuideGoalId;
  readonly title: string;
  /** Routes where offering this goal makes sense; empty means everywhere. */
  readonly routes: readonly GuideRouteId[];
  /**
   * A checked-in GuideLang program. Runs verbatim when no model can answer,
   * and is parsed and validated by exactly the same pipeline model output
   * goes through — an authored guide gets no privileged path.
   */
  readonly guide: string;
};

export type HelpTopic = {
  readonly id: string;
  readonly title: string;
  /** Authored answer shown when there is no model to ask. */
  readonly answer: string;
  readonly routes: readonly GuideRouteId[];
  /** Authored walkthrough that answers this question in tutorial mode. */
  readonly goal: GuideGoalId;
  /**
   * The words a person uses for this that the title and answer do not: "user"
   * for an account, "reset" for a master password. Retrieval is lexical and
   * offline, so synonyms are authored here rather than inferred anywhere.
   */
  readonly keywords: readonly string[];
};

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
      'say "Locking drops the keys held in memory; the master password opens it again."',
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
    guide: [
      "guide/1",
      'goal "vaults.switch"',
      'say "A device can hold several vaults: the personal one, one per project, and a guest session beside them. Switching locks the open vault unless the other shares its key."',
      'focus "prompt.tomb" "This segment names the open vault. Press it to see every vault on this device." side=bottom',
      'wait target "prompt.tomb" event=activate timeout=30000',
      'say "Each row says when it was sealed and whether it opens without a prompt. Settings → Vaults is where a vault is sealed with a choice, or deleted."',
      "end",
    ].join("\n"),
  },
  {
    id: "host.health.check",
    title: "Check whether OpenSesame is healthy",
    routes: [],
    guide: [
      "guide/1",
      'goal "host.health.check"',
      'focus "shell.connectivity" "Connectivity lives here: the statusline reports whether identity on this device is ready." side=top',
      'say "For the vault contents themselves, Vault health lists weak, reused and aging items."',
      'navigate "/vault/health"',
      'wait route "/vault/health" timeout=15000',
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
      'focus "vault.create" "This opens the editor for the kind the current filter names — a login unless you narrowed the list." side=bottom',
      'wait target "vault.create" event=activate timeout=60000',
    ].join("\n"),
  },
  {
    id: "vault.health.review",
    title: "Review password health",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.health.review"',
      'say "Health is computed here, over the decrypted collection. No password, and no hash of one, leaves this device."',
      'navigate "/vault/health"',
      'wait route "/vault/health" timeout=15000',
      'annotate "vault.health.summary" "The verdict: how many passwords were reviewed, and how many are weak, reused or aging." side=bottom',
      'hint "vault.health.findings" "Each finding says why it was flagged, and opens that item for editing." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.security.review",
    title: "Review the security settings",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.security.review"',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'say "Security holds the unlock methods enrolled on this device, and the master password those unlocks are wrapped under."',
      'focus "settings.master-password" "Changing it re-wraps the vault key. No item is re-encrypted, and nothing is re-uploaded." side=top',
      "end",
    ].join("\n"),
  },
  ...SETUP_GOALS,
  {
    id: "identity.sign-in",
    title: "Sign in with an identity provider",
    routes: ["/unlock"],
    guide: [
      "guide/1",
      'goal "identity.sign-in"',
      'say "Sign-in is a ceremony against a provider this deployment already registered. On first run it is this screen; on a returning vault it is Sign in in the user menu. Nothing here mints a vault key."',
      'wait state "identity.connected" is=true timeout=60000',
      'success "Signed in. The vault still opens with the local unlock on this device."',
      "end",
    ].join("\n"),
  },
  {
    id: "identity.sign-out",
    title: "Sign out of this device",
    routes: [],
    guide: [
      "guide/1",
      'goal "identity.sign-out"',
      'say "Signing out ends the account on this device: the Identity session is revoked, the upstream sign-in is forgotten, and the vault locks. The vault key is a separate thing — locking alone keeps you signed in."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'focus "shell.account" "The first segment of the prompt names the account. Open it; Sign out is the last entry." side=bottom',
      'wait target "shell.account" event=activate timeout=30000',
      'success "The unlock screen says you are signed out. Sign in again from the user menu, or continue as a guest."',
      "end",
    ].join("\n"),
  },
  {
    id: "identity.switch-account",
    title: "Sign in as somebody else",
    routes: [],
    guide: [
      "guide/1",
      'goal "identity.switch-account"',
      'say "Switching signs this device out and starts a fresh sign-in. An OpenID issuer is asked to authenticate again; a Google account through shoo.dev is the one shoo.dev remembers, and a different one means signing out at shoo.dev/me first."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'focus "shell.account" "Open the account menu and choose Switch account." side=bottom',
      'wait target "shell.account" event=activate timeout=30000',
      'success "Choose the account to sign in with from the user menu."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.second-step.code",
    title: "Add a fallback second step by email or text",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.second-step.code"',
      'say "A code by email or text is a fallback for a lost phone, not a first second step: it needs a sign-in service to send it, and anyone who can read the inbox or hold the number can read the code. Keep an authenticator app or passkey enrolled too."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.second-step" "Press Add on Email code or Text message. The sheet asks where to send it, offers your account address, sends the first code, and turns the channel on only once that code matches." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.recovery-codes",
    title: "Save the recovery codes",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.recovery-codes"',
      'say "Recovery codes stand in for the second step once each. They are made when the first second step turns on and shown once; save them somewhere the phone is not."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.recovery" "View shows which codes are left, with the used ones struck through. Make a new set replaces them all." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.changelog",
    title: "Read what this build shipped",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.changelog"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.general" "What this build shipped is not a settings page." side=bottom',
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
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.general" "A type is a JSON manifest. Installing one does not run code, and it is not a settings page." side=bottom',
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
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.general" "Moving a vault is not a settings page." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "app.install",
    title: "Install this app on the device",
    routes: ["/settings"],
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
    id: "broker.authorize",
    title: "Approve a site sign-in",
    routes: ["/broker/authorize"],
    guide: [
      "guide/1",
      'goal "broker.authorize"',
      'say "A static site cannot mint tokens. This popup asks you to approve its origin receiving an upstream assertion."',
      'focus "broker.consent" "Read the origin, then approve or deny. Nothing is granted by loading this page." side=bottom',
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
      'focus "shell.support" "Support is always one press away. Ask how to do something, and a walkthrough will point at the control." side=right',
      "end",
    ].join("\n"),
  },
  ...SHELL_GOALS,
  ...TRANSPORT_GOALS,
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
      "Two different questions, two places. The statusline reports whether identity on this device is ready. Vault health, under Vault, reports on the items themselves — weak, reused and aging credentials.",
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
    title: "How do I add a login or a secret?",
    answer:
      "Vault → New item. The kind follows whichever filter is active, so narrowing to Logins first gives you a login. Everything you enter — the name and the folder as much as the secret — is encrypted into the vault body on this device.",
    routes: [],
    goal: "vault.item.create",
    keywords: [
      "login",
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
    id: "help.vault.import",
    title: "How do I bring items in from another password manager?",
    answer: "Bringing items in from another manager is not a settings page.",
    routes: [],
    goal: "vault.import",
    keywords: [
      "import",
      "migrate",
      "bring",
      "move",
      "1password",
      "bitwarden",
      "lastpass",
      "keepass",
      "kdbx",
      "csv",
      "json",
      "env",
      "another password manager",
      "transfer",
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
    title: "Where are the unlock and master-password settings?",
    answer:
      "Settings → Security. It holds the unlock methods enrolled on this device — password, PIN, passkey — and the master password they are wrapped under. Changing the master password re-wraps the vault key; it does not re-encrypt your items.",
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
  {
    id: "help.unlock",
    title: "How do I unlock the vault?",
    answer:
      "The unlock screen is the passkey, PIN or master password challenge for this device. Signing in with an identity provider is a separate tab and does not unwrap the vault key.",
    routes: ["/unlock"],
    goal: "unlock.open",
    keywords: [
      "unlock",
      "open",
      "locked",
      "master password",
      "pin",
      "passkey",
      "get in",
      "sign in",
    ],
  },
  {
    id: "help.setup",
    title: "How do I choose who can sign in?",
    answer:
      "An empty device offers two roads: set it up as the operator, or join a session you were invited to. The operator road is the allowlist of sign-in providers; finish records it and returns to sign-in. An empty list is a local-only vault.",
    routes: ["/setup"],
    goal: "setup.first-run",
    keywords: [
      "setup",
      "set up",
      "first run",
      "operator",
      "allowlist",
      "who can sign in",
      "sign-in providers",
      "join",
      "new device",
      "install",
    ],
  },
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
          ...OPTIONAL_HELP_TOPICS.filter((topic) => seen.has(topic.goal)),
        ]);
  return GUIDE_GOALS;
}

export function mergedHelpTopics(): readonly HelpTopic[] {
  mergedGuideGoals();
  return HELP_TOPICS;
}

export function describeGuideGoals(
  route: GuideRouteId,
): readonly SupportGoalDescription[] {
  return mergedGuideGoals()
    .filter(
      (goal) =>
        goal.routes.length === 0 ||
        goal.routes.some((candidate) => guideRouteWithin(route, candidate)),
    )
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
  return mergedHelpTopics().filter(
    (topic) =>
      topic.routes.length === 0 ||
      topic.routes.some((candidate) => guideRouteWithin(route, candidate)),
  );
}
