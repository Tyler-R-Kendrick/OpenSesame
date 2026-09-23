/**
 * Sections and their sub-panels.
 */

import { core, each, optional } from "./classification-rule.js";

const CONNECTORS = "connectors.external";
const CLOUD = "backup.cloud-secrets";
const GIT = "backup.git-remote";
const LOCAL_IAM = "identity.local-iam";
const SETTINGS = "settings.core";

export const SECTION_RULES = [
  // --- vault -----------------------------------------------------------------
  core("src/sections/VaultSection", "vault.passwords", "vault section root"),
  core("src/sections/vault-section-model", "vault.passwords", "its view-model"),
  core("src/sections/vault.css", "vault.passwords", "stylesheet"),
  core(
    "src/sections/vault/",
    "vault.passwords",
    "items, editor, detail, health, filters",
  ),
  ...each(
    "src/sections/vault/",
    ["DropCeremony", "DropTtl", "NewDropCeremony"],
    (p) => optional(p, "sharing.drops", "drop ceremonies"),
  ),

  // --- connections -----------------------------------------------------------
  optional(
    "src/sections/ConnectionsSection",
    CONNECTORS,
    "connections section root",
  ),
  optional("src/sections/connections", CONNECTORS, "stylesheet"),
  optional(
    "src/sections/connections/",
    CONNECTORS,
    "catalogue, connect forms, GitHub App",
  ),
  ...each(
    "src/sections/connections/",
    [
      "AwsKms",
      "AzureKeyVault",
      "GcpKms",
      "Yubikey",
      "useAwsKmsConnect",
      "useAzureKeyVaultKeysConnect",
      "useGcpKmsConnect",
    ],
    (p) => optional(p, CLOUD, "cloud KMS / YubiKey protector panels"),
  ),
  ...each(
    "src/sections/connections/",
    ["Backup", "GithubBackupRepo", "githubBackupRepo", "useGithubBackupRepo"],
    (p) => optional(p, GIT, "git backup controls"),
  ),

  // --- access ----------------------------------------------------------------
  optional(
    "src/sections/AccessSection",
    "access.authority",
    "access section root",
  ),
  optional("src/sections/access", "access.authority", "stylesheet"),
  optional(
    "src/sections/access/",
    "access.authority",
    "grants, requests, sessions, policies",
  ),
  ...each("src/sections/access/", ["Connector", "useConnectorDirectory"], (p) =>
    optional(p, CONNECTORS, "Access › Connectors tab (directory by reference)"),
  ),

  // --- identity --------------------------------------------------------------
  optional(
    "src/sections/IdentitySection",
    LOCAL_IAM,
    "identity section root; MIXED",
  ),
  optional("src/sections/identity.css", LOCAL_IAM, "stylesheet"),
  optional("src/sections/identity-section-model", LOCAL_IAM, "its view-model"),
  optional(
    "src/sections/identity/",
    LOCAL_IAM,
    "local directory, applications, passkeys",
  ),
  ...each(
    "src/sections/identity/",
    ["UsersPanel", "AgentsPanel", "DevicesPanel"],
    (p) =>
      optional(
        p,
        "enterprise.directory-provisioning",
        "Identity API directory admin",
      ),
  ),
  ...each(
    "src/sections/identity/",
    ["ProviderRouting", "ConnectIdentityNote", "RegistrationExtras"],
    (p) => optional(p, "identity.federation", "operator provider surfaces"),
  ),

  // --- wallet / activity -----------------------------------------------------
  optional(
    "src/sections/WalletSection",
    "wallet.spending",
    "wallet section root",
  ),
  optional(
    "src/sections/wallet/",
    "wallet.spending",
    "budgets, methods, passes",
  ),
  optional(
    "src/sections/ActivitySection",
    "activity.log",
    "activity section root",
  ),

  // --- settings --------------------------------------------------------------
  core(
    "src/sections/SettingsSection",
    SETTINGS,
    "settings root; MIXED — static panels",
  ),
  core(
    "src/sections/SettingsSectionNav",
    SETTINGS,
    "tabs and panel slots; MIXED",
  ),
  core("src/sections/settings-section-nav-model", SETTINGS, "tab view-model"),
  core("src/sections/SettingsDangerPanel", SETTINGS, "Danger"),
  core(
    "src/sections/SettingsMasterPasswordPanel",
    "vault.local-unlock",
    "master password",
  ),
  core("src/sections/settings.css", SETTINGS, "stylesheet"),
  core(
    "src/sections/settings/",
    SETTINGS,
    "General, Vaults, raw editor, view toggle",
  ),
  core(
    "src/sections/settings/page-tree",
    SETTINGS,
    "rail tree; MIXED — optional panels",
  ),
  core("src/sections/settings/InstallPanel", "install.pwa", "install panel"),
  ...each(
    "src/sections/settings/",
    ["ItemTypesPanel", "item-types/", "item-type-marketplace-model"],
    (p) => core(p, "vault.passwords", "item types and their marketplaces"),
  ),
  ...each(
    "src/sections/settings/",
    [
      "UnlockMethodsPanel",
      "security/",
      "VaultKeyProtectionPanel",
      "VaultProtectorRow",
      "useVaultKeyProtectionActions",
      "vault-key-protection",
    ],
    (p) => core(p, "vault.local-unlock", "unlock methods and protectors"),
  ),
  ...each(
    "src/sections/settings/",
    [
      "AgeInteropSheet",
      "AgeKeysPanel",
      "SopsDocumentSheet",
      "SecretConfigFlash",
      "SecretConfigWriteForms",
      "VaultKeyProtectionCeremonies",
    ],
    (p) =>
      optional(p, CLOUD, "age, SOPS and cloud KMS sheets; ceremonies MIXED"),
  ),
  ...each(
    "src/sections/settings/",
    ["AiModelRoles", "ModelProviderPanel", "ai-model-roles"],
    (p) =>
      optional(
        p,
        "support.local-ai",
        "model plane and roles; MIXED — remote providers",
      ),
  ),
  optional(
    "src/sections/settings/AmbientAuthPanel",
    "identity.ambient-sso",
    "ambient SSO panel",
  ),
  ...each(
    "src/sections/settings/",
    ["FormatsInteroperabilityPanel", "import.css"],
    (p) => optional(p, "vault.interop-formats", "formats panel"),
  ),
  ...each(
    "src/sections/settings/",
    ["GithubHistoryRemotePicker", "useGithubAppDeployment"],
    (p) => optional(p, GIT, "history remote picker"),
  ),
  optional(
    "src/sections/settings/FeatureBindingsPanel",
    CONNECTORS,
    "capability → connector bindings",
  ),
];
