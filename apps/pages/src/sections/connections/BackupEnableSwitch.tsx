/**
 * Binary enable switch for a backup/recovery connector.
 *
 * A bound local backup target flips `enabled` (and queues a vault sync).
 * Otherwise the switch toggles vault-history selection for that provider.
 */
import { type MouseEvent, useEffect, useState } from "react";
import {
  type BackupTargetView,
  backupTargetProviderId,
  getBackupStatus,
  setBackupTargetEnabled,
} from "../../lib/backup.js";
import {
  HISTORY_BACKUP_GROUPS,
  isHistorySelected,
  toggleHistoryProvider,
} from "../../lib/history-backups.js";
import { useSettingsEpoch } from "../../lib/use-settings.js";

function historyToggleable(providerId: string): boolean {
  return (HISTORY_BACKUP_GROUPS[0]?.providerIds ?? []).includes(providerId);
}

export function canBackupEnable(providerId: string): boolean {
  return historyToggleable(providerId);
}

export function BackupEnableSwitch({
  providerId,
  displayName,
}: {
  providerId: string;
  displayName: string;
}) {
  useSettingsEpoch();
  const [target, setTarget] = useState<BackupTargetView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void getBackupStatus(providerId)
      .then((status) => {
        if (!live) return;
        const bound = status.target;
        if (bound && backupTargetProviderId(bound) === providerId) {
          setTarget(bound);
        } else {
          setTarget(null);
        }
      })
      .catch(() => {
        if (live) setTarget(null);
      });
    return () => {
      live = false;
    };
  }, [providerId]);

  if (!historyToggleable(providerId)) return null;

  const bound = target !== null;
  const enabled = bound ? target.enabled : isHistorySelected(providerId);
  const label = bound
    ? `${displayName} backup`
    : `${displayName} vault history`;

  async function onToggle(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    if (bound) {
      const next = !target.enabled;
      setBusy(true);
      setTarget({ ...target, enabled: next });
      try {
        setTarget(await setBackupTargetEnabled(next, providerId));
      } catch {
        setTarget({ ...target, enabled: target.enabled });
      } finally {
        setBusy(false);
      }
      return;
    }
    await toggleHistoryProvider(providerId);
  }

  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={enabled}
      aria-pressed={enabled}
      aria-busy={busy || undefined}
      disabled={busy}
      aria-label={label}
      title={label}
      onClick={(event) => void onToggle(event)}
    />
  );
}
