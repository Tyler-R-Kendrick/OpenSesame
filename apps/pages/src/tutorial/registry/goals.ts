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
  /**
   * The words a person uses for this that the title and answer do not: "user"
   * for an account, "reset" for a master password. Retrieval is lexical and
   * offline, so synonyms are authored here rather than inferred anywhere.
   */
  readonly keywords: readonly string[];
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
  {
    id: "unlock.open",
    title: "Unlock the vault",
    routes: ["/unlock"],
    guide: [
      "guide/1",
      'goal "unlock.open"',
      'say "The vault is sealed on this device. First run leads with sign-in; a returning vault uses the Unlock tab for a passkey, PIN or password."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'success "Unlocked. The vault key is in memory on this device only."',
      "end",
    ].join("\n"),
  },
  {
    id: "setup.first-run",
    title: "Finish first-run setup",
    routes: ["/setup"],
    guide: [
      "guide/1",
      'goal "setup.first-run"',
      'say "This device is empty. Set it up as the operator, or join a session you were invited to."',
      'focus "setup.choose" "The operator road. It asks who may sign people in, then records that and returns to sign-in." side=bottom',
      'hint "setup.join" "Join if you were invited: a link and a code, or a public session to ask into." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "setup.operator",
    title: "Choose who signs people in",
    routes: ["/setup"],
    guide: [
      "guide/1",
      'goal "setup.operator"',
      'say "Setup is the allowlist of who may sign people in. Add the roads you want, then finish."',
      'focus "setup.ways" "Each road you add here appears on the sign-in screen. Removing all of them is a local-only vault." side=bottom',
      'hint "setup.finish" "This records the roads and returns to sign-in." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "setup.join-session",
    title: "Join a session",
    routes: ["/setup"],
    guide: [
      "guide/1",
      'goal "setup.join-session"',
      'say "Join a session you were invited to: a link and a code, or a public session to ask into."',
      'focus "setup.join" "This road never asks you to be the operator. The Host is asked for only here, because sharing reintroduces the server." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "identity.sign-in",
    title: "Sign in with an identity provider",
    routes: ["/unlock"],
    guide: [
      "guide/1",
      'goal "identity.sign-in"',
      'say "Sign-in is a ceremony against a provider this deployment already registered. On first run it is this screen; on a returning vault it is the Sign in tab. Nothing here mints a vault key."',
      'wait state "identity.connected" is=true timeout=60000',
      'success "Signed in. The vault still opens with the local unlock on this device."',
      "end",
    ].join("\n"),
  },
  {
    id: "access.grant",
    title: "Grant an agent access",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.grant"',
      'say "A grant is a delegation. The agent receives a handle, never the credential behind it."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.grant-access" "This starts the ceremony: what is shared, how narrowly, and who it is for." side=bottom',
      'wait target "access.grant-ceremony" event=appear timeout=60000',
    ].join("\n"),
  },
  {
    id: "access.claim",
    title: "Claim a grant",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.claim"',
      'say "A claim code is spent once. Claiming it happens under Identity, not Access."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/identity"',
      'wait route "/identity" timeout=15000',
      'wait state "identity.connected" is=true timeout=60000',
      'focus "identity.people" "People is where a grant minted for you is claimed." side=bottom',
      'wait target "identity.claim-access" event=appear timeout=60000',
    ].join("\n"),
  },
  {
    id: "access.relay",
    title: "Approve a relay request",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.relay"',
      'say "A running agent that needs a person stops here. Approving continues it; denying ends it."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.requests" "Pending relay asks are on Requests." side=bottom',
      'wait target "access.relay" event=appear timeout=60000',
      'hint "access.relay" "Each request is its own decision. Nothing is auto-approved." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "access.sessions.review",
    title: "Review running agent tasks",
    routes: [],
    guide: [
      "guide/1",
      'goal "access.sessions.review"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/access"',
      'wait route "/access" timeout=15000',
      'focus "access.sessions" "Sessions lists task runs against this Host, and the way to terminate one." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "identity.device.approve",
    title: "Approve a device sign-in",
    routes: [],
    guide: [
      "guide/1",
      'goal "identity.device.approve"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/identity"',
      'wait route "/identity" timeout=15000',
      'focus "identity.devices" "Device sign-ins waiting for a person are listed here." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "connection.repair",
    title: "Repair a broken connection",
    routes: [],
    guide: [
      "guide/1",
      'goal "connection.repair"',
      'say "A connection that only needs a fresh credential offers Renew. One the provider invalidated has to be authorized again."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/connections"',
      'wait route "/connections" timeout=15000',
      'focus "connections.attention" "Anything that needs a person is collected here." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.backup",
    title: "Configure backup",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.backup"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/data"',
      'wait route "/settings/data" timeout=15000',
      'focus "settings.backup" "GitHub backup holds ciphertext. The encrypted export below it is how a vault moves to another device." side=bottom',
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
      'navigate "/settings/data"',
      'wait route "/settings/data" timeout=15000',
      'focus "settings.changelog" "This is the record of the build, not a backup of the vault." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.model-provider",
    title: "Choose the password-reset model",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.model-provider"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/connectivity"',
      'wait route "/settings/connectivity" timeout=15000',
      'focus "settings.model-provider" "This chooses which plane runs the reset model, or that this deployment does not use one." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.secret-config",
    title: "Set a secret-config value",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.secret-config"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/connectivity"',
      'wait route "/settings/connectivity" timeout=15000',
      'focus "settings.secret-configs" "Values go in and never come back out. The list is keys and metadata only." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.sync",
    title: "Replicate the sealed store",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.sync"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/connectivity"',
      'wait route "/settings/connectivity" timeout=15000',
      'focus "settings.sync-targets" "Each target is a replica of ciphertext. Triggering a run copies; it does not decrypt." side=bottom',
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
      'navigate "/settings/data"',
      'wait route "/settings/data" timeout=15000',
      'focus "settings.item-types" "A type is a JSON manifest. Installing one does not run code." side=bottom',
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
      'navigate "/settings/data"',
      'wait route "/settings/data" timeout=15000',
      'focus "vault.export" "The export is the sealed body plus its wrapping header. The master password still opens it." side=bottom',
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
      'focus "shell.support" "This question mark is on every screen. Ask how to do something, and a walkthrough will point at the control." side=right',
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
      "Two different questions, two places. The statusline reports whether the Host plane and the Identity plane are reachable. Vault health, under Vault, reports on the items themselves — weak, reused and aging credentials.",
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
    id: "help.connection.create",
    title: "How do I connect a provider?",
    answer:
      "Connections → Add a connection. Search the catalog, open the provider's page, and approve it once on its Authorization panel. The credential is sealed on the Host; projects and agents are bound to the connection afterwards, and never receive the credential itself.",
    routes: [],
    goal: "connection.create",
    keywords: [
      "connection",
      "connect",
      "provider",
      "integration",
      "oauth",
      "authorize",
      "link",
      "catalog",
      "github",
      "google",
      "slack",
      "api",
    ],
  },
  {
    id: "help.connection.broken",
    title: "A connection stopped working. What now?",
    answer:
      "Open that connector's page from Connections. An authorization that only needs a fresh credential offers Renew now; one the provider has invalidated has to be authorized again. If the whole list fails to load, the Host plane is the thing to check first, on the statusline.",
    routes: [],
    goal: null,
    keywords: [
      "broken",
      "stopped working",
      "failed",
      "failing",
      "error",
      "renew",
      "expired",
      "revoked",
      "reauthorize",
      "fix",
      "repair",
      "not working",
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
    answer:
      "Import sits beside New item in the Vault, and takes a .env, .csv, .json, .1pux, .zip or .kdbx export. Choosing a file hands it to the import panel under Settings → Vault data, which is also where an earlier OpenSesame export is merged back in.",
    routes: [],
    goal: null,
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
    id: "help.identity.account.add",
    title: "How do I add someone to this deployment?",
    answer:
      "Identity → Providers, then Register an IdP. People sign in through a registered identity provider, so the provider is bound first; the shipped presets cover the common enterprise issuers and a custom OIDC issuer is the fallback.",
    routes: [],
    goal: "identity.account.add",
    keywords: [
      "user",
      "users",
      "person",
      "people",
      "someone",
      "member",
      "members",
      "team",
      "invite",
      "add account",
      "account",
      "sign in",
      "sign-in",
      "idp",
      "provider",
      "register",
      "deployment",
      "onboard",
      "seat",
      "colleague",
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
    id: "help.access.grant",
    title: "How do I give an agent access to something?",
    answer:
      "Access → Grants → Grant access. You choose what is being shared, narrow what may be done with it, decide who it is for, and mint a claim code. The agent receives a delegation, never the credential behind it.",
    routes: [],
    goal: "access.grant",
    keywords: [
      "agent",
      "access",
      "grant",
      "delegate",
      "delegation",
      "share",
      "permission",
      "claim code",
      "scope",
      "allow",
      "authority",
      "token",
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
  {
    id: "help.backup",
    title: "How do I back up the vault?",
    answer:
      "Settings → Vault data. GitHub backup stores ciphertext in a repo this Host already has an app on. The encrypted export on the same page is how a vault moves to another device — the master password still opens it.",
    routes: [],
    goal: "settings.backup",
    keywords: [
      "backup",
      "back up",
      "export",
      "restore",
      "github",
      "sync",
      "copy",
      "another device",
      "recover",
      "move vault",
    ],
  },
  {
    id: "help.account.register",
    title: "How do I register a new account?",
    answer:
      "People sign in through a registered identity provider. Identity → Providers → Register an IdP binds the issuer; the sign-in screen then offers it. First-run setup is the same allowlist before anyone has unlocked.",
    routes: [],
    goal: "identity.account.add",
    keywords: [
      "register",
      "sign up",
      "signup",
      "new account",
      "create account",
      "user",
      "account",
      "join",
      "onboard",
      "enroll",
    ],
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

/**
 * Every PWA-surfaced capability names the authored walkthrough that covers it.
 * Several capabilities share a ceremony (listing connections and creating one
 * are the same screen); the map is many-to-one on purpose.
 */
export const CAPABILITY_TUTORIALS: Readonly<Record<string, GuideGoalId>> = {
  "vaults.switch": "vaults.switch",
  "host.health": "host.health.check",
  "host.health.pages": "host.health.check",
  "host.whoami": "identity.account.add",
  "daemon.status": "host.health.check",
  "tasks.list": "access.sessions.review",
  "tasks.inspect": "access.sessions.review",
  "tasks.terminate": "access.sessions.review",
  "receipts.read": "access.sessions.review",
  "delegations.list": "access.grant",
  "delegations.offers.list": "access.grant",
  "delegations.narrow": "access.grant",
  "delegations.revoke": "access.grant",
  "delegations.offers.revoke": "access.grant",
  "delegations.offers.mint": "access.grant",
  "delegations.claim": "access.claim",
  "relay.inbox": "access.relay",
  "relay.decide": "access.relay",
  "agent_identities.read": "access.sessions.review",
  "providers.list": "connection.create",
  "connections.list": "connection.create",
  "connections.inspect": "connection.create",
  "connections.create": "connection.create",
  "connections.credential.set": "connection.repair",
  "connections.bindings": "connection.create",
  "connections.remove": "connection.repair",
  "integrations.read": "connection.create",
  "certs.issue": "vault.item.create",
  "configs.browse": "settings.secret-config",
  "configs.set": "settings.secret-config",
  "sync_targets.read": "settings.sync",
  "sync_targets.trigger": "settings.sync",
  "model_plane.read": "settings.model-provider",
  "model_plane.choose": "settings.model-provider",
  "changelog.read": "settings.changelog",
  "backup.status": "settings.backup",
  "backup.target.set": "settings.backup",
  "identity.login": "identity.sign-in",
  "identity.whoami": "identity.account.add",
  "identity.admin": "identity.account.add",
  "identity.device.approve": "identity.device.approve",
  "vault.items.search": "vault.item.create",
  "vault.items.read_meta": "vault.item.create",
  "vault.items.write_meta": "vault.item.create",
  "vault.items.reveal": "vault.item.create",
  "vault.totp.code": "vault.item.create",
  "vault.item_types.list": "vault.item-types.install",
  "vault.item_types.install": "vault.item-types.install",
  "vault.export": "vault.export",
  "app.status": "host.health.check",
  "app.navigate": "client.support",
  "client.support": "client.support",
  "client.tutorial": "client.support",
  "pwa.status": "host.health.check",
  "app.install": "app.install",
  "setup.first_run": "setup.first-run",
  "shared_sessions.join_request": "setup.join-session",
};

/** Authored topics relevant to where the person currently is. */
export function helpTopicsForRoute(route: GuideRouteId): readonly HelpTopic[] {
  return HELP_TOPICS.filter(
    (topic) =>
      topic.routes.length === 0 ||
      topic.routes.some((candidate) => guideRouteWithin(route, candidate)),
  );
}

/**
 * Words that carry no topic on their own. A question is mostly these, and a
 * ranking that counted them would find every topic equally relevant.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "get",
  "have",
  "here",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "one",
  "or",
  "our",
  "should",
  "so",
  "the",
  "there",
  "this",
  "to",
  "up",
  "want",
  "we",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

/** Lowercase word stems: plural and progressive endings dropped. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function tokenize(text: string): readonly string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const word = stem(raw);
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

const KEYWORD_WEIGHT = 3;
const TITLE_WEIGHT = 2;
const ANSWER_WEIGHT = 1;
/** A keyword hit, or a title word plus anything else, is a confident match. */
const STRONG_SCORE = 3;

type IndexedTopic = {
  readonly topic: HelpTopic;
  readonly keywords: ReadonlySet<string>;
  readonly title: ReadonlySet<string>;
  readonly answer: ReadonlySet<string>;
};

const INDEX: readonly IndexedTopic[] = HELP_TOPICS.map((topic) => ({
  topic,
  keywords: new Set(topic.keywords.flatMap((keyword) => tokenize(keyword))),
  title: new Set(tokenize(topic.title)),
  answer: new Set(tokenize(topic.answer)),
}));

export type RankedHelpTopic = {
  readonly topic: HelpTopic;
  readonly score: number;
  /** Confident enough to stand in for an answer that cited nothing. */
  readonly strong: boolean;
};

function scoreTopic(indexed: IndexedTopic, words: readonly string[]): number {
  let score = 0;
  for (const word of words) {
    if (indexed.keywords.has(word)) score += KEYWORD_WEIGHT;
    else if (indexed.title.has(word)) score += TITLE_WEIGHT;
    else if (indexed.answer.has(word)) score += ANSWER_WEIGHT;
  }
  return score;
}

/**
 * The written help that answers a question, best first. Lexical, offline and
 * deterministic: a word of the question against each topic's authored
 * keywords, title and answer. This is the retrieval step that puts the
 * checked-in answer in front of a model before it is asked — and, when a model
 * cites nothing, decides whether a written answer can stand in for it.
 */
export function rankHelpTopics(
  question: string,
  route: GuideRouteId | null = null,
): readonly RankedHelpTopic[] {
  const words = tokenize(question);
  if (words.length === 0) return [];
  const ranked: RankedHelpTopic[] = [];
  for (const indexed of INDEX) {
    const { topic } = indexed;
    const scoped =
      route === null ||
      topic.routes.length === 0 ||
      topic.routes.some((candidate) => guideRouteWithin(route, candidate));
    if (!scoped) continue;
    const score = scoreTopic(indexed, words);
    if (score === 0) continue;
    ranked.push({ topic, score, strong: score >= STRONG_SCORE });
  }
  // A stable sort keeps authored order among equals.
  return ranked.sort((left, right) => right.score - left.score);
}

/**
 * Search over authored help: ranked by the words that match, with the old
 * substring match kept as the fallback so a fragment of a title still finds
 * it. No index, no model, works offline.
 */
export function searchHelpTopics(query: string): readonly HelpTopic[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return HELP_TOPICS;
  const ranked = rankHelpTopics(needle).map((entry) => entry.topic);
  if (ranked.length > 0) return ranked;
  return HELP_TOPICS.filter(
    (topic) =>
      topic.title.toLowerCase().includes(needle) ||
      topic.answer.toLowerCase().includes(needle),
  );
}
