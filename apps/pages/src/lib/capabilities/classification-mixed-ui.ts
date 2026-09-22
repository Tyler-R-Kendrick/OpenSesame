/**
 * Mixed modules under `src/screens`, `src/sections`, `src/tutorial` and
 * `src/webmcp` (continuation of `classification-mixed.ts`).
 */

import type { MixedModule } from "./classification.js";

export const MIXED_SCREENS_AND_SECTIONS: readonly MixedModule[] = [
  {
    path: "src/screens/SetupScreen.tsx",
    keeps: "tour frame, foot keys, KeepIt",
    extract: [
      {
        capability: "settings.core",
        what: "STEPS static tabs → setup-panel contributions (S09)",
      },
    ],
  },
  {
    path: "src/screens/FederationReturn.tsx",
    keeps: "OIDC return for the compiled-in road",
    extract: [
      {
        capability: "identity.ambient-sso",
        what: "applyAmbientReturn/isAmbientIntent",
      },
    ],
  },
  {
    path: "src/screens/unlock/SignInSocialBar.tsx",
    keeps: "the compiled-in provider button and guest",
    extract: [
      { capability: "identity.federation", what: "operator provider buttons" },
    ],
  },
  {
    path: "src/sections/SettingsSectionNav.tsx",
    keeps: "General, Security, Vaults, Danger tabs and panels",
    extract: [
      {
        capability: "connectors.external",
        what: "'connections' tab → settings-category contribution",
      },
      { capability: "support.local-ai", what: "ModelProviderPanel slot" },
    ],
  },
  {
    path: "src/sections/SettingsSection.tsx",
    keeps: "category routing, raw editor",
    extract: [
      { capability: "backup.cloud-secrets", what: "AgeKeysPanel" },
      {
        capability: "vault.interop-formats",
        what: "FormatsInteroperabilityPanel",
      },
      { capability: "connectors.external", what: "FeatureBindingsPanel" },
    ],
  },
  {
    path: "src/sections/settings/page-tree.ts",
    keeps: "core tabs' headings",
    extract: [
      {
        capability: "settings.core",
        what: "optional panels' headings → settings-category contributions",
      },
    ],
  },
  {
    path: "src/sections/settings/VaultKeyProtectionCeremonies.tsx",
    keeps: "nothing core — classified backup.cloud-secrets",
    extract: [
      {
        capability: "vault.local-unlock",
        what: "password/PIN/passkey ceremonies stay core; cloud ones move",
      },
    ],
  },
  {
    path: "src/sections/IdentitySection.tsx",
    keeps: "tabs frame (identity.local-iam)",
    extract: [
      {
        capability: "identity.federation",
        what: "directory.ts/byo/federation provider panels",
      },
      {
        capability: "enterprise.directory-provisioning",
        what: "Identity API users/agents/devices",
      },
    ],
  },
  {
    path: "src/components/IdentityTree.tsx",
    keeps: "local IAM tabs",
    extract: [
      {
        capability: "enterprise.directory-provisioning",
        what: "Identity-API-only leaves",
      },
    ],
  },
  {
    path: "src/tutorial/session.ts",
    keeps: "support session, guide runtime wiring",
    extract: [
      { capability: "support.local-ai", what: "prompt-api agent import" },
      {
        capability: "support.remote-ai",
        what: "ag-ui + provider agent imports; chooseSupportAgent over contributions",
      },
    ],
  },
  {
    path: "src/webmcp/tools.ts",
    keeps: "core tools (status, navigate, vault, settings read)",
    extract: [
      {
        capability: "wallet.spending",
        what: "WALLET_TOOLS spread → webmcp-tool contributions",
      },
      {
        capability: "connectors.external",
        what: "opensesame_connections_read / open_connect_ceremony",
      },
      {
        capability: "support.guided-help",
        what: "opensesame_help / guide_start",
      },
      {
        capability: "access.authority",
        what: "local-share-reach dynamic imports",
      },
    ],
  },
  {
    path: "src/screens/setup/steps/AiStep.tsx",
    keeps: "on-device choice",
    extract: [
      { capability: "support.remote-ai", what: "remote provider fields" },
    ],
  },
  {
    path: "src/lib/configuration/yaml-profile.ts",
    keeps:
      "settings YAML round trip (core) — but shares the `yaml` package with SOPS",
    extract: [
      {
        capability: "backup.cloud-secrets",
        what: "none; note `yaml` is therefore core-reachable, not exclusive",
      },
    ],
  },
];
