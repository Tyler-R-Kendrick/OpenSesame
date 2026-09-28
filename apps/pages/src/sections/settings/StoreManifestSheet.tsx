import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import {
  manifestRefusal,
  storeManifestFile,
} from "@opensesame/app-core/sections/vault/import/store-manifest.js";
import { type RefObject, useRef, useState } from "react";
import {
  type CeremonyFact,
  CeremonyShell,
} from "../../components/CeremonyShell.js";
import { IconUpload, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { useVault } from "../../lib/vault/hooks.js";
import { downloadSeams } from "../../screens/capabilities/download.js";

const NOTICE = "vault-store-manifest";

/** Save the manifest once the sheet's key is pressed; a failure is a notice. */
function useManifestSave(onSaved: (fileName: string) => void) {
  const vault = useVault();
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    try {
      const file = storeManifestFile(vault.items, vault.folders);
      downloadSeams.save(file.fileName, file.text, "application/json");
      setSaved(file.fileName);
      setError(null);
      dismissNotice(NOTICE);
      onSaved(file.fileName);
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "The manifest was not saved.";
      setError(message);
      setStatusNotice({
        id: NOTICE,
        tone: "err",
        title: "Sealed store",
        body: message,
      });
    }
  };
  return { saved, error, save };
}

/** The sheet's head: its mark, its name and the key that closes it. */
function SheetHead({
  closeRef,
  onClose,
}: {
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  return (
    <div className="sheet__head">
      <span className="sheet__mark" aria-hidden="true">
        <IconUpload size={20} />
      </span>
      <div className="sheet__grow">
        <h2>Sealed store</h2>
      </div>
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
  );
}

/**
 * The second press before the vault leaves as plain text. The file holds
 * every value — passwords, card codes, private keys — so it is saved from a
 * sheet that says so, never from the panel's key alone, and a guest vault or
 * a locked one is refused as the encrypted Export refuses it.
 */
export function StoreManifestSheet({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (fileName: string) => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const vault = useVault();
  const count = storeManifestFile(vault.items, vault.folders).count;
  const refusal = manifestRefusal(vault, count);
  const { saved, error, save } = useManifestSave(onSaved);
  const problem = error ?? refusal;

  const facts: CeremonyFact[] = [
    { key: "Entries", value: String(count) },
    { key: "Holds", value: "every value in plain text, private keys included" },
    { key: "Seal with", value: "opensesame pass seal <file> --shred" },
  ];
  if (saved) facts.push({ key: "File", value: saved });

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
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label="Save store path manifest"
        aria-modal="true"
      >
        <SheetHead closeRef={closeRef} onClose={onClose} />
        <div className="sheet__body">
          <CeremonyShell
            ok={problem === null}
            top={saved && problem === null ? "Saved" : undefined}
            name="Store path manifest"
            facts={facts}
            primary={
              refusal === null
                ? {
                    label: saved ? "Save again" : "Save manifest",
                    onClick: save,
                  }
                : undefined
            }
          >
            {problem ? (
              <p className="vexport__marks">
                <StatusMark tone="err" label={problem} />
              </p>
            ) : null}
          </CeremonyShell>
        </div>
      </div>
    </div>
  );
}
