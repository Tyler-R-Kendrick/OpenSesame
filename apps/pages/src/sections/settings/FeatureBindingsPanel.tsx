import type { ProviderCategory } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { type ComponentType, useEffect } from "react";
import { useLocation } from "react-router";
import { useSettingsEpoch } from "../../lib/use-settings.js";
import { GuideTarget, useGuideTarget } from "../../tutorial/registry/react.jsx";
import { featureBindingSections } from "../connections/page-tree.js";
import "../connections.css";
import {
  FeatureBindingTile,
  hostTargetProviderId,
  useHostBackupTarget,
} from "./FeatureBindingTile.js";
import { ModelProviderPanel as DefaultModelProviderPanel } from "./ModelProviderPanel.js";

/**
 * Capability families plus Models. `exclude` names the families another
 * capability's settings panel draws instead (the backup modules own
 * `backup_recovery` and `cloud_secret_storage` when they are active).
 */
export function FeatureBindingsPanel({
  ModelProviderPanel = DefaultModelProviderPanel,
  exclude = [],
}: {
  ModelProviderPanel?: ComponentType;
  exclude?: readonly ProviderCategory[];
} = {}) {
  const { hash } = useLocation();
  const providers = getBundledProviders();
  const groups = featureBindingSections(providers).filter(
    (group) => !exclude.includes(group.id as ProviderCategory),
  );
  const target = useHostBackupTarget();
  useSettingsEpoch();
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [hash]);
  const panelRef = useGuideTarget<HTMLElement>("settings.connectivity");
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const hostProviderId = hostTargetProviderId(target);
  return (
    <section className="panel" id="settings-connections" ref={panelRef}>
      <div className="panel__head">
        <h2>Connections</h2>
      </div>
      <div className="panel__body">
        <GuideTarget id="settings.model-provider">
          <ModelProviderPanel />
        </GuideTarget>
        {groups.map((group) => (
          <div className="conn-group" key={group.id} id={group.id}>
            <h3 className="conn-group__label">{group.label}</h3>
            <ul className="conn-grid">
              {(group.items ?? []).map((item) => {
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
        ))}
      </div>
    </section>
  );
}
