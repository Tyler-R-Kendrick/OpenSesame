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

interface FeatureOwners {
  readonly agent_harnesses: (provider: Provider) => FeatureOperation;
  readonly networking: (provider: Provider) => FeatureOperation;
  readonly backup_recovery: (provider: Provider) => FeatureOperation;
  readonly cloud_secret_storage: (provider: Provider) => FeatureOperation;
  readonly encryption: (provider: Provider) => FeatureOperation;
  readonly certificates: (provider: Provider) => FeatureOperation;
  readonly wallet: (provider: Provider) => FeatureOperation;
  readonly identity: (provider: Provider) => FeatureOperation;
  readonly password_managers: (provider: Provider) => FeatureOperation;
  readonly local_storage: (provider: Provider) => FeatureOperation;
}

const OWNERS: FeatureOwners = {
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
  switch (provider.category) {
    case "agent_harnesses":
    case "networking":
    case "backup_recovery":
    case "cloud_secret_storage":
    case "encryption":
    case "certificates":
    case "wallet":
    case "identity":
    case "password_managers":
    case "local_storage":
      return OWNERS[provider.category](provider);
    default:
      return { ok: false, providerId: provider.id };
  }
}
