import { subscribeLocalBackupTarget } from "@opensesame/app-core/lib/backup-target-local.js";
import {
  type BackupTargetView,
  getBackupStatus,
  resyncBackup,
} from "@opensesame/app-core/lib/backup.js";
import type { SecretBackendBackupHandle } from "@opensesame/app-core/lib/secret-backends/backup-transfer.js";
import { openSavedGithubBackup } from "@opensesame/app-core/lib/vault-backup-github.js";
import { startVaultBackupObserver } from "@opensesame/app-core/lib/vault-backup-observer.js";
import {
  needsInitialBackup,
  syncLabel,
  syncTone,
  targetMatchesProvider,
} from "@opensesame/app-core/sections/connections/backup-sync-controls-model.js";
/**
 * Manual backup sync + last-sync fact for the local GitHub App backup target.
 * Sync is an icon key; status is a StatusMark — never a word-verb button.
 */
import { useEffect, useRef, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconDownload, IconRefresh, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { SecretBackendBackupControls } from "./secret-backends/SecretBackendBackupControls.js";

function useBackupSyncStatus(providerId: string) {
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

  return {
    target,
    setTarget,
    pending,
    setPending,
    busy,
    setBusy,
    flash,
    setFlash,
  };
}

export function BackupSyncControls({
  providerId = "github",
}: {
  providerId?: string;
}) {
  const {
    target,
    setTarget,
    pending,
    setPending,
    busy,
    setBusy,
    flash,
    setFlash,
  } = useBackupSyncStatus(providerId);

  if (!target) return null;
  const initial = needsInitialBackup(target);
  const syncNow = () => {
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
  };

  const repo =
    target.owner && target.repo ? `${target.owner}/${target.repo}` : null;

  return (
    <>
      <div className="conn-github-fact" data-testid="backup-sync-controls">
        <span className="conn-github-presence__k">Sync</span>
        <span className="conn-backup-sync">
          <StatusMark
            tone={syncTone(target)}
            label={syncLabel(target, pending)}
          />
          {repo ? <span className="conn-backup-sync__repo">{repo}</span> : null}
          {!initial ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              disabled={busy || !target.enabled}
              aria-busy={busy || undefined}
              aria-label="Sync vault backup now"
              title="Sync vault backup now"
              onClick={syncNow}
            >
              <IconRefresh size={16} />
            </button>
          ) : null}
          {flash === "ok" ? (
            <StatusMark tone="ok" label="Synced" />
          ) : flash === "err" ? (
            <StatusMark tone="err" label="Sync failed" />
          ) : null}
        </span>
      </div>
      {target.kind === "github_app" ? (
        <GithubRestoreControls
          key={providerId}
          providerId={providerId}
          enabled={target.enabled}
        />
      ) : null}
      {initial ? (
        <InitialGithubBackup
          busy={busy}
          enabled={target.enabled}
          onBackup={syncNow}
        />
      ) : null}
    </>
  );
}

function InitialGithubBackup({
  busy,
  enabled,
  onBackup,
}: {
  busy: boolean;
  enabled: boolean;
  onBackup: () => void;
}) {
  return (
    <section className="cx-block cx-form" aria-label="Choose backup direction">
      <p>
        Recovering this vault? Read and restore its encrypted backup first.
        Backing up this vault replaces the repository's backup. Automatic
        updates start after a successful manual backup.
      </p>
      <FormCommit
        label="Back up this vault and enable automatic backups"
        disabled={busy || !enabled}
        busy={busy}
        icon={<IconRefresh size={18} />}
        onClick={onBackup}
      />
    </section>
  );
}

function useGithubBackupRestore(providerId: string) {
  const lifetime = useRef<AbortController | null>(null);
  const [handle, setHandle] = useState<SecretBackendBackupHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(
    () => () => {
      const captured = lifetime.current;
      lifetime.current = null;
      captured?.abort();
    },
    [],
  );
  const close = () => {
    const captured = lifetime.current;
    lifetime.current = null;
    captured?.abort();
    setHandle(null);
    setBusy(false);
  };
  const open = () => {
    close();
    setFailure("");
    const controller = new AbortController();
    lifetime.current = controller;
    const check = () => {
      controller.signal.throwIfAborted();
      if (lifetime.current !== controller)
        throw new DOMException("This restore ended.", "AbortError");
    };
    setBusy(true);
    void openSavedGithubBackup(providerId, {
      signal: controller.signal,
      assertCurrent: check,
    })
      .then((opened) => {
        check();
        opened.backend.signal?.addEventListener(
          "abort",
          () => {
            if (lifetime.current === controller) close();
          },
          { once: true },
        );
        setHandle(opened);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setFailure("The encrypted GitHub backup could not be read.");
      })
      .finally(() => {
        if (lifetime.current === controller) setBusy(false);
      });
  };
  return { handle, busy, failure, setFailure, close, open };
}

function GithubRestoreControls({
  providerId,
  enabled,
}: { providerId: string; enabled: boolean }) {
  const { handle, busy, failure, setFailure, close, open } =
    useGithubBackupRestore(providerId);
  return (
    <>
      {handle ? (
        <SecretBackendBackupControls
          handle={handle}
          fixedReference="opensesame-vault.backup.json"
          onFlash={(flash) => {
            if (flash.tone === "err") setFailure(flash.text);
          }}
        />
      ) : (
        <FormCommit
          label="Read encrypted vault backup"
          disabled={busy || !enabled}
          busy={busy}
          icon={<IconDownload size={18} />}
          onClick={open}
        >
          {failure ? <StatusMark tone="err" label={failure} /> : null}
        </FormCommit>
      )}
      {busy || handle ? (
        <FormCommit
          label="Close encrypted backup"
          icon={<IconX size={18} />}
          onClick={close}
        />
      ) : null}
      {!handle ? (
        <FailureNotice
          id={`github-backup-read-${providerId}`}
          title="Read encrypted vault backup"
          message={failure}
        />
      ) : null}
    </>
  );
}
