/**
 * Settings › Backups — the backup/recovery family's feature bindings (the
 * GitHub App target, the forge and generic git remotes, the password-store
 * road), each a tile with its enable switch. The rows used to sit inside
 * Settings › Connections; they are drawn here only while
 * `backup.git-remote` is active.
 */

import type { ProviderCategory } from "../../lib/connections.js";
import { getBundledProviders } from "../../lib/embedded-catalog.js";
import { useSettingsEpoch } from "../../lib/use-settings.js";
import { featureBindingSections } from "../../sections/connections/page-tree.js";
import {
  FeatureBindingTile,
  hostTargetProviderId,
  useHostBackupTarget,
} from "../../sections/settings/FeatureBindingTile.js";

export function FeatureBindingGroupPanel({
  id,
  title,
  category,
}: {
  id: string;
  title: string;
  category: ProviderCategory;
}) {
  const providers = getBundledProviders();
  const group = featureBindingSections(providers).find(
    (section) => section.id === category,
  );
  const target = useHostBackupTarget();
  useSettingsEpoch();
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const hostProviderId = hostTargetProviderId(target);
  return (
    <section className="panel" id={id}>
      <div className="panel__head">
        <h2>{title}</h2>
      </div>
      <div className="panel__body">
        <div className="conn-group" id={category}>
          <ul className="conn-grid">
            {(group?.items ?? []).map((item) => {
              const provider = byId.get(item.id);
              if (!provider) return null;
              return (
                <FeatureBindingTile
                  key={item.id}
                  provider={provider}
                  href={item.href}
                  hostTarget={hostProviderId === provider.id ? target : null}
                />
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function BackupBindingsPanel() {
  return (
    <FeatureBindingGroupPanel
      id="settings-backups"
      title="Backups"
      category="backup_recovery"
    />
  );
}
