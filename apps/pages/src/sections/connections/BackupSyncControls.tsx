import { subscribeLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
import {
  type BackupTargetView,
  getBackupStatus,
  resyncBackup,
} from "@opensesame/app-core/lib/backup.js";
import { startVaultBackupObserver } from "@opensesame/app-core/lib/vault-backup-observer.js";
import {
  syncLabel,
  syncTone,
  targetMatchesProvider,
} from "@opensesame/app-core/sections/connections/backup-sync-controls-model.js";
/**
 * Manual backup sync + last-sync fact for the local GitHub App backup target.
 * Sync is an icon key; status is a StatusMark — never a word-verb button.
 */
import { useEffect, useState } from "react";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function BackupSyncControls({
  providerId = "github",
}: {
  providerId?: string;
}) {
  const [target, setTarget] = useState<BackupTargetView | null>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);

  useEffect(() => {
    const stopObserver = startVaultBackupObserver();
    let live = true;
    const reload = (): void => {
      void getBackupStatus(providerId)
        .then((status) => {
          if (!live) return;
          const bound = status.target;
          if (bound && targetMatchesProvider(bound, providerId)) {
            setTarget(bound);
            setPending(status.pendingEvents);
          } else {
            setTarget(null);
            setPending(0);
          }
        })
        .catch(() => {
          // Keep the last known target; a transient status miss is not "unbound".
          if (live) setFlash("err");
        });
    };
    reload();
    const unsubscribe = subscribeLocalBackupTarget(reload);
    return () => {
      live = false;
      unsubscribe();
      stopObserver();
    };
  }, [providerId]);

  if (!target) return null;

  const repo =
    target.owner && target.repo ? `${target.owner}/${target.repo}` : null;

  return (
    <div className="conn-github-fact" data-testid="backup-sync-controls">
      <span className="conn-github-presence__k">Sync</span>
      <span className="conn-backup-sync">
        <StatusMark
          tone={syncTone(target)}
          label={syncLabel(target, pending)}
        />
        {repo ? <span className="conn-backup-sync__repo">{repo}</span> : null}
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={busy || !target.enabled}
          aria-busy={busy || undefined}
          aria-label="Sync vault backup now"
          title="Sync vault backup now"
          onClick={() => {
            if (busy || !target.enabled) return;
            setBusy(true);
            setFlash(null);
            void resyncBackup(providerId)
              .then(() => {
                setFlash("ok");
                return getBackupStatus(providerId);
              })
              .then((status) => {
                if (status.target) setTarget(status.target);
                setPending(status.pendingEvents);
              })
              .catch(() => {
                setFlash("err");
                return getBackupStatus(providerId).then((status) => {
                  if (status.target) setTarget(status.target);
                  setPending(status.pendingEvents);
                });
              })
              .finally(() => setBusy(false));
          }}
        >
          <IconRefresh size={16} />
        </button>
        {flash === "ok" ? (
          <StatusMark tone="ok" label="Synced" />
        ) : flash === "err" ? (
          <StatusMark tone="err" label="Sync failed" />
        ) : null}
      </span>
    </div>
  );
}
