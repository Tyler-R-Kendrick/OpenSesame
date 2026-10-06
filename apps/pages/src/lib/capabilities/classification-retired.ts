/** Retired-credential routing and the shared boundaries it must enforce. */
import { core, shared } from "./classification-rule.js";

export const RETIRED_CREDENTIAL_RULES = [
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
