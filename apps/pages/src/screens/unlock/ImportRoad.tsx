/**
 * Start a vault from a file (ADR 0188).
 *
 * The front door's third road, and a quiet link on first-run sign-in, for a
 * person who already has what they want in the vault: an OpenSesame backup
 * (`opensesame-offline-backup-….json`), a `.env` file, or another manager's
 * export. Choosing a file reads nothing. The file is held in memory
 * (`lib/vault/pending-import.ts`) while the person seals the vault the way
 * anyone does, and the vault's Import key takes it from there, opening the
 * sheet every import already uses. The door imports no pipeline: nothing
 * optional loads before an approved plan says so (ADR 0130).
 */

import {
  IMPORT_ACCEPT,
  discardPendingImport,
  holdPendingImport,
} from "@opensesame/app-core/lib/vault/pending-import.js";
import { useRef } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconDownload, IconX } from "../../components/Icons.js";

/** The OS picker, and what to do with the file it hands back. */
function useImportPicker() {
  const input = useRef<HTMLInputElement>(null);
  const picker = (
    <input
      ref={input}
      type="file"
      accept={IMPORT_ACCEPT}
      className="visually-hidden"
      tabIndex={-1}
      aria-label="Choose a file to import"
      onChange={(event) => {
        const picked = event.target.files?.[0];
        // Cleared so the same file can be chosen again after it is removed.
        event.target.value = "";
        if (picked) holdPendingImport(picked);
      }}
    />
  );
  return { open: () => input.current?.click(), picker };
}

/**
 * `road` is the door's card, beside Set up your own and Join a session.
 * `foot` is the sign-in screen's link, beside Use without an account.
 */
export function ImportRoadButton({
  variant = "road",
}: {
  variant?: "road" | "foot";
}) {
  const { open, picker } = useImportPicker();
  if (variant === "foot") {
    return (
      <>
        <button
          type="button"
          className="unlock__switch"
          aria-label="Import a file"
          title="an OpenSesame backup or a .env file"
          onClick={open}
        >
          Import a file
        </button>
        {picker}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className="road road--wide"
        aria-label="Import a file"
        aria-describedby="door-import-kind"
        onClick={open}
      >
        <span className="road__mark" aria-hidden="true">
          <IconDownload size={20} />
        </span>
        <span className="road__name">Import a file</span>
        <span className="road__kind" id="door-import-kind">
          a backup or a .env file
        </span>
      </button>
      {picker}
    </>
  );
}

/**
 * The seal screen's one fact about the file: which it is, and the key that
 * lets it go. Nothing was read, so nothing more can be said of it.
 */
export function PendingImportNote({ file }: { file: File }) {
  return (
    <output className="note unlock__import" aria-live="polite">
      <IconDownload size={16} />
      <span className="unlock__import-name">{file.name}</span>
      <IconKey label="Remove file" small onClick={discardPendingImport}>
        <IconX size={16} />
      </IconKey>
    </output>
  );
}
