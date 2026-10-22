import {
  subscribePendingImport,
  takePendingImport,
} from "@opensesame/app-core/lib/vault/pending-import.js";
import { IMPORT_ACCEPT } from "@opensesame/app-core/sections/vault/import/preview.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconDownload } from "../../../components/Icons.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import { useAddEntry } from "../add-menu.js";
import { ImportSheet } from "./ImportSheet.js";

/**
 * The import flow: the OS file picker, and the sheet the chosen file opens
 * beside the list, where it is previewed and merged under a second, explicit
 * action (ADR 0052 §6). Nothing is read until a file is picked, and nothing is
 * written until the sheet commits.
 */
function useImportFlow() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileNow = useRef<File | null>(file);
  fileNow.current = file;
  const queued = useRef(false);
  // A file chosen at the door waited for this vault (ADR 0188): whichever Import
  // key mounts first takes it, so its sheet is open as soon as the vault is.
  useEffect(() => {
    const take = () => {
      if (fileNow.current !== null) {
        queued.current = true;
        return;
      }
      const waiting = takePendingImport();
      if (waiting) setFile(waiting);
    };
    take();
    return subscribePendingImport(take);
  }, []);
  const pick = useCallback(() => fileRef.current?.click(), []);
  const close = useCallback(() => {
    setFile(null);
    if (!queued.current) return;
    queued.current = false;
    const waiting = takePendingImport();
    if (waiting) setFile(waiting);
  }, []);
  const element = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept={IMPORT_ACCEPT}
        className="visually-hidden"
        tabIndex={-1}
        aria-label="Choose a file to import"
        onChange={(event) => {
          const picked = event.target.files?.[0];
          // Cleared so the same file can be picked again after a cancel.
          event.target.value = "";
          if (picked) setFile(picked);
        }}
      />
      {file ? (
        <ImportSheet file={file} onRepick={pick} onClose={close} />
      ) : null}
    </>
  );
  return { pick, close, open: file !== null, element };
}

/**
 * The vault path strip's Import key (`vault.interop-formats`). It opens the
 * OS file picker directly — the one click before the dialog.
 */
export function ImportKey() {
  const guideRef = useGuideTarget<HTMLButtonElement>("vault.import");
  const flow = useImportFlow();
  return (
    <>
      <button
        ref={guideRef}
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Import items"
        title="Import items"
        aria-haspopup="dialog"
        aria-expanded={flow.open}
        onClick={flow.pick}
      >
        <IconDownload size={15} />
      </button>
      {flow.element}
    </>
  );
}

/**
 * Import as one of the Add button's other ways to add, on a phone: the same
 * flow, chosen by holding the button and sliding up instead of a key of its
 * own.
 */
export function ImportEntry() {
  const flow = useImportFlow();
  useAddEntry({
    id: "import",
    label: "Import items",
    order: 10,
    slide: "up",
    run: flow.pick,
  });
  return flow.element;
}
