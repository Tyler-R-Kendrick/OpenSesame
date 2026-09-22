/**
 * Bootstrap inventory used by the capability build plugin while S02's
 * `src/lib/capabilities/{catalog,ownership,classification}.ts` are absent.
 *
 * Everything here is a *guess recorded as a guess*: the catalog carries the
 * §5 identifiers of docs/implementation/capability-composition/ownership.md
 * with no modules and no exposure, and the classification maps today's source
 * layout onto those identifiers so the forbidden-reachability gate can already
 * name what leaks into the bootstrap closure. Once the authored inventory
 * exists this file is no longer consulted (see `loadInventory` in
 * capability-compose-plugin.mjs) and every rationale below says "bootstrap".
 */

const CORE = [
  "vault.passwords",
  "vault.local-unlock",
  "backup.local-encrypted",
  "identity.brokered-signin",
  "settings.core",
  "install.pwa",
];

const OPTIONAL = [
  "vault.passkey-records",
  "vault.certificate-records",
  "sharing.drops",
  "sharing.household",
  "connectors.external",
  "backup.git-remote",
  "backup.cloud-secrets",
  "access.authority",
  "identity.federation",
  "identity.ambient-sso",
  "identity.local-iam",
  "identity.siop",
  "enterprise.directory-provisioning",
  "enterprise.ca-administration",
  "agents.webmcp",
  "support.guided-help",
  "support.local-ai",
  "support.remote-ai",
  "wallet.spending",
  "activity.log",
  "notifications.web-push",
  "telemetry.external",
];

function descriptor(id, tier) {
  return {
    id,
    descriptorVersion: 1,
    tier,
    title: id,
    summary: "bootstrap descriptor (S02 pending)",
    dependencies: [],
    alternatives:
      id === "sharing.household"
        ? [{ slot: "transport", oneOf: ["sharing.drops"] }]
        : [],
    operationIds: [],
    moduleIds: [],
    environments: ["document"],
    egress: [],
    browserPermissions: [],
    keyAccess: "none",
    requiresService: false,
    offlineLimits: "",
    workerGraphConstraint: id === "notifications.web-push" ? "push" : null,
    requiresDocumentReload: false,
    itemKinds: [],
    exposureDigest: "sha256:bootstrap",
  };
}

export const FALLBACK_CATALOG = Object.freeze({
  catalogVersion: 0,
  capabilities: [
    ...CORE.map((id) => descriptor(id, "core")),
    ...OPTIONAL.map((id) => descriptor(id, "optional")),
  ],
});

export const FALLBACK_HTML_ENTRY_OWNERSHIP = Object.freeze({
  "auth/redirect.html": "identity.ambient-sso",
});

export const FALLBACK_PUBLIC_FILE_OWNERSHIP = Object.freeze({});

const BOOTSTRAP = "bootstrap classification pending S02";

function optional(capability, ...patterns) {
  return patterns.map((pattern) => ({
    pattern,
    classification: "optional",
    capability,
    rationale: BOOTSTRAP,
  }));
}

function shared(rationale, ...patterns) {
  return patterns.map((pattern) => ({
    pattern,
    classification: "shared",
    capability: null,
    rationale,
  }));
}

