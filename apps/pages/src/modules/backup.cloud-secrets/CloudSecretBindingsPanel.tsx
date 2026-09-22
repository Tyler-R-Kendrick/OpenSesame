/**
 * Settings › Cloud secrets — the cloud secret *storage* family's bindings
 * (Doppler, Infisical, AWS Secrets Manager, HashiCorp Vault and the like),
 * drawn only while `backup.cloud-secrets` is active. The KMS and Key Vault
 * connector pages are vault key *protection* and stay core.
 */

import { FeatureBindingGroupPanel } from "../backup.git-remote/BackupBindingsPanel.js";

export function CloudSecretBindingsPanel() {
  return (
    <FeatureBindingGroupPanel
      id="settings-cloud-secrets"
      title="Cloud secrets"
      category="cloud_secret_storage"
    />
  );
}
