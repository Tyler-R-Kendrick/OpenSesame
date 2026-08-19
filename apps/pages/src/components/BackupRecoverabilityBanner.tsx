import { useEffect, useState } from "react";
import { Link } from "react-router";
import { getBackupStatus } from "../lib/backup.js";
import {
  getVaultHostBackupState,
  subscribeVaultHostBackup,
} from "../lib/vault/host-backup.js";
import { IconAlert } from "./Icons.js";

/**
 * Always-visible recoverability signal: vault must reach Host + GitHub.
 */
export function BackupRecoverabilityBanner() {
  const [hostPush, setHostPush] = useState(getVaultHostBackupState);
  const [backupHint, setBackupHint] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeVaultHostBackup(() => setHostPush(getVaultHostBackupState())),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getBackupStatus();
        if (cancelled) return;
        if (!status.target) {
          setBackupHint(
            "No GitHub backup target — configure Settings → Data → GitHub recoverability.",
          );
        } else if (status.target.status === "suspended") {
          setBackupHint(
            status.target.lastError ||
              "GitHub backup suspended — reopen Settings → GitHub recoverability.",
          );
        } else if (status.pendingEvents > 0) {
          setBackupHint(
            `${status.pendingEvents} backup event(s) waiting to commit to GitHub.`,
          );
        } else {
          setBackupHint(null);
        }
      } catch {
        if (!cancelled) {
          setBackupHint(
            "Could not read GitHub backup status — Host may be unreachable.",
          );
        }
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const messages = [
    hostPush.lastError,
    hostPush.pendingCount > 0
      ? `${hostPush.pendingCount} vault change(s) not yet on Host.`
      : null,
    backupHint,
  ].filter(Boolean) as string[];

  if (messages.length === 0) return null;

  return (
    <div className="banner banner--warn" role="alert">
      <IconAlert />
      <div>
        <strong>Recoverability</strong>
        <ul>
          {messages.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
        <Link to="/settings#github-backup">Open GitHub backup</Link>
      </div>
    </div>
  );
}
