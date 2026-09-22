/**
 * Settings › Connections as the connectors capability draws it: models and
 * every feature-binding family except the two the backup capabilities own
 * (`backup.git-remote` → backup/recovery, `backup.cloud-secrets` → cloud
 * secret storage). Those groups appear only while their capability is
 * active, under their own settings categories.
 */

import { FeatureBindingsPanel } from "../../sections/settings/FeatureBindingsPanel.js";

export function ConnectionsSettingsPanel() {
  return (
    <FeatureBindingsPanel
      exclude={["backup_recovery", "cloud_secret_storage"]}
    />
  );
}
