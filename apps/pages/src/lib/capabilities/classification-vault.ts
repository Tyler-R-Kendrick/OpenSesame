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
  core(V, ITEMS, "items, kinds, TOTP, health, drafts, website matching"),
  ...each(V, UNLOCK_FILES, (p) =>
    core(p, UNLOCK, "vault key, protectors, store lifecycle"),
  ),
  ...each(V, CLOUD_ADAPTERS, (p) =>
    optional(p, CLOUD, "cloud KMS, age and YubiKey protectors"),
  ),
  core(
    `${V}offline-backup`,
    "backup.local-encrypted",
    "encrypted file export/import",
  ),
  ...each(V, ["drop", "drop-transport", "local-drop-claims"], (p) =>
    optional(
      p,
      "sharing.drops",
      "drop sealing, claim transport, Pages-hosted claims",
    ),
  ),
  optional(
    `${V}import/`,
    "vault.interop-formats",
    "import pipeline and manager formats",
  ),
  optional(`${V}export/`, "vault.interop-formats", "CXF export"),
];

export const TUTORIAL_RULES = [
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
      "rendering/",
      "ui/",
      "__tests__/",
      "session",
      "ask-guard",
      "support-access",
      "support-context",
      "support.css",
    ],
    (p) =>
      optional(
        p,
        HELP,
        "support panel, Driver.js renderer, session; session MIXED",
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
  optional(`${T}agents/provider/`, "support.remote-ai", "model-provider agent"),
];
