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
import { type GuideRouteId, guideRouteWithin } from "./routes.js";

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
  /** Goal to offer alongside the answer, when one applies. */
  readonly goal: GuideGoalId | null;
};

export const GUIDE_GOALS: readonly GuideGoalDescriptor[] = [
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
    id: "host.health.check",
    title: "Check whether OpenSesame is healthy",
    routes: [],
    guide: [
      "guide/1",
      'goal "host.health.check"',
      'focus "shell.connectivity" "Plane truth lives here: Host and Identity report their reachability on the statusline." side=top',
      'say "For the vault contents themselves, Vault health lists weak, reused and aging items."',
      'navigate "/vault/health"',
      'wait route "/vault/health" timeout=15000',
      'success "This is Vault health."',
      "end",
    ].join("\n"),
  },
  {
    id: "connection.create",
    title: "Connect a provider",
    routes: [],
    guide: [
      "guide/1",
      'goal "connection.create"',
      'say "A provider connection is approved once. Every project and agent bound to it uses that authorization, and none of them ever holds the credential."',
      'navigate "/connections"',
      'wait route "/connections" timeout=15000',
      'focus "connections.provider-picker" "Find the provider here — a name, a category or a connector id all match." side=bottom',
      'wait target "connections.authorize" event=appear timeout=60000',
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
    id: "identity.account.add",
    title: "Add an account to this deployment",
    routes: [],
    guide: [
      "guide/1",
      'goal "identity.account.add"',
      'say "Accounts are vouched for by an identity provider, so a provider is registered before anyone signs in through it."',
      'navigate "/identity"',
      'wait route "/identity" timeout=15000',
      'focus "identity.providers" "Providers lists whoever may vouch for people here." side=bottom',
      'wait target "identity.register-idp" event=activate timeout=60000',
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
];

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "help.lock",
    title: "Where do I lock the vault?",
    answer:
      "The lock sits on the right of the statusline, and on the top bar on a phone. Locking drops the vault keys held in memory; your master password opens it again. Settings → Security can also lock automatically after a period of inactivity.",
    routes: [],
    goal: "vault.lock",
  },
  {
    id: "help.health",
    title: "How do I tell whether OpenSesame is healthy?",
    answer:
      "Two different questions, two places. The statusline reports whether the Host plane and the Identity plane are reachable. Vault health, under Vault, reports on the items themselves — weak, reused and aging credentials.",
    routes: [],
    goal: "host.health.check",
  },
  {
    id: "help.connection.create",
    title: "How do I connect a provider?",
    answer:
      "Connections → Add a connection. Search the catalog, open the provider's page, and approve it once on its Authorization panel. The credential is sealed on the Host; projects and agents are bound to the connection afterwards, and never receive the credential itself.",
    routes: [],
    goal: "connection.create",
  },
  {
    id: "help.connection.broken",
    title: "A connection stopped working. What now?",
    answer:
      "Open that connector's page from Connections. An authorization that only needs a fresh credential offers Renew now; one the provider has invalidated has to be authorized again. If the whole list fails to load, the Host plane is the thing to check first, on the statusline.",
    routes: [],
    goal: null,
  },
  {
    id: "help.vault.item.create",
    title: "How do I add a login or a secret?",
    answer:
      "Vault → New item. The kind follows whichever filter is active, so narrowing to Logins first gives you a login. Everything you enter — the name and the folder as much as the secret — is encrypted into the vault body on this device.",
    routes: [],
    goal: "vault.item.create",
  },
  {
    id: "help.vault.import",
    title: "How do I bring items in from another password manager?",
    answer:
      "Import sits beside New item in the Vault, and takes a .env, .csv, .json, .1pux, .zip or .kdbx export. Choosing a file hands it to the import panel under Settings → Vault data, which is also where an earlier OpenSesame export is merged back in.",
    routes: [],
    goal: null,
  },
  {
    id: "help.vault.health.review",
    title: "Which of my passwords are weak or reused?",
    answer:
      "Vault → Health scores every stored password for strength, reuse and age. It runs entirely on this device over the already-decrypted collection: no password, and no hash of one, is sent anywhere.",
    routes: [],
    goal: "vault.health.review",
  },
  {
    id: "help.identity.account.add",
    title: "How do I add someone to this deployment?",
    answer:
      "Identity → Providers, then Register an IdP. People sign in through a registered identity provider, so the provider is bound first; the shipped presets cover the common enterprise issuers and a custom OIDC issuer is the fallback.",
    routes: [],
    goal: "identity.account.add",
  },
  {
    id: "help.settings.security.review",
    title: "Where are the unlock and master-password settings?",
    answer:
      "Settings → Security. It holds the unlock methods enrolled on this device — password, PIN, passkey — and the master password they are wrapped under. Changing the master password re-wraps the vault key; it does not re-encrypt your items.",
    routes: [],
    goal: "settings.security.review",
  },
  {
    id: "help.access.grant",
    title: "How do I give an agent access to something?",
    answer:
      "Access → Grants → Grant access. You choose what is being shared, narrow what may be done with it, decide who it is for, and mint a claim code. The agent receives a delegation, never the credential behind it.",
    routes: [],
    goal: null,
  },
];

export function describeGuideGoals(
  route: GuideRouteId,
): readonly SupportGoalDescription[] {
  return GUIDE_GOALS.filter(
    (goal) =>
      goal.routes.length === 0 ||
      goal.routes.some((candidate) => guideRouteWithin(route, candidate)),
  ).map((goal) => ({ id: goal.id, title: goal.title }));
}

export function guideGoalIds(): readonly GuideGoalId[] {
  return GUIDE_GOALS.map((goal) => goal.id);
}

export function guideGoal(id: GuideGoalId): GuideGoalDescriptor | null {
  return GUIDE_GOALS.find((goal) => goal.id === id) ?? null;
}

/** Authored topics relevant to where the person currently is. */
export function helpTopicsForRoute(route: GuideRouteId): readonly HelpTopic[] {
  return HELP_TOPICS.filter(
    (topic) =>
      topic.routes.length === 0 ||
      topic.routes.some((candidate) => guideRouteWithin(route, candidate)),
  );
}

/** Substring search over authored help. No index, no model, works offline. */
export function searchHelpTopics(query: string): readonly HelpTopic[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return HELP_TOPICS;
  return HELP_TOPICS.filter(
    (topic) =>
      topic.title.toLowerCase().includes(needle) ||
      topic.answer.toLowerCase().includes(needle),
  );
}
