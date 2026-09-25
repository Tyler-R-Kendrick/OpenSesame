/**
 * Roots, entry HTML, workers, components and screens.
 */

import { core, each, optional, shared } from "./classification-rule.js";

const SHELL = "shell.navigation";
const SIGNIN = "identity.brokered-signin";
const UNLOCK = "vault.local-unlock";

export const SHELL_RULES = [
  // --- executable roots ----------------------------------------------------
  core("index.html", SHELL, "the one primary HTML entry"),
  core(
    "src/main.tsx",
    null,
    "bootstrap (S05): hydrate, boot, render, register SW",
  ),
  core("src/App", SHELL, "re-export of app-root for the historical path"),
  shared("src/modules/activation", "handle bookkeeping every runtime shares"),
  shared("src/modules/signals", "lease-fenced abort union for module effects"),
  shared("src/modules/runtime-test-kit", "module runtime test kit"),
  shared(
    "src/modules/test-context",
    "fake ApprovedCapabilityContext for tests",
  ),
  shared("src/modules/tutorial-contributions", "declares live tutorial ids"),
  shared(
    "src/modules/ports-b",
    "optional context ports the wave-B runtimes read",
  ),
  shared(
    "src/modules/tutorial-pick-b",
    "picks authored tutorial ids from a shared partition",
  ),
  shared(
    "src/modules/identity-view-paths",
    "one command-path per Identity tab, for the runtime that owns the tab",
  ),
  shared(
    "src/modules/tutorial-test-realm",
    "boots a fixture realm so contributed guides render in tests",
  ),
  core("src/routes/settings/", "settings.core", "settings route modules"),
  core(
    "src/components/ShellWrappers",
    "shell.navigation",
    "nesting the wrappers approved capabilities contribute",
  ),
  core("src/vite-env.d.ts", null, "type shim"),
  core("src/styles.css", SHELL, "shared stylesheet"),
  core("src/native-controls.css", SHELL, "shared stylesheet"),
  core("src/assets/", SHELL, "fonts"),
  core(
    "src/sw.ts",
    "install.pwa",
    "core-only worker; MIXED — push handlers move to sw-push.ts",
  ),
  optional(
    "src/sw-push.ts",
    "notifications.web-push",
    "push worker variant (S08)",
  ),
  optional("src/sw/", "notifications.web-push", "worker parts (S08)"),
  core(
    "src/app-root",
    SHELL,
    "route table (S05); MIXED — optional imports move to contributions",
  ),
  core("src/bootstrap/", null, "core-only boot (S05)"),
  core("src/host/", null, "installs the app-core host before boot (ADR 0133)"),
  core("src/host", null, "the app-core host and its ports (ADR 0133)"),
  core("src/test-host", null, "the app-core test host (ADR 0133)"),
  core("src/ports", null, "the app-core port accessors (ADR 0133)"),
  core("src/no-host-import", null, "proof the core loads with no host"),
  core("src/memory-storage", null, "in-memory Web Storage for hosts"),
  core("src/browser/", null, "the browser host's ports (ADR 0133)"),
  core("src/node/", null, "the CLI host; never in a Pages build"),
  core("src/sandbox/", null, "the isolate host; never in a Pages build"),
  core("src/test-setup", null, "installs the app-core test host (ADR 0133)"),
  core("src/boot-transport", null, "boot never reaches the transport client"),
  core("src/runtime-config.shipped", null, "the shipped runtime config file"),
  core("src/bindings/", null, "React hooks over the core's stores (ADR 0133)"),
  core(
    "src/screens/capabilities/",
    "settings.core",
    "purpose cards, capability cards, review (S09)",
  ),
  optional(
    "auth/",
    "identity.ambient-sso",
    "MSAL redirect bridge HTML entry + script",
  ),
  optional(
    "src/webmcp/",
    "agents.webmcp",
    "document.modelContext registration and tools",
  ),
  optional(
    "src/webmcp/wallet-tools",
    "wallet.spending",
    "wallet's webmcp-tool contribution",
  ),
  core(
    "src/lib/capabilities/",
    null,
    "composition catalog, ownership, presets, store",
  ),

  // --- components: the shell by default ------------------------------------
  core("src/components/", SHELL, "rail, chrome, controls, status"),
  core(
    "src/components/configuration/",
    "settings.core",
    "Visual/Source editor chrome",
  ),
  ...each("src/components/", ["InstallMark", "InstallOffer"], (p) =>
    core(p, "install.pwa", "install offer surface"),
  ),
  ...each(
    "src/components/",
    ["PasskeyCeremonyNote", "VaultList", "AccountSwitcher", "ProjectSwitcher"],
    (p) => core(p, UNLOCK, "unlock / vault switching chrome"),
  ),
  ...each(
    "src/components/",
    ["PasswordGenerator", "TotpCode", "VaultRail"],
    (p) => core(p, "vault.passwords", "vault item controls"),
  ),
  shared(
    "src/components/QrCode",
    "QR renderer used by drops, pairing and second steps",
  ),
  optional(
    "src/components/AccessTree",
    "access.authority",
    "Access rail subtree",
  ),
  optional(
    "src/components/HostAuthorizationCeremony",
    "access.authority",
    "Host pairing ceremony",
  ),
  optional(
    "src/components/IdentityTree",
    "identity.local-iam",
    "Identity rail subtree; MIXED",
  ),
  optional(
    "src/components/IdentityCeremony",
    "identity.federation",
    "connect-identity ceremony",
  ),
  optional(
    "src/components/KeyVaultCeremony",
    "backup.cloud-secrets",
    "encryption connector ceremony",
  ),
  optional(
    "src/components/command-bar-mic",
    "support.local-ai",
    "speech capture control",
  ),
  ...each(
    "src/components/",
    [
      "ConnectionsNavigation",
      "ConnectionsTree",
      "ConnectorDirectoryForm",
      "connections-tree",
    ],
    (p) =>
      optional(
        p,
        "connectors.external",
        "Connections rail subtree and directory form",
      ),
  ),

  // --- screens ---------------------------------------------------------------
  core("src/screens/", SIGNIN, "front door, unlock, vaults"),
  core("src/screens/unlock/", SIGNIN, "sign-in panel and unlock form parts"),
  core("src/screens/UnlockScreen", UNLOCK, "unlock ceremony"),
  core("src/screens/unlock-screen-harness", UNLOCK, "test harness"),
  core("src/screens/unlock/StrengthMeter", UNLOCK, "unlock form part"),
  core("src/screens/unlock/CodeField", UNLOCK, "second-step code field"),
  core("src/screens/unlock/unlock-form-focus", UNLOCK, "unlock form focus"),
  core("src/screens/unlock/useCountdown", UNLOCK, "second-step countdown"),
  optional(
    "src/screens/unlock/ByoProviderSheet",
    "identity.federation",
    "BYO issuer sheet",
  ),
  core(
    "src/screens/unlock/SignInSocialBar",
    SIGNIN,
    "compiled-in road; MIXED — operator IdPs",
  ),
  core(
    "src/screens/FederationReturn",
    SIGNIN,
    "OIDC return; MIXED — ambient return path",
  ),
  core("src/screens/unlock.css", UNLOCK, "stylesheet"),
  core(
    "src/screens/SetupScreen",
    "settings.core",
    "deployment setup; MIXED — static tabs",
  ),
  core("src/screens/SetupTabs", "settings.core", "setup tab tests"),
  core("src/screens/setup", "settings.core", "setup chrome and step frame"),
  core("src/screens/setup/", "settings.core", "setup chrome and step frame"),
  optional(
    "src/screens/setup/steps/ConnectorsStep",
    "connectors.external",
    "setup connectors tab",
  ),
  optional(
    "src/screens/setup/steps/ConnectorCards",
    "connectors.external",
    "setup connectors tab",
  ),
  optional(
    "src/screens/setup/steps/AiStep",
    "support.local-ai",
    "setup AI tab; MIXED — remote",
  ),
  optional(
    "src/screens/setup/steps/IdentityStep",
    "identity.federation",
    "setup identity tab",
  ),
  optional(
    "src/screens/setup/steps/MfaStep",
    "identity.federation",
    "setup MFA delivery tab",
  ),
  optional(
    "src/screens/BrokerAuthorize",
    "identity.site-broker",
    "broker popup for relying sites",
  ),
  optional("src/screens/broker", "identity.site-broker", "broker stylesheet"),
  optional(
    "src/screens/DropClaimScreen",
    "sharing.drops",
    "drop opener, handed to the /claim route as a claim-opener (ADR 0140)",
  ),
  optional(
    "src/screens/LocalAuthorize",
    "identity.local-iam",
    "local application sign-in",
  ),
  optional(
    "src/screens/useLocalConsent",
    "identity.local-iam",
    "local application consent",
  ),
  optional("src/screens/SiopAuthorize", "identity.siop", "SIOPv2 authorize"),
];
