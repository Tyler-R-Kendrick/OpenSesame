/** `src/lib/*` root files. Every family is named, so a new file needs a rule. */
import { CLI_APP_INTEGRATION_RULES } from "./classification-cli-app.js";
import { CONNECTOR_LIB_RULES } from "./classification-connectors.js";
import { DEV_EVIDENCE_RULES } from "./classification-dev-evidence.js";
import { CORE_INFRA_RULES } from "./classification-infrastructure.js";
import { NETWORK_RELAY_RULES } from "./classification-network-relay.js";
import { core, each, optional, shared } from "./classification-rule.js";
import { VAULT_RELAY_RULES } from "./classification-vault-relay.js";
import { WALLET_RULES } from "./classification-wallet.js";

export { VAULT_RELAY_RULES };
const L = "src/lib/";
const SHELL = "shell.navigation";
const SIGNIN = "identity.brokered-signin";
const CEREMONIES = "identity.ceremonies";
const GIT = "backup.git-remote";
const CLOUD = "backup.cloud-secrets";
const ACCESS = "access.authority";
const LOCAL_IAM = "identity.local-iam";
const FEDERATION = "identity.federation";
const LOCAL_AI = "support.local-ai";

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
  "native-identity-admission",
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
  "vault-backup-github",
  "vault-backup-observer",
  "backup-egress-gate",
  "vault-backup-sync",
  "vault-backup-write-owner",
  "vault-backup-readonly",
  "vault-backup-forge",
  "git-backup-credentials",
  "gitlab-backup-protocol",
  "gitlab-backup-target",
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
  "local-pairwise-subject",
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
  "model-catalog",
  "model-slugs",
  "browser-inference",
  "command-bar/interpret",
  "command-bar/prompt-model",
  "command-bar/speech",
];

export const LIB_RULES = [
  ...DEV_EVIDENCE_RULES,
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
  ...CORE_INFRA_RULES,
  ...each(L, SHELL_FILES, (p) =>
    core(p, SHELL, "routing tables, keymap, plane truth; MIXED where noted"),
  ),
  ...each(L, SIGNIN_FILES, (p) =>
    core(p, SIGNIN, "front door, guest, session; MIXED where noted"),
  ),
  ...each(
    L,
    ["install", "pwa-update", "pwa-refresh", "launch-intake", "share-target"],
    (p) =>
      core(p, "install.pwa", "install, update and user-selected file intake"),
  ),
  ...each(
    L,
    [
      "settings",
      "operator-idp-config",
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
    `${L}auth-generation.ts`,
    "principal generation shared by native and ambient sign-in",
  ),
  shared(
    `${L}native-base64.ts`,
    "pure byte codecs shared by saved backups and native provider protocols",
  ),
  shared(
    `${L}native-response-json.ts`,
    "bounded native Response decoding shared by saved backups and providers",
  ),
  shared(
    `${L}secret-backends/types.ts`,
    "common secret-store port and error vocabulary; no provider runtime",
  ),
  shared(`${L}origin-file-publication-read`, "device-sealed record reads"),
  shared(`${L}original-origin-storage`, "sealed origin data"),
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
  ...CONNECTOR_LIB_RULES,
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
  ...NETWORK_RELAY_RULES,
  ...VAULT_RELAY_RULES,
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
  core(
    `${L}deadman/`,
    "vault.local-unlock",
    "deadman release envelope, signed record and relay heartbeat",
  ),
  shared(`${L}local-iam-events`, "change fanout the tomb and identity share"),
  shared(
    `${L}local-groups.ts`,
    "built-in principals shared by core vault reach checks, standing grants and live sessions",
  ),
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
  // The generation fence is storage-only shared infrastructure: core native
  // identity lineage and optional ambient sign-in both stamp in-flight work
  // with it. Only the remaining `ambient-auth/` orchestration is optional.
  shared(
    `${L}ambient-auth/generation`,
    "the auth-generation fence core identity lineage and ambient sign-in share",
  ),
  ...each(L, ["ambient-auth/"], (p) =>
    optional(p, "identity.ambient-sso", "MSAL / OIDC ambient boot"),
  ),
  ...each(L, ["siop-authority", "siop-keys"], (p) =>
    optional(p, "identity.siop", "SIOPv2 authority"),
  ),
  optional(
    `${L}siop-social.ts`,
    "identity.siop",
    "social proof choices and redirect attempts used only by SIOP consent",
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
  ...CLI_APP_INTEGRATION_RULES,
  ...each(L, LOCAL_AI_FILES, (p) =>
    optional(p, LOCAL_AI, "on-device model plane; MIXED — remote"),
  ),
  ...WALLET_RULES,
];
