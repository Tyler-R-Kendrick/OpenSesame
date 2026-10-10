import { sealedExportUnlock } from "@opensesame/app-core/lib/vault/offline-backup-file.js";
import { canTakeBackupIdentity } from "@opensesame/app-core/sections/vault/import/model.js";
import type { ReactNode } from "react";
import { useRef } from "react";
import { IconDownload, IconFolder, IconX } from "../../../components/Icons.js";
import { useModalFocus } from "../../../lib/modal-focus.js";
import { useVault } from "../../../lib/vault/hooks.js";
import {
  DoneCard,
  FailedCard,
  LockedCard,
  ReadingCard,
  SealedCard,
  UnreadableCard,
} from "./ImportCards.js";
import { ImportPreview } from "./ImportPreview.js";
import { ManifestCard } from "./ManifestCard.js";
import { type ImportFlow, useImportFlow } from "./useImportFlow.js";
import "./import.css";

function StageBody({
  flow,
  onClose,
}: {
  flow: ImportFlow;
  onClose: () => void;
}): ReactNode {
  const vault = useVault();
  const { folders } = vault;
  const { stage, error, busy } = flow;
  switch (stage.step) {
    case "reading":
      return <ReadingCard fileName={stage.fileName} />;
    case "unreadable":
      return <UnreadableCard fileName={stage.fileName} error={error} />;
    case "failed":
      return (
        <FailedCard
          fileName={stage.fileName}
          error={error}
          busy={busy}
          onPick={flow.reparse}
        />
      );
    case "locked":
      return (
        <LockedCard
          fileName={stage.fileName}
          source={stage.source}
          note={stage.note}
          busy={busy}
          error={error}
          onUnlock={flow.unlock}
        />
      );
    case "sealed":
      return (
        <SealedCard
          fileName={stage.fileName}
          opener={sealedExportUnlock(stage.sealed)}
          busy={busy}
          error={error}
          canTakeIdentity={canTakeBackupIdentity(vault)}
          onRestore={flow.restore}
          onPasskey={flow.restorePasskey}
        />
      );
    case "manifest":
      return flow.manifestPlan ? (
        <ManifestCard
          fileName={stage.fileName}
          entries={stage.entries}
          plan={flow.manifestPlan}
          busy={busy}
          error={error}
          onConfirm={flow.confirm}
        />
      ) : null;
    case "preview":
      return flow.plan && flow.choice ? (
        <ImportPreview
          fileName={stage.fileName}
          result={stage.result}
          plan={flow.plan}
          choice={flow.choice}
          folders={folders}
          busy={busy}
          error={error}
          setChoice={flow.setChoice}
          reparse={flow.reparse}
          confirm={flow.confirm}
        />
      ) : null;
    case "done":
      return (
        <DoneCard
          added={stage.added}
          skipped={stage.skipped}
          restored={stage.restored}
          updated={stage.updated}
          onClose={onClose}
        />
      );
  }
}

/**
 * The import sheet: the side sheet (a bottom sheet on a phone) the Import
 * key opens once a file is picked. It reads the file on this device, shows
 * what it holds, and writes only when its one commit is pressed. Another
 * file can be picked from its head without closing it.
 */
export function ImportSheet({
  file,
  onRepick,
  onClose,
  onImported,
}: {
  file: File;
  onRepick: () => void;
  onClose: () => void;
  /** Called once when what the file held has been written to the vault. */
  onImported?: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const flow = useImportFlow(file, onImported);
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className="sheet imp"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label="Import items"
        aria-modal="true"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            <IconDownload size={20} />
          </span>
          <div className="sheet__grow">
            <h2>Import</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Choose another file"
            title="Choose another file"
            disabled={flow.busy}
            onClick={onRepick}
          >
            <IconFolder size={18} />
          </button>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">
          <StageBody flow={flow} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}
