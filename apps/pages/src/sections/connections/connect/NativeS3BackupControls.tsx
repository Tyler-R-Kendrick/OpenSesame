/** Mount the shared backup forms for this exact verified native bucket. */
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { openNativeS3Backup } from "@opensesame/app-core/lib/native-s3-backup.js";
import type { SecretBackendBackupHandle } from "@opensesame/app-core/lib/secret-backends/backup-transfer.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { SecretBackendBackupControls } from "../secret-backends/SecretBackendBackupControls.js";
import { nativeVerified } from "./native-connector-ui-values.js";

function checkRendered(
  connectionId: string,
  revision: number,
  fingerprint: string,
) {
  const current = readNativeConnector(connectionId);
  if (
    !current ||
    !nativeVerified(current) ||
    current.providerId !== "s3" ||
    current.revision !== revision ||
    current.fingerprint !== fingerprint
  )
    throw new Error(
      "The saved S3 connection changed. Reopen its configuration.",
    );
}

export function NativeS3BackupControls({
  view,
  onFlash,
}: {
  view: NativeConnectorView;
  onFlash: (flash: Flash) => void;
}) {
  const { connectionId, revision, fingerprint } = view;
  const [handle, setHandle] = useState<SecretBackendBackupHandle | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    let captured: SecretBackendBackupHandle | null = null;
    const check = () => {
      lifetime.signal.throwIfAborted();
      checkRendered(connectionId, revision, fingerprint);
    };
    const withdrawn = () => setHandle(null);
    async function open() {
      try {
        check();
        const next = await openNativeS3Backup(connectionId, {
          vault: vaultStore,
          signal: lifetime.signal,
          assertCurrent: check,
        });
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
          setFailure("The saved S3 backup authority is no longer available.");
      }
    }
    void open();
    return () => {
      captured?.session.signal?.removeEventListener("abort", withdrawn);
      lifetime.abort();
      if (captured) void captured.backend.disconnect(captured.session);
    };
  }, [connectionId, revision, fingerprint]);
  return (
    <>
      {handle ? (
        <SecretBackendBackupControls handle={handle} onFlash={onFlash} />
      ) : null}
      <FailureNotice
        id={`native-s3-backup-${view.connectionId}`}
        title="Encrypted S3 vault backups"
        message={failure}
      />
    </>
  );
}
