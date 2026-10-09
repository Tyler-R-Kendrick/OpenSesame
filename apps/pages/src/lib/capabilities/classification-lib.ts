/** `src/lib/*` root files. Every family is named, so a new file needs a rule. */
import { core, each, optional, shared } from "./classification-rule.js";

const L = "src/lib/";
const SHELL = "shell.navigation";
const SIGNIN = "identity.brokered-signin";
const CEREMONIES = "identity.ceremonies";
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
  "web-push-ledger", // ids the core worker controller retires when push goes
  "at-rest/", // every stored value's seal and the device key (ADR 0149)
  "vfs",
  "projects",
  "vaults",
  // Dotted mark for a vault, person or organization, drawn in the shell prompt (ADR 0165).
  "glyph",
  "last-vault",
  "theme",
  "focus",
  "use-focus-after",
  "gestures",
  "gesture-runtime",
  "gesture-motion",
  "use-gestures",
  "use-claimed-drags",
  "tab-swipe",
  "gesture-help",
  "pane-trail",
  "use-narrow",
  "vault-list-path",
  // `?f=login` is the retired name of `?f=account` (ADR 0172): the vault list and rail read it.
  "vault-filter-slug",
  "modal-focus",
  "strip",
  "scroll-panel",
  "hash-target",
  "pane-escape",
  "tree-motion",
  "page-to-tree",
  "listing-page",
  "notices",
  // Tray history sealed at rest, and the boot that installs it (ADR 0163).
  "notice-tray-persist",
  "tray-boot",
  "use-online",
  "use-configured",
  // A press that must count once, however fast it is pressed twice.
  "use-once",
  "use-settings",
  "use-install",
  "identifier",
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
  "derived-item-kinds",
  "show-hidden",
  "use-show-hidden",
];
const SIGNIN_FILES = [
  "guest-access",
  "guest-auth",
  "guest-isolation",
  "browser-pairing",
  "host-authorization",
  "local-guest",
  "auth-outcome",
  "last-sign-in",
  "session-exit",
  "account",
  "identity",
  "federation",
  "federation-copy",
  "federation-callback",
  "federation-pending",
  "federation-restoration",
  "federation-session-store",
  "providers",
  "device-identity",
  "federated-signin",
  "guest-login",
  "orgs",
];
const CONNECTOR_FILES = [
  "linear-",
  "connector-guidance",
  "connect-",
  "self-hosted-config",
  "self-hosted-connectors",
  "github-installation-access",
  "identity-graph",
];
const GIT_FILES = [
  "github-app-",
  "connector-catalog",
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
  "backup-egress-gate",
  "vault-backup-sync",
  "saved-git-backup",
  "embedded-git",
];
const AGE_FILES = ["age-keys", "age-lib"];
const CLOUD_FILES = [...AGE_FILES, "aws-kms-config", "gcp-kms-config", "sops/"];
const ACCESS_FILES = [
  "access-book",
  "local-access-requests",
  "local-grant-admin",
  "local-grant-store",
];
const LOCAL_IAM_FILES = [
  "local-access-bootstrap",
  "local-agent-authorization",
  "local-agent-channel",
  "local-application-approval",
  "local-authenticator",
  "local-authorization",
  "local-pending-codes",
  "local-iam-lock-resets",
  "local-issuer-channel",
  "local-request",
  "local-request-authorization",
  "local-request-issuance",
  "device-identity-inbox",
  "device-identity-local",
];
const FEDERATION_FILES = [
  // `orgs.ts` stays core sign-in vocabulary; only its directory is optional.
  "orgs-directory",
];
const LOCAL_AI_FILES = [
  "model-provider",
  "hosted-inference",
  "saved-model-agent",
  "model-catalog",
  "model-slugs",
  "browser-inference",
  "command-bar/interpret",
  "command-bar/prompt-model",
  "command-bar/speech",
];
const WALLET_FILES = ["spending-", "wallet-"];

