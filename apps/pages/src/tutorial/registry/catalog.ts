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

import { GUIDE_TARGETS_MORE } from "./catalog-more.js";
import { IDENTITY_TARGETS } from "./identity-catalog.js";
import { SHELL_TARGETS } from "./shell-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";
import { VAULT_TARGETS } from "./vault-catalog.js";

export const GUIDE_TARGETS: readonly GuideTargetDescriptor[] = [
  ...SHELL_TARGETS,
  ...VAULT_TARGETS,

  // ── Connections: the catalog, the connected list, one connector's page ─
  {
    id: "connections.reload",
    description:
      "Re-reads the connection list. Use it after finishing an authorization somewhere else.",
    role: "action",
    routes: ["/connections"],
    capabilityId: "connections.list",
  },
  {
    id: "connections.connected",
    description:
      "The Connected panel: every provider connection this device currently holds, with its state and a way into its settings.",
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
      "The / search command over the provider catalog. Matches a provider name, a category or a connector identifier.",
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

  // ── Access: the grantor's six views ───────────────────────────────────
  {
    id: "access.grants",
    description:
      "The Grants tab: local application grants and optional delegations, their scope and expiry, with confirmed revocation.",
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
      "The Sessions tab: agent task runs currently executing on this device, and the way to terminate one.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "tasks.list",
  },
  {
    id: "access.connectors",
    description:
      "The Connectors tab: connectors read by reference from a Nango-compatible directory or brokered by OpenSesame, and who is bound to each — sync the directory, then Bind under a row.",
    role: "navigation",
    routes: ["/access"],
    capabilityId: "connectors.bind",
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

  ...IDENTITY_TARGETS,

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
    id: "settings.connections",
    description:
      "The Connections settings category: feature bindings for identity, backup and recovery, encryption, and the other capability families.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.security",
    description:
      "The Security settings category: the keys that open this vault, the second steps asked after one, and the recovery codes — each a row with one action that opens the one sheet.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.age-keys",
    description: "Age recipients and identities for this vault.",
    role: "action",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.vault-key-protection",
    description:
      "Vault key protection under Security: enrolled methods that can unlock this vault alone, and setup intent that is not yet enrolled.",
    role: "action",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.formats-interoperability",
    description:
      "Formats under Security: native, age, SOPS, and GPG with separate read, write, and runtime indicators.",
    role: "action",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.second-step",
    description:
      "The Second step list under Security: the authenticator app, and the email and text codes your sign-in service sends as fallbacks. Each row's Add opens the sheet; nothing turns on until a code from the new method matches.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "vault.second_step.code",
  },
  {
    id: "settings.recovery",
    description:
      "The Recovery row under Security: ten one-time codes that stand in for the second step once each, made with the first second step and shown once; View shows the ones left.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "vault.recovery_codes",
  },
  {
    id: "settings.vaults",
    description:
      "The Vaults settings category: every vault this device holds — the personal tomb, one per project, the guest tomb — and the way to open, create or remove one (ADR 0089).",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: null,
  },
  {
    id: "settings.connectivity",
    description:
      "The Connections settings page: core status, the active project, models, and feature bindings.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "host.health.pages",
  },
  {
    id: "settings.data",
    description:
      "There is no Vault data settings category. Folders, backup, and the build record live with the surfaces that own them.",
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

  // ── Statusline detail: the two planes and the health notice ───────────
  {
    id: "connectivity.host",
    description:
      "The identity glyph on the statusline. Its colour reports reachability, and pressing it opens the ceremony that repairs the connection.",
    role: "ceremony",
    routes: [],
    capabilityId: "host.health.pages",
  },
  {
    id: "connectivity.identity",
    description:
      "The sign-in glyph on the statusline. Pressing it opens the ceremony that signs in or reports the session already held.",
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

  ...GUIDE_TARGETS_MORE,
];