/** Longest matching prefix wins; see `classifyModule`. */
export const FALLBACK_CLASSIFICATION = Object.freeze([
  ...optional(
    "identity.ambient-sso",
    "src/lib/ambient-auth/",
    "apps/pages/auth/",
    "node_modules/@azure/msal-browser",
  ),
  ...optional(
    "connectors.external",
    "src/sections/ConnectionsSection",
    "src/sections/connections/",
    "src/components/ConnectorMark",
    "src/components/connector-marks",
    "src/lib/connectors",
    "src/lib/connector-",
    "src/lib/connections",
    "src/lib/managed-connectors",
    "src/lib/nango-directory",
    "src/lib/vercel-connect",
    "src/lib/byo",
    "node_modules/@vercel/connect",
    "node_modules/simple-icons",
  ),
  ...optional(
    "access.authority",
    "src/sections/AccessSection",
    "src/sections/access/",
    "src/lib/access-",
    "src/lib/host-authorization",
  ),
  ...optional(
    "identity.local-iam",
    "src/screens/LocalAuthorize",
    "src/lib/local-access-",
    "src/lib/local-agent-",
    "src/lib/local-application",
    "src/lib/local-authorization",
    "src/lib/local-credentials",
    "src/lib/local-devices",
    "src/lib/local-directory",
    "src/lib/local-grant-",
    "src/lib/local-iam-events",
    "src/lib/local-issuer-channel",
    "src/lib/local-organizations",
    "src/lib/local-passkeys",
    "src/lib/local-rbac",
    "src/lib/local-request",
    "src/lib/local-sessions",
    "src/lib/local-share-",
    "src/lib/local-vault-session",
    "src/lib/local-network-fetch",
  ),
  ...optional(
    "identity.siop",
    "src/screens/SiopAuthorize",
    "src/lib/siop-",
    "packages/siop-v2/",
  ),
  ...optional(
    "identity.federation",
    "src/sections/IdentitySection",
    "src/sections/identity/",
    "src/screens/FederationReturn",
    "src/lib/federation",
    "src/lib/federated-",
    "src/lib/idp-",
    "src/lib/identity-graph",
    "src/lib/identity-management",
    "src/lib/last-sign-in",
  ),
  ...optional(
    "wallet.spending",
    "src/sections/WalletSection",
    "src/sections/wallet/",
    "src/lib/wallet-",
    "src/lib/spending-",
    "packages/wallet-",
  ),
  ...optional(
    "activity.log",
    "src/sections/ActivitySection",
    "src/lib/activity-log",
  ),
  ...optional("agents.webmcp", "src/webmcp/", "packages/webmcp/"),
  ...optional(
    "support.guided-help",
    "src/tutorial/",
    "node_modules/driver.js",
    "packages/guide-lang/",
    "packages/guide-runtime/",
    "packages/support-agent/",
  ),
  ...optional("support.local-ai", "src/lib/browser-inference"),
  ...optional(
    "support.remote-ai",
    "src/lib/model-",
    "node_modules/ai/",
    "node_modules/@ai-sdk/",
    "node_modules/@ag-ui/",
  ),
  ...optional("notifications.web-push", "src/lib/push"),
  ...optional(
    "backup.git-remote",
    "src/lib/backup",
    "src/lib/git-",
    "src/lib/github-",
    "src/lib/embedded-git",
    "src/lib/history-",
    "src/lib/vault-backup-",
    "src/components/BackupEnableSwitch",
  ),
  ...optional(
    "backup.cloud-secrets",
    "src/lib/aws-kms-config",
    "src/lib/azure-key-vault-keys-config",
    "src/lib/gcp-kms-config",
    "src/lib/sops/",
    "src/lib/secret-config-access",
  ),
  ...optional("vault.certificate-records", "src/lib/certs"),
  ...optional(
    "sharing.drops",
    "src/screens/DropClaimScreen",
    "src/sections/vault/Drop",
  ),
  ...optional(
    "enterprise.directory-provisioning",
    "src/lib/directory",
    "src/lib/orgs",
  ),
  ...shared(
    "framework dependency",
    "node_modules/react",
    "node_modules/react-dom",
    "node_modules/react-router",
    "node_modules/scheduler",
    "node_modules/tslib",
    "node_modules/workbox-window",
    "node_modules/tinykeys",
  ),
  ...shared(
    "shared dependency",
    "node_modules/zod",
    "node_modules/yaml",
    "node_modules/@noble/",
    "node_modules/hash-wasm",
    "node_modules/age-encryption",
    "node_modules/kdbxweb",
    "node_modules/@openfeature/",
    "node_modules/vite/",
  ),
  ...shared(
    "shared workspace package",
    "packages/os-domain/",
    "packages/sdk-browser/",
    "packages/static-auth/",
    "packages/contracts/",
    "packages/capability-registry/",
    "packages/capability-composition/",
    "packages/vault-item-types/",
    "packages/api-client/",
    "packages/audit/",
    "packages/auth-upstream/",
    "packages/qr/",
  ),
]);

export const FALLBACK_INVENTORY = Object.freeze({
  source: "fallback",
  catalog: FALLBACK_CATALOG,
  moduleOwnership: {},
  htmlEntryOwnership: FALLBACK_HTML_ENTRY_OWNERSHIP,
  publicFileOwnership: FALLBACK_PUBLIC_FILE_OWNERSHIP,
  classification: FALLBACK_CLASSIFICATION,
});
