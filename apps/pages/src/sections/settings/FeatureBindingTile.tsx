/**
 * One feature-binding tile: a connector the capability family is bound to,
 * with the enable switch where the binding is a backup road. Shared by the
 * Connections settings panel and the backup modules' own panels, so the
 * tile draws the same way whichever capability owns the group.
 */

import {
  type BackupTargetView,
  backupTargetProviderId,
  getBackupStatus,
} from "@opensesame/app-core/lib/backup.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  HISTORY_BACKUP_GROUPS,
  isHistorySelected,
  loadHistorySelections,
} from "@opensesame/app-core/lib/history-backups.js";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { BackupEnableSwitch } from "../connections/BackupEnableSwitch.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";

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

/**
 * The Host's GitHub backup target, or null with no Host / no target. Only a
 * group that can hold the backup road asks (`enabled`); the others would
 * each send the Host the same question for a tile they do not draw.
 */
export function useHostBackupTarget(enabled = true): BackupTargetView | null {
  const [target, setTarget] = useState<BackupTargetView | null>(null);
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled]);
  return target;
}

/** Which provider the Host target is bound to, for matching a tile. */
export function hostTargetProviderId(
  target: BackupTargetView | null,
): string | null {
  return target ? backupTargetProviderId(target) : null;
}

export function FeatureBindingTile({
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
