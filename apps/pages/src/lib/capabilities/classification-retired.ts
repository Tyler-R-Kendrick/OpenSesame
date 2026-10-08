/** Retired-credential routing and the shared boundaries it must enforce. */
import { core, each, optional, shared } from "./classification-rule.js";

export const RETIRED_CREDENTIAL_RULES = [
  ...each(
    "src/lib/",
    [
      "credential-response-realm",
      "member-authority",
      "member-continuation-authority",
      "member-response-authority",
    ],
    (pattern) =>
      core(
        pattern,
        null,
        "real owner and generation checks shared by capability continuations",
      ),
  ),
  optional(
    "src/lib/drop-creation-lifetime",
    "sharing.drops",
    "drop creation preserves the originating owner's authority across transport",
  ),
  optional(
    "src/lib/history-backup-owner-admission",
    "backup.git-remote",
    "history backup reads require the original real owner after synthetic admission",
  ),
  core(
    "src/lib/vault-backup-authority",
    "backup.local-encrypted",
    "local backup excludes synthetic sessions and stale owner continuations",
  ),
  ...each(
    "src/lib/",
    ["vercel-manage-owner-body", "device-revocation-owner"],
    (pattern) =>
      shared(
        pattern,
        "connector responses and revocation remain bound to the real owner",
      ),
  ),
  core(
    "src/lib/credential-canaries/",
    "vault.local-unlock",
    "owner-selected controlled canary enrollment and independent bounded validators",
  ),
  core(
    "src/lib/credential-observation/",
    "vault.local-unlock",
    "optional independently sealed observation metadata under the current network profile",
  ),
  core(
    "src/lib/retired-credentials/",
    "vault.local-unlock",
    "owner-enrolled retired-password classification, isolated synthetic sessions and local evidence",
  ),
  core(
    "src/lib/decoy-",
    null,
    "shared synthetic-session authority, resource and egress boundaries",
  ),
  core(
    "src/lib/project-key",
    null,
    "project key custody shared by local vault and connector execution",
  ),
  shared(
    "src/lib/connection-consent",
    "consent records shared by identity and external connector brokers",
  ),
  core(
    "src/lib/vault-backup-decoy",
    "backup.local-encrypted",
    "real snapshot exclusion in synthetic sessions",
  ),
];
