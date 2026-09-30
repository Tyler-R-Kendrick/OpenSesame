/**
 * The operation the feature that owns a Capabilities connector runs.
 * Each branch is that feature's runtime, so a listed connector is consumed
 * by the same function the feature calls.
 */

import type { Provider } from "@opensesame/app-core/lib/connections.js";
import type { FeatureOperation } from "@opensesame/app-core/lib/feature-connector-operation.js";
import { savedStorageOperation } from "../modules/backup.cloud-secrets/runtime.js";
import { savedGitBackupOperation } from "../modules/backup.git-remote/runtime.js";
import { savedCertificateOperation } from "../modules/enterprise.ca-administration/runtime.js";
import { savedIdentityOperation } from "../modules/identity.federation/runtime.js";
import { savedTailnetOperation } from "../modules/networking.tailnet/runtime.js";
import { savedRemoteModel } from "../modules/support.remote-ai/runtime.js";
import { savedWalletOperation } from "../modules/wallet.spending/runtime.js";
import {
  savedLocalStorageOperation,
  savedPasswordManagerOperation,
} from "./local-connector-features.js";

const OWNERS: Record<string, (provider: Provider) => FeatureOperation> = {
  agent_harnesses: (provider) => savedRemoteModel(provider),
  networking: (provider) => savedTailnetOperation(provider),
  backup_recovery: (provider) => savedGitBackupOperation(provider),
  cloud_secret_storage: (provider) => savedStorageOperation(provider),
  encryption: (provider) => savedStorageOperation(provider),
  certificates: (provider) => savedCertificateOperation(provider),
  wallet: (provider) => savedWalletOperation(provider),
  identity: (provider) => savedIdentityOperation(provider),
  password_managers: (provider) => savedPasswordManagerOperation(provider),
  local_storage: (provider) => savedLocalStorageOperation(provider),
};

/** The owning feature's operation for one connector the Capabilities page lists. */
export function runCapabilityFeature(provider: Provider): FeatureOperation {
  const run = OWNERS[provider.category];
  if (!run) return { ok: false, providerId: provider.id };
  return run(provider);
}
