/**
 * What a recovery handed back, put in this vault through the Import sheet the
 * vault already has (ADR 0187 §10): the recovered document is a CXF file, the
 * import pipeline recognises it, previews it and merges it under one explicit
 * action. Nothing here reads or writes an item, and nothing is merged twice.
 *
 * The file is made from the text the panel kept and handed to the sheet; the
 * sheet's own key for another file opens the picker it would open anywhere.
 */

import { IMPORT_ACCEPT } from "@opensesame/app-core/sections/vault/import/preview.js";
import { useRef, useState } from "react";
import { ImportSheet } from "../../../sections/vault/import/ImportSheet.js";
import { fileName } from "../packet-field.js";
import { recoveredFileName } from "./recovery-model.js";
import type { Recovered } from "./use-recovered.js";

export function ImportRecovered({
  item,
  onClose,
  onImported,
}: {
  item: Recovered;
  onClose: () => void;
  /** What the recovery held has been written to the vault. */
  onImported: () => void;
}) {
  const [recovered] = useState(
    () =>
      new File([item.text], fileName(recoveredFileName(item.label)), {
        type: "application/json",
      }),
  );
  const [file, setFile] = useState(recovered);
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={picker}
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
      <ImportSheet
        file={file}
        onRepick={() => picker.current?.click()}
        onClose={onClose}
        // Only the recovered document ends the recovery; another file chosen
        // from the sheet's own key does not.
        onImported={file === recovered ? onImported : undefined}
      />
    </>
  );
}
