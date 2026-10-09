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
  core(
    "src/dev/",
    null,
    "DEV-only component gallery routes (not shipped in prod)",
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
    "src/lib/storage-",
    null,
    "what the app owns in a browser, and the halt a reset puts on writes",
  ),
  core(
    "src/sw/cache-names",
    "install.pwa",
    "the worker's cache names; Reset this browser removes only these",
  ),
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
  core(
    "src/no-source-toggle",
    null,
    "guard: no Visual/Source toggle in the client",
  ),
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
  // A capability's tool specs ship with the capability that registers them,
  // as wallet's always have: inert data until `agents.webmcp` mounts a
  // surface. What every group shares, and the stores core screens read,
  // are core — none of them loads the WebMCP SDK.
  optional(
    "src/webmcp/connections-tools",
    "connectors.external",
    "connectors' webmcp-tool contribution",
  ),
  optional(
    "src/webmcp/identity-tools",
    "identity.federation",
    "federation's webmcp-tool contribution",
  ),
  optional(
    "src/webmcp/support-tools",
    "support.guided-help",
    "guided help's webmcp-tool contribution",
  ),
  optional(
    "src/webmcp/settings-tools",
    "support.local-ai",
    "local AI's webmcp-tool contribution",
  ),
  core(
    "src/webmcp/seams",
    null,
    "the navigation and support seams the shell binds; no tool, no SDK",
  ),
  core(
    "src/webmcp/tool-shared",
    null,
    "argument readers every capability's tool group shares; no SDK",
  ),
  core(
    "src/lib/proofs/item-reach",
    null,
    "the share-reach proof the core vault tools take before an item is read (ADR 0178)",
  ),
  core(
    "src/webmcp/registration",
    null,
    "registration status store the support panel reads; written by the registrar",
  ),
  core(
    "src/webmcp/context",
    null,
    "editor-kind store the item editor publishes; read by session tools",
  ),
  core(
    "src/lib/capabilities/",
    null,
    "composition catalog, ownership, presets, store",
  ),

  // --- components: the shell by default ------------------------------------
  core("src/components/", SHELL, "rail, chrome, controls, status"),
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
    ["GeneratorOptions", "PepperPrompt", "TotpCode", "VaultRail"],
    (p) => core(p, "vault.passwords", "vault item controls"),
  ),
  shared(
    "src/components/QrCode",
    "QR renderer used by drops, pairing and second steps",
  ),
  core(
    "src/components/IdentityCeremony",
    "identity.ceremonies",
    "connect-identity ceremony the shell draws; Identity stays optional",
  ),
  optional(
    "src/components/KeyVaultCeremony",
    "backup.cloud-secrets",
    "encryption connector ceremony",
  ),
  ...each("src/components/", ["command-bar-mic", "command-bar-voice"], (p) =>
    optional(p, "support.local-ai", "speech capture control"),
  ),
  ...each(
    "src/components/",
    ["ConnectionsNavigation", "ConnectionsTree", "ConnectorDirectoryForm"],
    (p) =>
      optional(
        p,
        "connectors.external",
        "Connections rail subtree and directory form",
      ),
  ),
  core(
    "src/components/connections-tree",
    "shell.navigation",
    "stylesheet kept in the first bundle so cascade order holds",
  ),

  // --- screens ---------------------------------------------------------------
  core("src/screens/", SIGNIN, "front door, unlock, vaults"),
  core("src/screens/unlock/", SIGNIN, "sign-in panel and unlock form parts"),
  core("src/screens/UnlockScreen", UNLOCK, "unlock ceremony"),
  core("src/screens/unlock-screen-harness", UNLOCK, "test harness"),
  core("src/screens/unlock/CodeField", UNLOCK, "second-step code field"),
  core("src/screens/unlock/unlock-form-focus", UNLOCK, "unlock form focus"),
  core("src/screens/unlock/useCountdown", UNLOCK, "second-step countdown"),
  core(
    "src/screens/unlock/ByoProviderSheet",
    "identity.brokered-signin",
    "BYO issuer sheet on the sign-in panel; the Identity section stays optional",
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
  core(
    "src/lib/catalog-provider",
    "settings.core",
    "which bundled rows are catalog brokers; Settings tiles read this with Connections off",
  ),
  core(
    "src/lib/field-guidance",
    "settings.core",
    "field help the vault-key sheets draw with Connections off",
  ),
  core(
    "src/lib/connections-error",
    "settings.core",
    "connection error type Settings tiles read with Connections off",
  ),
  core(
    "src/lib/embedded-catalog-data",
    "settings.core",
    "bundled catalog field labels the capabilities page draws",
  ),
  core(
    "src/lib/bundled-provider-ids",
    "settings.core",
    "bundled catalog ids the capabilities page draws",
  ),
  shared(
    "src/lib/connect-callback",
    "operator callback base the git relay reads",
  ),
  shared(
    "src/lib/managed-connectors",
    "managed connector ids Settings skips when it draws provider tiles",
  ),
  core(
    "src/lib/byo",
    SIGNIN,
    "bring-your-own issuer sheet on the sign-in panel",
  ),
  optional(
    "src/lib/certs-issue",
    "vault.certificate-records",
    "self-signed issuance, loaded only with certificate records",
  ),
];
