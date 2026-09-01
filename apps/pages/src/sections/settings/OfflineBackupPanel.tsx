import { useRef, useState } from "react";
import { IconDownload, IconUpload } from "../../components/Icons.js";
import { activeProject } from "../../lib/projects.js";
import { loadSettings } from "../../lib/settings.js";
import type { SealedBlob } from "../../lib/vault/crypto.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import {
  MAX_OFFLINE_BACKUP_BYTES,
  buildOfflineBackup,
  cacheCiphertextSnapshot,
  enqueueOfflineMutation,
  parseOfflineBackup,
  serializeOfflineBackup,
} from "../../lib/vault/offline-backup.js";
import { BODY_PATH, readSealedFile } from "../../lib/vfs.js";

function Status({
  message,
}: { message: { tone: "ok" | "err"; text: string } | null }) {
  if (!message) return null;
  return (
    <p
      className={`note note--${message.tone}`}
      role={message.tone === "err" ? "alert" : "status"}
    >
      <span>{message.text}</span>
    </p>
  );
}

function readSealedBody(): SealedBlob {
  const body = readSealedFile(activeProject().id, BODY_PATH);
  if (!body) throw new Error("There is nothing stored to export yet.");
  return body;
}

export function OfflineBackupPanel() {
  const { header, status } = useVault();
  const store = useVaultStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importPassword, setImportPassword] = useState("");
  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const projectId = loadSettings().activeProjectId?.trim() || null;
  const canExport = Boolean(header) && status !== "empty";

  function onExport() {
    setMessage(null);
    try {
      if (!header) throw new Error("There is no vault to export.");
      const envelope = buildOfflineBackup({
        projectId,
        header,
        body: readSealedBody(),
      });
      cacheCiphertextSnapshot(envelope);
      const text = serializeOfflineBackup(envelope);
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `opensesame-offline-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage({
        tone: "ok",
        text: "Downloaded an encrypted offline backup. The file is as sensitive as the vault — protect it on disk. Host never saw your unlock key.",
      });
    } catch (caught) {
      setMessage({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Export failed.",
      });
    }
  }

  async function onImport(file: File) {
    setMessage(null);
    if (!importPassword) {
      setMessage({
        tone: "err",
        text: "Enter the master password that backup was sealed under.",
      });
      return;
    }
    if (file.size > MAX_OFFLINE_BACKUP_BYTES) {
      setMessage({
        tone: "err",
        text: "That offline backup is larger than 64 MB.",
      });
      return;
    }
    setBusy(true);
    try {
      const envelope = parseOfflineBackup(await file.text());
      cacheCiphertextSnapshot(envelope);
      const legacy = JSON.stringify({
        format: "opensesame-vault-export",
        v: 1,
        exportedAt: envelope.exportedAt,
        header: envelope.vault.header,
        body: envelope.vault.body,
      });
      const added = await store.importSealed(legacy, importPassword);
      if (envelope.syncBlobs.length > 0 && !navigator.onLine) {
        enqueueOfflineMutation({
          kind: "push_sync_blobs",
          projectId: envelope.projectId,
          blobs: envelope.syncBlobs,
        });
      }
      setImportPassword("");
      setMessage({
        tone: "ok",
        text:
          added === 0
            ? "Backup restored (no new items). Ciphertext cache updated for offline use."
            : `Restored ${added} ${added === 1 ? "item" : "items"} from encrypted backup.`,
      });
    } catch (caught) {
      setMessage({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Import failed.",
      });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Offline encrypted backup</h2>
        </div>
      </div>
      <div className="panel__body">
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={!canExport || busy}
            onClick={onExport}
          >
            <IconDownload size={16} />
            Download offline backup
          </button>
          <input
            ref={fileRef}
            id="offline-backup-file"
            type="file"
            accept="application/json"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onImport(file);
            }}
          />
          <label htmlFor="offline-backup-file" className="btn">
            <IconUpload size={16} />
            Restore offline backup
          </label>
        </div>
        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label htmlFor="offline-backup-password">
            Master password for restore
          </label>
          <input
            id="offline-backup-password"
            type="password"
            autoComplete="current-password"
            value={importPassword}
            disabled={busy || status !== "unlocked"}
            onChange={(event) => setImportPassword(event.target.value)}
          />
        </div>
        <Status message={message} />
      </div>
    </section>
  );
}
