import { IMPORT_ACCEPT } from "@opensesame/app-core/sections/vault/import/preview.js";
import { useCallback, useRef, useState } from "react";
import { IconDownload } from "../../../components/Icons.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import { ImportSheet } from "./ImportSheet.js";

/**
 * The vault path strip's Import key (`vault.interop-formats`), or on a phone
 * (`row`) the same flow as a labelled row among the vault's tools. It opens the
 * OS file picker directly — the one click before the dialog — and the file
 * chosen opens the import sheet beside the list, where it is previewed and
 * merged under a second, explicit action (ADR 0052 §6). Nothing is read
 * until a file is picked, and nothing is written until the sheet commits.
 */
export function ImportKey({ row = false }: { row?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const guideRef = useGuideTarget<HTMLButtonElement>("vault.import");
  const [file, setFile] = useState<File | null>(null);
  const pick = useCallback(() => fileRef.current?.click(), []);
  const close = useCallback(() => setFile(null), []);
  return (
    <>
      <button
        ref={guideRef}
        type="button"
        className={row ? "choice vtool" : "icon-btn icon-btn--sm"}
        aria-label="Import items"
        title="Import items"
        aria-haspopup="dialog"
        aria-expanded={file !== null}
        onClick={pick}
      >
        <IconDownload size={row ? 20 : 15} />
        {row ? <span className="vtool__name">Import items</span> : null}
      </button>
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
}
