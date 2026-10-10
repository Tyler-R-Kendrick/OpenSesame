/**
 * `src/lib/vault/**` and `src/tutorial/**`.
 */

import { core, each, optional, shared } from "./classification-rule.js";

const V = "src/lib/vault/";
const T = "src/tutorial/";
const ITEMS = "vault.passwords";
const UNLOCK = "vault.local-unlock";
const CLOUD = "backup.cloud-secrets";
const HELP = "support.guided-help";

const UNLOCK_FILES = [
  "crypto",
  "store",
  "store-header",
  "store-ops",
  "store-passkey",
  "store-second-step",
  "store-sync",
  "store-sync-extra",
  "boot",
  "crypto-binding",
  "crypto-extra",
  "unlock-methods",
  "unlock-methods-extra",
  "unlock-methods-passkey",
  "recovery-codes",
  "remote-code",
  "self-authenticator",
  "seal-rebind",
  "tomb-migration",
  "lock-events",
  "session-boundary",
  "protection/",
];
const CLOUD_ADAPTERS = [
  "protection/adapters/aws-",
  "protection/adapters/azure-",
  "protection/adapters/gcp-",
  "protection/adapters/cloud-",
  "protection/adapters/age-",
  "protection/adapters/yubikey-",
  "protection/sops-browser",
  "protection/cloud-envelope",
  "protection/age-bootstrap",
];

export const VAULT_LIB_RULES = [
  core(
    "src/lib/password-agent/",
    ITEMS,
    "provider-independent credential workflow algorithms and native CLI ports; the local vault reuses discovery and template handling",
  ),
  core(V, ITEMS, "items, kinds, TOTP, health, drafts, website matching"),
  ...each(V, UNLOCK_FILES, (p) =>
    core(p, UNLOCK, "vault key, protectors, store lifecycle"),
  ),
  ...each(V, CLOUD_ADAPTERS, (p) =>
    optional(p, CLOUD, "cloud KMS and age protectors"),
  ),
  core(
    `${V}offline-backup`,
    "backup.local-encrypted",
    "encrypted file export/import",
  ),
  ...each(V, ["drop", "drop-transport"], (p) =>
    optional(
      p,
      "sharing.drops",
      "sending a drop: sealing, claim session create/poll (opening is claims/drop-open, ADR 0140 D2)",
    ),
  ),
  core(
    `${V}local-drop-claims`,
    null,
    "the device-native claim plane the in-tab Identity API serves; presenting a claim is opening a drop (ADR 0140 D2)",
  ),
  optional(
    `${V}draft-suggestions`,
    "support.local-ai",
    "draft labels from the on-device model",
  ),
  optional(
    `${V}environments`,
    "vault.environments",
    "named environments, schema text, and the missing-value notice",
  ),
  optional(
    `${V}security-checks`,
    "vault.security-checks",
    "breach and two-step checks against Pwned Passwords and 2fa.directory",
  ),
  optional(
    `${V}import/`,
    "vault.interop-formats",
    "import pipeline and manager formats",
  ),
  optional(`${V}export/`, "vault.interop-formats", "CXF export"),
  // A live link leaves the address bar at boot, like an invite; everything
  // that speaks to a peer is the capability's (ADR 0150).
  core(
    "src/lib/live/link",
    "identity.brokered-signin",
    "boot takes a live-session link out of the address bar (ADR 0150)",
  ),
  optional(
    "src/lib/live/",
    "sharing.live",
    "live sessions: pairing codes, WebRTC peers, host and guest (ADR 0150)",
  ),
  optional(
    "src/lib/quorum/",
    "sharing.trusted-contacts",
    "trusted contacts: guardian policy, quorum approvals, SLIP-0039 shares, HPKE release (ADR 0186)",
  ),
];

export const TUTORIAL_RULES = [
  shared(
    `${T}support-context`,
    "nullable React context seam read by core sheets; imports the optional controller only as an erased type",
  ),
  shared(
    `${T}gate-seat`,
    "the seat a gate screen keeps for the help key, and the host that holds it; core screens import it, the capability draws into it (ADR 0166)",
  ),
  shared(
    `${T}registry/`,
    "target/route/predicate registration hooks used by core chrome",
  ),
  ...each(
    `${T}registry/`,
    [
      "catalog",
      "catalog-more",
      "capability-tutorials",
      "goals",
      "item-reference-help",
      "identity-catalog",
      "identity-goals",
      "setup-catalog",
      "setup-goals",
      "shell-catalog",
      "shell-goals",
      "vault-catalog",
      "authority-help",
      "capability-context",
      "retrieval",
      "dev",
    ],
    (p) => optional(p, HELP, "authored help prose and goal programs"),
  ),
  ...each(
    T,
    [
      "coach/",
      "engine",
      "lazy-engine-agent",
      "refresh-engine",
      "tour-runner",
      "ui/",
      "__tests__/",
      "session",
      "use-support-route",
      "ask-guard",
      "choose-agent",
      "support-access",
      "support.css",
    ],
    (p) =>
      optional(
        p,
        HELP,
        "support panel, tutorial HUD, tour engine, session; session MIXED",
      ),
  ),
  optional(
    `${T}agent-seams`,
    "support.guided-help",
    "agent loader seams the AI runtimes fill in activate",
  ),
  optional(
    `${T}agents/prompt-api/`,
    "support.local-ai",
    "browser Prompt API agent",
  ),
  optional(`${T}agents/ag-ui/`, "support.remote-ai", "AG-UI transport agent"),
  optional(
    `${T}agents/ag-ui/consent`,
    HELP,
    "the consent handshake the support panel draws; remote AI asks through it",
  ),
  optional(`${T}agents/provider/`, "support.remote-ai", "model-provider agent"),
];
