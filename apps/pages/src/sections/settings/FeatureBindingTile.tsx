/**
 * One feature-binding tile: a connector the capability family is bound to,
 * with the enable switch where the binding is a backup road. Shared by the
 * Connections settings panel and the backup modules' own panels, so the
 * tile draws the same way whichever capability owns the group.
 *
 * A tile links to its connector's page only while that page is routed
 * (`href`, ADR 0153). Without one it is the tile's own switch and nothing
 * else — never a link to a page that is not there (ADR 0158).
 */

import {
  type BackupTargetView,
  backupTargetProviderId,
  getBackupStatus,
} from "@opensesame/app-core/lib/backup.js";
import { hasHistorySwitch } from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  isHistorySelected,
  loadHistorySelections,
} from "@opensesame/app-core/lib/history-backups.js";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { IconChevronRight } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { BackupEnableSwitch } from "../connections/BackupEnableSwitch.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";

function historyRemote(providerId: string): string | null {
  const remote = loadHistorySelections()
    .find((row) => row.providerId === providerId)
    ?.remote?.trim();
  return remote || null;
}

function targetRemote(target: BackupTargetView): string | null {
  if (target.owner && target.repo) return `${target.owner}/${target.repo}`;
  return null;
}

/**
 * The backup target saved on this device for GitHub, or null with none. Only
 * a group that can hold the backup road asks (`enabled`); the others would
 * each read the same target for a tile they do not draw.
 */
export function useBackupTarget(enabled = true): BackupTargetView | null {
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

/** Which provider the saved target is bound to, for matching a tile. */
export function backupTargetProvider(
  target: BackupTargetView | null,
): string | null {
  return target ? backupTargetProviderId(target) : null;
}

export function FeatureBindingTile({
  provider,
  href,
  target,
}: {
  provider: Provider;
  /** The connector's page, or null while no page is routed. */
  href: string | null;
  /** The saved backup target when this tile's provider holds it. */
  target: BackupTargetView | null;
}) {
  const bound = target !== null;
  const historyBound = !bound && hasHistorySwitch(provider.id);
  const enabled = bound
    ? target.enabled
    : historyBound && isHistorySelected(provider.id);
  const remote = bound
    ? targetRemote(target)
    : historyBound
      ? historyRemote(provider.id)
      : null;
  const showSwitch = bound || historyBound;

  const face = (
    <>
      <ConnectorMark
        providerId={provider.id}
        displayName={provider.displayName}
        size={32}
      />
      <span className="conn-tile__copy">
        <span className="conn-tile__name">{provider.displayName}</span>
        {remote ? <span className="conn-tile__kind">{remote}</span> : null}
      </span>
      {/* On with nowhere to go: GitHub is the history default, so its
          switch read "on" for a guest who had named no repository and
          was backing nothing up. The mark is drawn whether or not the
          tile's page is routed: a person can change it, by naming a
          repository on that page, or by switching Connections on to reach
          it (ADR 0158). */}
      {enabled && !remote ? (
        <StatusMark
          tone="warn"
          label="No repository yet — nothing is backed up"
        />
      ) : null}
    </>
  );

  return (
    <li className={`conn-tile${enabled ? " is-on" : ""}`}>
      <div className="conn-tile__row">
        {href === null ? (
          <span className="conn-tile__face">{face}</span>
        ) : (
          <Link className="conn-tile__link" to={href}>
            {face}
            <IconChevronRight className="conn-tile__go" size={14} />
          </Link>
        )}
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
