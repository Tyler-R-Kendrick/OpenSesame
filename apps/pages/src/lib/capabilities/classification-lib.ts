/**
 * `src/lib/*` (root files). No directory default: every family is named,
 * so a new file with no rule fails the classification test and gets one.
 */

import { core, each, optional, shared } from "./classification-rule.js";

const L = "src/lib/";
const SHELL = "shell.navigation";
const SIGNIN = "identity.brokered-signin";
const CONNECTORS = "connectors.external";
const GIT = "backup.git-remote";
const CLOUD = "backup.cloud-secrets";
const ACCESS = "access.authority";
const LOCAL_IAM = "identity.local-iam";
const FEDERATION = "identity.federation";
const LOCAL_AI = "support.local-ai";
const WALLET = "wallet.spending";

const CORE_INFRA = [
  "kv",
  "vfs",
  "projects",
  "vaults",
  "last-vault",
  "theme",
  "focus",
  "gestures",
  "modal-focus",
  "pane-escape",
  "tree-motion",
  "page-to-tree",
  "notices",
  "use-online",
  "use-status-notice",
  "use-configured",
  "use-settings",
  "use-install",
  "identifier",
  "host-ids",
  "probe-failure",
  "opener-policy",
  "bounded-response",
  "urls",
  "agent-page-dump",
  "local-network-fetch",
  "queue",
  "pact",
  "__tests__/",
  "__snapshots__/",
];
const SHELL_FILES = [
  "keymap",
  "keymap-help",
  "crumbs",
  "section-views",
  "section-view-names",
  "access-routes",
  "connectivity",
  "connectivity-monitor",
  "planes",
  "connectors",
  "command-bar/",
  "keyboard-delivery",
  "contributions",
  "item-kinds",
];
const SIGNIN_FILES = [
  "guest-auth",
  "guest-isolation",
  "local-guest",
  "auth-outcome",
  "last-sign-in",
  "session-exit",
  "account",
  "identity",
  "federation",
  "federation-copy",
  "federation-encoding",
  "federation-callback",
  "federation-pending",
  "federation-restoration",
  "federation-session-store",
  "providers",
  "device-identity",
  "federated-signin",
  "guest-login",
];
const CONNECTOR_FILES = [
  "capabilities",
  "capability-bind",
  "connector-guidance",
  "connector-settings",
  "connect-callback",
  "connections",
  "connections-integrations",
  "connections-local-git",
  "connector-directory",
  "nango-directory",
  "embedded-catalog",
  "embedded-catalog-data",
  "managed-connectors",
  "vercel-connect",
  "github-app-",
  "github-installation-access",
  "guest-connections",
  "identity-graph",
];
const GIT_FILES = [
  "backup",
  "backup-target-build",
  "backup-target-local",
  "git-auth-modes",
  "git-backup-forges",
  "git-remote-local",
  "github-history",
  "history-backups",
  "history-backup-idb",
  "history-claim-notice",
  "vault-backup-observer",
  "vault-backup-sync",
  "embedded-git",
];
const CLOUD_FILES = [
  "age-keys",
  "aws-kms-config",
  "azure-key-vault-keys-config",
  "gcp-kms-config",
  "yubikey-config",
  "sops/",
];
const ACCESS_FILES = [
  "access-book",
  "local-access-audit",
  "local-access-bootstrap",
  "local-access-requests",
  "local-grant-admin",
  "local-grant-store",
  "local-rbac",
  "local-share-grants",
  "local-share-reach",
  "host-authorization",
  "browser-pairing",
  "secret-config-access",
  "changelog",
];
const LOCAL_IAM_FILES = [
  "local-agent-auth",
  "local-agent-authorization",
  "local-agent-channel",
  "local-agent-keys",
  "local-application-approval",
  "local-application-policy",
  "local-applications",
  "local-authenticator",
  "local-authorization",
  "local-credentials",
  "local-devices",
  "local-directory",
  "local-directory-bootstrap",
  "local-directory-memberships",
  "local-directory-types",
  "local-iam-events",
  "local-iam-lock-resets",
  "local-issuer-channel",
  "local-organizations",
  "local-passkeys",
  "local-passkey-prf",
  "local-request",
  "local-request-authorization",
  "local-request-issuance",
  "local-request-store",
  "local-sessions",
  "local-vault-session-issue",
  "local-vault-sessions",
  "pages-dogfood",
  "device-identity-host",
  "device-identity-local",
];
const FEDERATION_FILES = [
  "byo",
  "idp-presets",
  "idp-registry",
  "orgs",
  "directory",
];
const LOCAL_AI_FILES = [
  "model-provider",
  "model-catalog",
  "model-slugs",
  "browser-inference",
  "command-bar/interpret",
  "command-bar/prompt-model",
  "command-bar/speech",
];
const WALLET_FILES = ["spending-", "wallet-"];

