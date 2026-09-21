import { type ComponentType, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import {
  type BackupTargetView,
  backupTargetProviderId,
  getBackupStatus,
} from "../../lib/backup.js";
import type { Provider } from "../../lib/connections.js";
import { getBundledProviders } from "../../lib/embedded-catalog.js";
import {
  HISTORY_BACKUP_GROUPS,
  isHistorySelected,
  loadHistorySelections,
} from "../../lib/history-backups.js";
import { useSettingsEpoch } from "../../lib/use-settings.js";
import { GuideTarget, useGuideTarget } from "../../tutorial/registry/react.jsx";
import { BackupEnableSwitch } from "../connections/BackupEnableSwitch.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import { featureBindingSections } from "../connections/page-tree.js";
import "../connections.css";
import { ModelProviderPanel as DefaultModelProviderPanel } from "./ModelProviderPanel.js";

function historyToggleable(providerId: string): boolean {
  return (HISTORY_BACKUP_GROUPS[0]?.providerIds ?? []).includes(providerId);
}

function historyRemote(providerId: string): string | null {
  const remote = loadHistorySelections()
    .find((row) => row.providerId === providerId)
    ?.remote?.trim();
  return remote || null;
}

function hostRemote(target: BackupTargetView): string | null {
  if (target.owner && target.repo) return `${target.owner}/${target.repo}`;
  return null;
}

/** Capability families plus Models. */
export function FeatureBindingsPanel({
  ModelProviderPanel = DefaultModelProviderPanel,
}: {
  ModelProviderPanel?: ComponentType;
} = {}) {
  const { hash } = useLocation();
  const providers = getBundledProviders();
  const groups = featureBindingSections(providers);
  const [target, setTarget] = useState<BackupTargetView | null>(null);
  useSettingsEpoch();
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [hash]);
  useEffect(() => {
    let live = true;
    void getBackupStatus("github")
      .then((status) => {
        if (live) setTarget(status.target);
      })
      .catch(() => {
        if (live) setTarget(null);
      });
    return () => {
      live = false;
    };
  }, []);
  const panelRef = useGuideTarget<HTMLElement>("settings.connectivity");
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const hostProviderId = target ? backupTargetProviderId(target) : null;
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

function FeatureBindingTile({
  provider,
  href,
  hostTarget,
}: {
  provider: Provider;
  href: string;
  hostTarget: BackupTargetView | null;
}) {
  const hostBound = hostTarget !== null;
  const historyBound = !hostBound && historyToggleable(provider.id);
  const enabled = hostBound
    ? hostTarget.enabled
    : historyBound && isHistorySelected(provider.id);
  const remote = hostBound
    ? hostRemote(hostTarget)
    : historyBound
      ? historyRemote(provider.id)
      : null;
  const showSwitch = hostBound || historyBound;

  return (
    <li className={`conn-tile${enabled ? " is-on" : ""}`}>
      <div className="conn-tile__row">
        <Link className="conn-tile__link" to={href}>
          <ConnectorMark
            providerId={provider.id}
            displayName={provider.displayName}
            size={32}
          />
          <span className="conn-tile__copy">
            <span className="conn-tile__name">{provider.displayName}</span>
            {remote ? <span className="conn-tile__kind">{remote}</span> : null}
          </span>
        </Link>
        {showSwitch ? (
          <BackupEnableSwitch
            providerId={provider.id}
            displayName={provider.displayName}
          />
        ) : null}
      </div>
    </li>
  );
}