export const LIB_RULES = [
  core(
    `${L}item-type-marketplace/`,
    "vault.passwords",
    "item-type marketplaces read from a git repository (ADR 0134)",
  ),
  core(
    `${L}type-packs/`,
    "vault.passwords",
    "built-in item types downloaded and installed when switched on (ADR 0165)",
  ),
  core(
    `${L}file-parts-store`,
    "vault.passwords",
    "sealed parts of a file item",
  ),
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
      "capability-connector-scope",
      "password-reset-mail",
      "setup",
      "runtime-config",
      "deployment-profile",
      "configuration/",
      "capabilities",
      "connect-roads",
      "embedded-catalog",
      "idp-presets",
      "local-application-policy",
    ],
    (p) =>
      core(
        p,
        "settings.core",
        "settings records, setup record, runtime config, editors",
      ),
  ),
  ...each(L, ["webauthn", "browser-reset"], (p) =>
    core(p, "vault.local-unlock", "WebAuthn detection; resetting this browser"),
  ),
  core(`${L}guest-connections`, "vault.local-unlock", "tomb"),
  core(`${L}idp-registry`, "vault.local-unlock", "tomb IdPs"),
  shared(
    `${L}activity-log`,
    "append API used by core; the section is activity.log",
  ),
  shared(
    `${L}sharing-receipts`,
    "value-blind drop, live-grant and share receipts; activity log and device receipts",
  ),
  shared(
    `${L}document-lifecycle`,
    "trusted-hide and persisted-restore decisions the shell and a live session share",
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
  ...each(L, CLOUD_FILES, (p) => optional(p, CLOUD, "cloud KMS, age, SOPS")),
  ...each(L, ACCESS_FILES, (p) =>
    optional(p, ACCESS, "local PAM records and Host plane"),
  ),
  core(
    `${L}pairing-link`,
    SHELL,
    "boot takes a drive pairing code out of the address bar (ADR 0144)",
  ),
  optional(
    `${L}tailnet-sync/`,
    "networking.tailnet",
    "tailnet vault sync: drive client, merge pass, adoption (ADR 0144)",
  ),
  optional(
    `${L}tailnet-admin/`,
    "networking.tailnet-devices",
    "tailnet device management: daemon client, sealed pairing, device model (ADR 0169)",
  ),
  core(
    `${L}join/`,
    SIGNIN,
    "join a session: invite or open endpoint, before sign-in (ADR 0136)",
  ),
  // Ceremonies a link opens on this origin ship in every build (ADR 0140).
  core(
    `${L}claims/`,
    CEREMONIES,
    "ownership claim: link, stash, present/read/complete (ADR 0140)",
  ),
  core(
    `${L}interactions`,
    CEREMONIES,
    "/i/<ref>: approval model, -link (read at boot), -route (screen model) (ADR 0140)",
  ),
  // The hosted inbox rows it builds are Access › Requests' (plan step 9).
  core(
    `${L}approvals`,
    CEREMONIES,
    "/approve/<ref> review, hosted rows, -link (boot), -route (ADR 0084, 0140)",
  ),
  // A link's query, read at boot: `/device?user_code=`, `/invoke/<kind>`,
  // and the `/guest` and `/delegate` aliases (ADR 0140).
  ...each(L, ["device-link", "invoke-", "ceremony-aliases", "directory"], (p) =>
    core(p, CEREMONIES, "a ceremony link read at boot, and its model"),
  ),
  core(
    `${L}device-approval`,
    CEREMONIES,
    "device approval view-model shared by /device and Identity › Devices (ADR 0140)",
  ),
  optional(
    `${L}notification-routing/`,
    "notifications.routing",
    "notification routing document, channel words, policy narrowing, Identity API routes (ADR 0084)",
  ),
  // Where this device tells its person a request is waiting (ADR 0162):
  // places, preference, notice and watcher, only through notifications.local.
  optional(
    `${L}local-notifications/`,
    "notifications.local",
    "local notification places, preference, notice contract and inbox watcher (ADR 0162)",
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
  // The plan's placement (ADR 0140 plan step 12): Identity › Organizations'
  // sign-in panels, under the capability that already owns organizations.
  optional(
    `${L}org-signin`,
    "enterprise.directory-provisioning",
    "organization upstream, email domains and SCIM tokens (ADR 0140)",
  ),
  // Duress (ADR 0131): the code, fence, compartments and alerting hang off
  // unlocking, so the tree belongs to the core unlock capability.
  core(
    `${L}duress/`,
    "vault.local-unlock",
    "duress slots, fence, compartments and alerting",
  ),
  core(
    `${L}travel/`,
    "vault.local-unlock",
    "travel mode: departure bundle and return",
  ),
  shared(`${L}local-iam-events`, "change fanout the tomb and identity share"),
  core(
    `${L}ambient-auth/entra-instances`,
    "vault.local-unlock",
    "browser reset clears ambient sign-in instances",
  ),
  ...each(L, ["capabilities/settling", "router-seam"], (p) =>
    core(p, SHELL, "router inputs: is the plan up, and navigate from outside"),
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
  core(`${L}certs`, "vault.passwords", "editor opens an existing certificate"),
  ...each(L, ["x509/"], (p) =>
    optional(p, "vault.certificate-records", "self-signed X.509 issuance"),
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
