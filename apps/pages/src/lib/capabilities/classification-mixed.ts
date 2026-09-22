/**
 * Modules whose file mixes core and optional code. Each is classified by
 * its core side; the extraction names what its owner (S05 bootstrap, S09
 * setup, S10 shell, S11–S16 modules) must move into a capability module or
 * turn into a registered contribution before the hardened build can exclude
 * that capability.
 */

import { MIXED_SCREENS_AND_SECTIONS } from "./classification-mixed-ui.js";
import type { MixedModule } from "./classification.js";

export const MIXED_MODULES: readonly MixedModule[] = [
  {
    path: "src/app-root.tsx",
    keeps: "core routes (vault, unlock, settings), the shell Suspense frame",
    extract: [
      {
        capability: "identity.ambient-sso",
        what: "useAmbientAuthBoot → unlock-effect/background-job contribution",
      },
      {
        capability: "connectors.external",
        what: "sealPendingConnectorDirectory, hydrateVercelConnectAuth → unlock-effect",
      },
      {
        capability: "identity.site-broker",
        what: "/broker/authorize route + BrokerAuthorize → route contribution (framed:false)",
      },
      {
        capability: "sharing.drops",
        what: "/claim route + DropClaimScreen → route contribution",
      },
      {
        capability: "support.guided-help",
        what: "SupportProvider/SupportSlotProvider/SupportLauncher → section/background-job",
      },
      {
        capability: "agents.webmcp",
        what: "useWebMcp(status) → background-job contribution",
      },
      {
        capability: "access.authority",
        what: "/access routes + AccessSection → route + section contributions",
      },
      {
        capability: "connectors.external",
        what: "/connections routes (both) → route + section contributions",
      },
      {
        capability: "identity.local-iam",
        what: "/identity, /identity/authorize + IdentitySection, LocalAuthorize → routes",
      },
      {
        capability: "identity.siop",
        what: "/identity/siop + SiopAuthorize → route contribution",
      },
      {
        capability: "wallet.spending",
        what: "/wallet routes + WalletSection → route + section",
      },
      {
        capability: "activity.log",
        what: "/activity + ActivitySection → route + section",
      },
    ],
  },
  {
    path: "src/sw.ts",
    keeps: "shell caching, COOP/COEP headers, runtime-config network-first",
    extract: [
      {
        capability: "notifications.web-push",
        what: "push + notificationclick handlers → src/sw-push.ts (S08)",
      },
    ],
  },
  {
    path: "src/components/RailRows.tsx",
    keeps: "TreeRow, SectionRow, the core SECTIONS (vault, settings)",
    extract: [
      {
        capability: "connectors.external",
        what: "SECTIONS[1] connections row → section contribution",
      },
      { capability: "access.authority", what: "SECTIONS[2] access row" },
      { capability: "identity.local-iam", what: "SECTIONS[3] identity row" },
      { capability: "wallet.spending", what: "SECTIONS[4] wallet row" },
      { capability: "activity.log", what: "SECTIONS[5] activity row" },
      {
        capability: "vault.passkey-records",
        what: "KIND_SEGMENTS passkeys → item-kind contribution",
      },
      {
        capability: "sharing.drops",
        what: "KIND_SEGMENTS drops → item-kind contribution",
      },
      {
        capability: "vault.certificate-records",
        what: "KIND_SEGMENTS certs → item-kind contribution",
      },
    ],
  },
  {
    path: "src/components/AppShell.tsx",
    keeps: "Shell chrome, NavTree over contributions, SessionPrompt",
    extract: [
      {
        capability: "connectors.external",
        what: "ConnectionsTree/ConnectionsNavigation → section.Tree contribution",
      },
      { capability: "access.authority", what: "AccessTree → section.Tree" },
      { capability: "identity.local-iam", what: "IdentityTree → section.Tree" },
      {
        capability: "wallet.spending",
        what: "WALLET_CATEGORIES leaf rows → section.Tree",
      },
    ],
  },
  {
    path: "src/lib/keymap.ts",
    keeps: "chord engine, core jumps (g v, g s)",
    extract: [
      {
        capability: "shell.navigation",
        what: "g c/a/i/w/y jumps → keymap-jump contributions from each section owner",
      },
    ],
  },
  {
    path: "src/lib/crumbs.ts",
    keeps: "crumb builder, SETTINGS_CATEGORIES core entries",
    extract: [
      {
        capability: "wallet.spending",
        what: "WALLET_CATEGORIES/labels → command-path contribution",
      },
      {
        capability: "connectors.external",
        what: "settings 'connections' category → settings-category contribution",
      },
    ],
  },
  {
    path: "src/lib/section-view-names.ts",
    keeps: "nothing core — `useSectionView` stays in section-views.ts",
    extract: [
      { capability: "access.authority", what: "ACCESS_VIEWS/LABELS" },
      { capability: "identity.local-iam", what: "IDENTITY_VIEWS/LABELS" },
    ],
  },
  {
    path: "src/lib/access-routes.ts",
    keeps:
      "nothing core — move whole file with access.authority once section-views splits",
    extract: [
      {
        capability: "access.authority",
        what: "accessPath/accessViewFromLocation",
      },
    ],
  },
  {
    path: "src/lib/federation.ts",
    keeps:
      "compiled-in broker road (defaultUpstream, beginSignIn, completeSignIn, session store)",
    extract: [
      {
        capability: "identity.federation",
        what: "operator IdP legs (signInMethods/OperatorIdp branches, origin-profile flow)",
      },
      {
        capability: "identity.ambient-sso",
        what: "ambient-auth imports (parseAuthCallback, restoration, generation)",
      },
    ],
  },
  {
    path: "src/lib/providers.ts",
    keeps: "compiled-in browser-capable upstream (Shoo, reference IdP)",
    extract: [
      {
        capability: "identity.federation",
        what: "Identity-API provider catalogue fetch and brokered entries",
      },
    ],
  },
  {
    path: "src/lib/identity.ts",
    keeps: "Identity session, identityBase/identityFetch, restoreSession",
    extract: [
      {
        capability: "access.authority",
        what: "hostFetch / Host base handling → egress port",
      },
    ],
  },
  {
    path: "src/lib/settings.ts",
    keeps: "General/Security prefs, core endpoints",
    extract: [
      {
        capability: "connectors.external",
        what: "capabilityConnectors bindings",
      },
      {
        capability: "identity.federation",
        what: "signInMethods / OperatorIdp records",
      },
      { capability: "support.local-ai", what: "model roles" },
    ],
  },
  {
    path: "src/lib/model-provider.ts",
    keeps: "nothing core — classified support.local-ai",
    extract: [
      {
        capability: "support.remote-ai",
        what: "remote provider endpoints/API keys and the provider agent selection",
      },
    ],
  },
  {
    path: "src/lib/activity-log.ts",
    keeps: "append API (shared)",
    extract: [
      {
        capability: "activity.log",
        what: "listActivityEvents/subscribeActivity readers → module",
      },
    ],
  },
  {
    path: "src/lib/vault/model.ts",
    keeps: "item model, login/note/card/secret kinds",
    extract: [
      {
        capability: "vault.passkey-records",
        what: "passkey kind fields/labels → item-kind contribution",
      },
      { capability: "vault.certificate-records", what: "certificate kind" },
      { capability: "sharing.drops", what: "drop kind" },
    ],
  },
  {
    path: "src/lib/vault/protection/index.ts",
    keeps: "device-local, password/PIN, webauthn-prf adapters",
    extract: [
      {
        capability: "backup.cloud-secrets",
        what: "aws/gcp/azure/age/yubikey adapter registrations → protector contributions",
      },
    ],
  },
  {
    path: "src/lib/local-passkey-prf.ts",
    keeps: "nothing core — classified identity.local-iam",
    extract: [
      {
        capability: "vault.local-unlock",
        what: "unwrapVaultKeyWithPrf call site stays core; local passkey lookup moves",
      },
    ],
  },
  {
    path: "src/lib/device-identity.ts",
    keeps: "identityBase resolution to remote or in-tab host",
    extract: [
      {
        capability: "identity.local-iam",
        what: "deviceIdentityFetch branch → module-provided port",
      },
    ],
  },
  {
    path: "src/lib/command-bar/execute.ts",
    keeps: "core commands (navigate, lock, settings)",
    extract: [
      {
        capability: "shell.navigation",
        what: "optional section commands → command-path contributions",
      },
    ],
  },
  ...MIXED_SCREENS_AND_SECTIONS,
];
