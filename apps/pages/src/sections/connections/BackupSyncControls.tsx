/**
 * Manual backup sync + last-sync fact for the local GitHub App backup target.
 * Sync is an icon key; status is a StatusMark — never a word-verb button.
 */
import { useEffect, useState } from "react";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  type BackupTargetView,
  getBackupStatus,
  resyncBackup,
} from "../../lib/backup.js";
import { startVaultBackupObserver } from "../../lib/vault-backup-observer.js";

function syncTone(target: BackupTargetView): "ok" | "err" | "warn" | "idle" {
  if (!target.enabled) return "idle";
  if (target.status === "ok") return "ok";
  if (target.status === "suspended") return "err";
  return "warn";
}

function syncLabel(target: BackupTargetView, pending: number): string {
  if (!target.enabled) return "Backup off";
  const synced = target.lastSyncedAt
    ? `Last sync ${target.lastSyncedAt}`
    : "Waiting for first sync";
  return pending > 0 ? `${synced} · ${pending} pending` : synced;
}

function targetMatchesProvider(
  bound: BackupTargetView,
  providerId: string,
): boolean {
  return (
    bound.providerId === providerId ||
    (bound.kind === "github_app" && providerId === "github")
  );
}

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
        if (live) {
          setTarget(null);
          setPending(0);
        }
      });
    return () => {
      live = false;
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
              .catch(() => setFlash("err"))
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