export const LIB_RULES = [
  ...each(L, CORE_INFRA, (p) =>
    core(p, null, "storage, focus, theme and shell infrastructure"),
  ),
  ...each(L, SHELL_FILES, (p) =>
    core(p, SHELL, "routing tables, keymap, plane truth; MIXED where noted"),
  ),
  ...each(L, SIGNIN_FILES, (p) =>
    core(p, SIGNIN, "front door, guest, session; MIXED where noted"),
  ),
  ...each(L, ["install", "pwa-update"], (p) =>
    core(p, "install.pwa", "install and update"),
  ),
  ...each(
    L,
    [
      "settings",
      "setup",
      "runtime-config",
      "deployment-profile",
      "configuration/",
    ],
    (p) =>
      core(
        p,
        "settings.core",
        "settings records, setup record, runtime config, editors",
      ),
  ),
  core(`${L}webauthn`, "vault.local-unlock", "WebAuthn support detection"),
  shared(
    `${L}activity-log`,
    "append API used by core; the section is activity.log",
  ),
  ...each(L, CONNECTOR_FILES, (p) =>
    optional(
      p,
      CONNECTORS,
      "connector catalogue, Connect, GitHub App, directory",
    ),
  ),
  ...each(L, GIT_FILES, (p) =>
    optional(p, GIT, "git remote backup and history"),
  ),
  ...each(L, CLOUD_FILES, (p) =>
    optional(p, CLOUD, "cloud KMS, age, YubiKey, SOPS"),
  ),
  ...each(L, ACCESS_FILES, (p) =>
    optional(p, ACCESS, "local PAM records and Host plane"),
  ),
  ...each(L, LOCAL_IAM_FILES, (p) =>
    optional(p, LOCAL_IAM, "browser-local IAM"),
  ),
  ...each(L, FEDERATION_FILES, (p) =>
    optional(p, FEDERATION, "operator IdPs and Identity directory"),
  ),
  ...each(L, ["identity-management"], (p) =>
    optional(
      p,
      "enterprise.directory-provisioning",
      "Identity API agent/user management",
    ),
  ),
  // Duress (ADR 0131): a duress code is an unlock method, and the fence,
  // compartments and alerting it drives all hang off unlocking, so the whole
  // tree belongs to the core unlock capability.
  core(
    `${L}duress/`,
    "vault.local-unlock",
    "duress slots, fence, compartments and alerting",
  ),
  // Transport security (ADR 0132) is deployment-plane operator work; the
  // Pages surface reads status and runs the enforcement probe.
  ...each(L, ["transport-"], (p) =>
    optional(p, "access.authority", "operator transport status and probe"),
  ),
  ...each(L, ["capabilities/settling"], (p) =>
    core(p, SHELL, "whether the plan is still coming up, for the router"),
  ),
  ...each(L, ["router-seam"], (p) =>
    core(p, SHELL, "the router's navigate, read from outside React"),
  ),
  ...each(L, ["ambient-auth-seam"], (p) =>
    core(p, SIGNIN, "the ambient seam core federation calls through"),
  ),
  ...each(L, ["ambient-auth/"], (p) =>
    optional(p, "identity.ambient-sso", "MSAL / OIDC ambient boot"),
  ),
  ...each(L, ["siop-authority", "siop-keys"], (p) =>
    optional(p, "identity.siop", "SIOPv2 authority"),
  ),
  optional(
    `${L}site-broker`,
    "identity.site-broker",
    "relying-site broker consents and policy",
  ),
  optional(
    `${L}auth-client`,
    "identity.site-broker",
    "pins the shipped static-auth SDK bytes",
  ),
  optional(
    `${L}certs`,
    "vault.certificate-records",
    "local WebCrypto certificate issuance",
  ),
  optional(
    `${L}push`,
    "notifications.web-push",
    "push enrolment and payload rendering",
  ),
  ...each(L, LOCAL_AI_FILES, (p) =>
    optional(p, LOCAL_AI, "on-device model plane; MIXED — remote"),
  ),
  ...each(L, WALLET_FILES, (p) =>
    optional(p, WALLET, "spending ledger, instruments, brokers"),
  ),
];
