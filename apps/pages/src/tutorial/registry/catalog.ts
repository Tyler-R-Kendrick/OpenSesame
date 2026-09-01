/**
 * The authored target catalog — every control a support guide may point at.
 *
 * These names are the vocabulary the model gets, and they are chosen the way a
 * person would describe the app rather than the way it happens to be built:
 * `nav.connections`, not `.railtree__row:nth-child(2)`. That is what lets the
 * UI be restyled or rebuilt without silently invalidating every tutorial.
 *
 * Descriptions are checked-in prose. Nothing here may interpolate a vault item
 * name, folder name, account address, connection label or any other value a
 * person authored — the whole catalog is handed to a model as page context.
 */

import type { GuideTargetDescriptor } from "./targets.js";

export const GUIDE_TARGETS: readonly GuideTargetDescriptor[] = [
  // ── Shell: the rail, the statusline and the phone chrome ──────────────
  {
    id: "nav.vault",
    description:
      "Rail entry that opens the Vault, where every stored login, passkey, card, secret and note lives.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.connections",
    description:
      "Rail entry that opens Connections, where provider connections are added, tested and revoked.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.access",
    description:
      "Rail entry that opens Access, where delegations, share offers and running agent tasks are reviewed.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.identity",
    description:
      "Rail entry that opens Identity, where accounts, upstream providers and linked identities are managed.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "nav.settings",
    description:
      "Rail entry that opens Settings, covering general preferences, security, connectivity, vault data and destructive actions.",
    role: "navigation",
    routes: [],
    capabilityId: "app.navigate",
  },
  {
    id: "shell.lock",
    description:
      "Locks the vault immediately, dropping the in-memory keys. The master password is needed to open it again.",
    role: "action",
    routes: [],
    capabilityId: null,
  },
  {
    id: "shell.notifications",
    description:
      "Statusline bell listing notices that need a person: pending links, failed syncs, expiring items.",
    role: "status",
    routes: [],
    capabilityId: null,
  },
  {
    id: "shell.connectivity",
    description:
      "Statusline strip reporting whether the Host plane and the Identity plane are reachable right now.",
    role: "status",
    routes: [],
    capabilityId: "host.health.pages",
  },
  {
    id: "shell.support",
    description:
      "Opens in-product support, where a question about the interface can be asked in plain language.",
    role: "surface",
    routes: [],
    capabilityId: "client.support",
  },
  // ── Vault: the list, its filters and the ways items get in ────────────
  {
    id: "vault.list",
    description:
      "The item list pane. Everything the vault holds is listed here, grouped by folder and narrowed by whichever filter is active.",
    role: "surface",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.create",
    description:
      "Starts a new vault item of the kind the current filter names, defaulting to a login. Opens the editor; nothing is stored until it is saved.",
    role: "action",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "vault.import",
    description:
      "Opens the file picker for an import from another password manager or a .env file, then hands the chosen file to the Settings import panel.",
    role: "ceremony",
    routes: ["/vault"],
    capabilityId: "vault.items.write_meta",
  },
  {
    id: "vault.filter.favorites",
    description: "Narrows the item list to the items marked as favorites.",
    role: "filter",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.filter.logins",
    description:
      "Narrows the item list to logins. Present only while the vault holds at least one login.",
    role: "filter",
    routes: ["/vault"],
    capabilityId: "vault.items.search",
  },
  {
    id: "vault.health",
    description:
      "Opens the password health report, which scores the stored passwords for strength, reuse and age entirely on this device.",
    role: "navigation",
    routes: ["/vault"],
    capabilityId: null,
  },
  {
    id: "vault.health.summary",
    description:
      "The one-line verdict of the health report: how many passwords were reviewed, how many are clean, and how many are weak, reused or old.",
    role: "status",
    routes: ["/vault/health"],
    capabilityId: null,
  },
  {
    id: "vault.health.findings",
    description:
      "The list of items the health report wants attention on, each with the reason and a way to open its editor.",
    role: "surface",
    routes: ["/vault/health"],
    capabilityId: null,
  },

  // ── Connections: the catalog, the connected list, one connector's page ─
  {
    id: "connections.reload",
    description:
      "Re-reads the connection list from the Host. Use it after finishing an authorization somewhere else.",
    role: "action",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.connected",
    description:
      "The Connected panel: every provider connection this Host currently holds, with its state and a way into its settings.",
    role: "surface",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.attention",
    description:
      "Panel listing connections that exist but cannot be used until a person finishes their authorization. Present only while at least one is unfinished.",
    role: "status",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.catalog",
    description:
      "The Add a connection panel: the provider catalog, grouped by category. Choosing a provider opens its own page.",
    role: "surface",
    routes: ["/connections"],
    capabilityId: "providers.list",
  },
  {
    id: "connections.provider-picker",
    description:
      "Search field over the provider catalog. Matches a provider name, a category or a connector identifier.",
    role: "filter",
    routes: ["/connections"],
    capabilityId: "providers.list",
  },
  {
    id: "connections.custom",
    description:
      "Opens the form for describing a provider the catalog does not ship, so it can be connected like any other.",
    role: "ceremony",
    routes: ["/connections"],
    capabilityId: null,
  },
  {
    id: "connections.back",
    description:
      "Returns from one connector's page to the full Connections list.",
    role: "navigation",
    routes: ["/connections"],
    capabilityId: null,
  },
  {
    id: "connections.authorize",
    description:
      "The Authorization panel on a connector's page. This is where a connection is approved, or where an existing one reports what it is.",
    role: "ceremony",
    routes: ["/connections"],
    capabilityId: "connections.create",
  },
  {
    id: "connections.renew",
    description:
      "Renews the credential behind an active connection without asking for consent again. Present only while the connection can be refreshed.",
    role: "action",
    routes: ["/connections"],
    capabilityId: "connections.rotate",
  },
  {
    id: "connections.revoke",
    description:
      "Revokes a connection, cutting off every project and agent bound to it and asking the provider to invalidate the credential.",
    role: "action",
    routes: ["/connections"],
    capabilityId: "connections.remove",
  },
  {
    id: "connections.bindings",
    description:
      "The Who can use it panel: which identities, groups, devices, projects and agents may use this authorization. None of them receive the credential.",
    role: "surface",
    routes: ["/connections"],
    capabilityId: "connections.bindings",
  },

  // ── Access: the grantor's five views ──────────────────────────────────
  {
    id: "access.grants",
    description:
      "The Grants tab: delegations already handed out, what each one may do, and when it lapses.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "delegations.list",
  },
  {
    id: "access.requests",
    description:
      "The Requests tab: authorization asks waiting on a decision, alongside the offers this deployment has minted.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "relay.inbox",
  },
  {
    id: "access.sessions",
    description:
      "The Sessions tab: agent task runs currently executing against this Host, and the way to terminate one.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "tasks.list",
  },
  {
    id: "access.resources",
    description:
      "The Resources tab: the connections and registered sites that a grant can be pointed at.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connections.list",
  },
  {
    id: "access.policies",
    description:
      "The Policies tab: how broadly each authorization may be delegated and invoked.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connections.update",
  },
  {
    id: "access.grant-access",
    description:
      "Starts the grant ceremony: pick what is being shared, narrow the scope, decide who it is for, then mint a claim code.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "delegations.offers.mint",
  },

  // ── Identity: the person plane's five views ───────────────────────────
  {
    id: "identity.people",
    description:
      "The People tab: who you are here, the identities linked to you, the access you hold, and the members of your organizations.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.whoami",
  },
  {
    id: "identity.providers",
    description:
      "The Providers tab: the identity providers registered to vouch for people in this deployment.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.devices",
    description:
      "The Devices tab: device sign-ins waiting for approval, and the devices already trusted.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.device.approve",
  },
  {
    id: "identity.service-accounts",
    description:
      "The Service accounts tab: non-human identities registered for agents and automation.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.agent.register",
  },
  {
    id: "identity.organization",
    description:
      "The Organization tab: the organization this session acts in, and its settings.",
    role: "navigation",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },
  {
    id: "identity.register-idp",
    description:
      "Opens the ceremony that registers an identity provider, either from the shipped enterprise presets or as a custom OIDC issuer.",
    role: "ceremony",
    routes: ["/identity"],
    capabilityId: "identity.admin",
  },

  // ── Settings: five categories and the panels people ask about ─────────
  {
    id: "settings.general",
    description:
      "The General settings category: appearance, and how long the vault waits before locking itself.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.security",
    description:
      "The Security settings category: enrolled unlock methods and the master password.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.connectivity",
    description:
      "The Connectivity settings category: the core plane connections, the endpoints they point at, and the task bus.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "host.health.pages",
  },
  {
    id: "settings.data",
    description:
      "The Vault data settings category: folders, imports from other managers, the encrypted export, and the git sealed store.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "vault.export",
  },
  {
    id: "settings.danger",
    description:
      "The Danger settings category, which holds the irreversible action of deleting this vault from this browser.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.auto-lock",
    description:
      "Chooses how long the vault stays unlocked while idle before its key is dropped from memory.",
    role: "action",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.master-password",
    description:
      "Submits a master-password change. The vault key itself is unchanged, so no item is re-encrypted.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.core-connections",
    description:
      "The Core connections panel: the Host and Identity planes, this machine, git history and the key vault, each opening its own repair ceremony.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: "host.health.pages",
  },

  // ── Statusline detail: the two planes and the health notice ───────────
  {
    id: "connectivity.host",
    description:
      "The Host glyph on the statusline. Its colour reports reachability, and pressing it opens the ceremony that repairs or re-points the Host connection.",
    role: "ceremony",
    routes: [],
    capabilityId: "host.health.pages",
  },
  {
    id: "connectivity.identity",
    description:
      "The Identity glyph on the statusline. Pressing it opens the ceremony that signs in to the Identity plane or reports the session already held.",
    role: "ceremony",
    routes: [],
    capabilityId: "identity.whoami",
  },
  {
    id: "notifications.health",
    description:
      "Link from the notifications sheet into the password health report. Present only while the report has findings.",
    role: "navigation",
    routes: [],
    capabilityId: null,
  },

  // ── Unlock, first-run setup, broker ───────────────────────────────────
  {
    id: "unlock.submit",
    description:
      "The ink square that opens the vault — passkey, PIN or master password, whichever method is selected.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.secret",
    description:
      "The field that takes the master password or PIN used to unwrap the vault key on this device.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.passkey",
    description: "Chooses the passkey challenge as the way to open this vault.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: null,
  },
  {
    id: "unlock.signin",
    description:
      "The sign-in panel: identity providers configured for this deployment, plus the option to bring your own issuer.",
    role: "ceremony",
    routes: ["/unlock"],
    capabilityId: "identity.login",
  },
  {
    id: "vaults.list",
    description:
      "The list of vaults on this device — the personal vault, each project vault, and the guest road — where pressing a row switches to it.",
    role: "surface",
    routes: ["/unlock", "/settings/vaults"],
    capabilityId: "vaults.switch",
  },
  {
    id: "prompt.tomb",
    description:
      "The vault segment of the shell prompt (who@vault:/); opens the list of vaults on this device to switch between them.",
    role: "action",
    routes: [],
    capabilityId: "vaults.switch",
  },
  {
    id: "unlock.setup",
    description:
      "Opens optional deployment setup, where the operator chooses who may sign people in.",
    role: "ceremony",
    routes: ["/unlock"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.join",
    description:
      "Opens the join road from the sign-in screen: a claim invite or a request into a public session.",
    role: "action",
    routes: ["/unlock"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.ways",
    description:
      "The allowlist of sign-in roads: brokered providers, operators' own issuers, and an optional Identity service.",
    role: "surface",
    routes: ["/setup"],
    capabilityId: "setup.first_run",
  },
  {
    id: "setup.keep",
    description:
      "The offer to keep this app on the device — install the PWA, with no wrong answer if declined.",
    role: "action",
    routes: ["/setup"],
    capabilityId: "app.install",
  },
  {
    id: "setup.finish",
    description:
      "The ink square that finishes setup and returns to sign-in with the roads just chosen.",
    role: "action",
    routes: ["/setup"],
    capabilityId: "setup.first_run",
  },
  {
    id: "broker.consent",
    description:
      "The broker popup that asks a person to approve a static site receiving an upstream identity assertion.",
    role: "ceremony",
    routes: ["/broker/authorize"],
    capabilityId: "identity.login",
  },
  {
    id: "federation.return",
    description:
      "The screen that finishes an identity-provider redirect and lands back in the vault or on unlock.",
    role: "ceremony",
    routes: ["/federation"],
    capabilityId: "identity.login",
  },
  {
    id: "access.grant-ceremony",
    description:
      "The grant ceremony itself: pick what is shared, narrow the scope, decide who it is for, mint a claim code.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "delegations.offers.mint",
  },
  {
    id: "identity.claim-access",
    description:
      "Starts the ceremony that claims a grant minted for this person, by entering the claim code.",
    role: "ceremony",
    routes: ["/identity"],
    capabilityId: "delegations.claim",
  },
  {
    id: "access.relay",
    description:
      "Pending relay approval requests: a person decides whether a running agent may continue.",
    role: "ceremony",
    routes: ["/access"],
    capabilityId: "relay.decide",
  },
  {
    id: "settings.backup",
    description:
      "Server-side GitHub backup of the sealed store, and the offline encrypted export that moves a vault to another device.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "backup.target.set",
  },
  {
    id: "settings.changelog",
    description:
      "The in-app changelog of what this build shipped. It is a record, not a backup.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: "changelog.read",
  },
  {
    id: "settings.model-provider",
    description:
      "Chooses which plane runs the password-reset model, or that this deployment does not use one.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "model_plane.choose",
  },
  {
    id: "settings.secret-configs",
    description:
      "Write-only intake for secret-config values. Keys and metadata are listed; values never come back out.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "configs.set",
  },
  {
    id: "settings.sync-targets",
    description:
      "Replication targets for the sealed store, and the control that triggers a run.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "sync_targets.trigger",
  },
  {
    id: "settings.item-types",
    description:
      "Installs or removes a vault item type definition. Types are JSON manifests, not code paths.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "vault.item_types.install",
  },
  {
    id: "settings.install",
    description:
      "Installs this app on the device as a PWA, so it is available without a browser chrome.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "app.install",
  },
  {
    id: "vault.export",
    description:
      "Exports the sealed vault body plus its key-wrapping header, for moving to another device.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "vault.export",
  },
];
