/** Mount the shared backup forms for this exact verified native bucket. */
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import {
  nativeGithubBackupTarget,
  openNativeGithubBackup,
} from "@opensesame/app-core/lib/native-github-backup.js";
import { openNativeS3Backup } from "@opensesame/app-core/lib/native-s3-backup.js";
import type { SecretBackendBackupHandle } from "@opensesame/app-core/lib/secret-backends/backup-transfer.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { SecretBackendBackupControls } from "../secret-backends/SecretBackendBackupControls.js";
import { nativeVerified } from "./native-connector-ui-values.js";

type BackupOptions = Parameters<typeof openNativeS3Backup>[1];
type BackupOpeners = Readonly<
  Record<
    string,
    (
      id: string,
      parameters: Record<string, string>,
      options: BackupOptions,
    ) => Promise<SecretBackendBackupHandle>
  >
>;
const openers = {
  s3: (id, _parameters, options) => openNativeS3Backup(id, options),
  github: (id, parameters, options) => {
    const target = nativeGithubBackupTarget(parameters);
    if (!target) throw new Error("Configure a GitHub backup repository first.");
    return openNativeGithubBackup(id, target, options);
  },
} satisfies BackupOpeners;

function checkRendered(
  connectionId: string,
  revision: number,
  fingerprint: string,
  providerId: string,
) {
  const current = readNativeConnector(connectionId);
  if (
    !current ||
    !nativeVerified(current) ||
    current.providerId !== providerId ||
    current.revision !== revision ||
    current.fingerprint !== fingerprint
  )
    throw new Error(
      "The saved backup connection changed. Reopen its configuration.",
    );
}

export function NativeVaultBackupControls({
  view,
  onFlash,
}: {
  view: NativeConnectorView;
  onFlash: (flash: Flash) => void;
}) {
  const { connectionId, revision, fingerprint, providerId } = view;
  const {
    backup_owner = "",
    backup_repo = "",
    backup_branch = "",
  } = view.configuration.parameters;
  const [handle, setHandle] = useState<SecretBackendBackupHandle | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    let captured: SecretBackendBackupHandle | null = null;
    const check = () => {
      lifetime.signal.throwIfAborted();
      checkRendered(connectionId, revision, fingerprint, providerId);
    };
    const withdrawn = () => setHandle(null);
    async function open() {
      try {
        check();
        if (providerId !== "s3" && providerId !== "github")
          throw new Error("No native backup adapter is configured.");
        const opener = openers[providerId];
        const next = await opener(
          connectionId,
          { backup_owner, backup_repo, backup_branch },
          {
            vault: vaultStore,
            signal: lifetime.signal,
            assertCurrent: check,
          },
        );
        captured = next;
        check();
        next.session.signal?.throwIfAborted();
        next.session.signal?.addEventListener("abort", withdrawn, {
          once: true,
        });
        setHandle(next);
      } catch {
        if (captured) void captured.backend.disconnect(captured.session);
        if (!lifetime.signal.aborted)
          setFailure("The saved backup authority is no longer available.");
      }
    }
    void open();
    return () => {
      captured?.session.signal?.removeEventListener("abort", withdrawn);
      lifetime.abort();
      if (captured) void captured.backend.disconnect(captured.session);
    };
  }, [
    connectionId,
    revision,
    fingerprint,
    providerId,
    backup_owner,
    backup_repo,
    backup_branch,
  ]);
  return (
    <>
      {handle ? (
        <SecretBackendBackupControls handle={handle} onFlash={onFlash} />
      ) : null}
      <FailureNotice
        id={`native-backup-${view.connectionId}`}
        title="Encrypted vault backups"
        message={failure}
      />
    </>
  );
}
export { NativeVaultBackupControls as NativeS3BackupControls };
