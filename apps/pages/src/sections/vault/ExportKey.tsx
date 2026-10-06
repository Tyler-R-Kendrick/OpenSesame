import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import {
  exportOpener,
  exportRefusal,
  offlineBackupFile,
} from "@opensesame/app-core/lib/vault/offline-backup-file.js";
import { vaultLabel } from "@opensesame/app-core/lib/vaults.js";
import { useCallback, useRef, useState } from "react";
import {
  type CeremonyFact,
  CeremonyShell,
} from "../../components/CeremonyShell.js";
import { IconUpload, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { useVault } from "../../lib/vault/hooks.js";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { useAddEntry } from "./add-menu.js";

const NOTICE = "vault-export";

function messageOf<Thrown>(caught: Thrown): string {
  return caught instanceof Error ? caught.message : "Export failed.";
}

/**
 * The encrypted backup (`backup.local-encrypted`): the vault's sealed body
 * and wrapping header in one file, the master password still its key.
 * Never a plaintext dump — nothing here decrypts an item — and a vault with
 * no enrolled unlock is refused rather than written into a file nobody can read.
 */
function ExportSheet({ onClose }: { onClose: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const vault = useVault();
  const refusal = exportRefusal(vault);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problem = error ?? refusal;

  const save = () => {
    try {
      const file = offlineBackupFile(vault);
      downloadSeams.save(file.fileName, file.text, "application/json");
      setSaved(file.fileName);
      setError(null);
      dismissNotice(NOTICE);
    } catch (caught) {
      const message = messageOf(caught);
      setError(message);
      setStatusNotice({
        id: NOTICE,
        tone: "err",
        title: "Export",
        body: message,
      });
    }
  };

  const live = vault.items.filter((item) => item.deletedAt === null).length;
  const facts: CeremonyFact[] = [
    { key: "Vault", value: vaultLabel({ id: vault.tomb, name: vault.tomb }) },
    { key: "Items", value: String(live) },
    {
      key: "Opens with",
      value: exportOpener(vault.header) ?? "the master password",
    },
    { key: "Holds", value: "ciphertext only" },
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
        aria-label="Export encrypted vault"
        aria-modal="true"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            <IconUpload size={20} />
          </span>
          <div className="sheet__grow">
            <h2>Export</h2>
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
        <div className="sheet__body">
          <CeremonyShell
            ok={problem === null}
            top={saved && problem === null ? "Saved" : undefined}
            name="Encrypted backup"
            facts={facts}
            primary={
              refusal === null
                ? { label: saved ? "Save again" : "Save backup", onClick: save }
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

/** The export flow: the encrypted-backup sheet, opened and closed. */
function useExportFlow() {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  return {
    open,
    show,
    element: open ? <ExportSheet onClose={close} /> : null,
  };
}

/** The path strip's Export key: opens the encrypted-backup sheet. */
export function ExportKey() {
  const guideRef = useGuideTarget<HTMLButtonElement>("vault.export");
  const flow = useExportFlow();
  return (
    <>
      <button
        ref={guideRef}
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Export items"
        title="Export encrypted vault"
        aria-haspopup="dialog"
        aria-expanded={flow.open}
        onClick={flow.show}
      >
        <IconUpload size={15} />
      </button>
      {flow.element}
    </>
  );
}

/**
 * Export as one of the Add button's other ways to add, on a phone: the same
 * sheet, chosen by holding the button and sliding down instead of a key of its
 * own.
 */
export function ExportEntry() {
  const flow = useExportFlow();
  useAddEntry({
    id: "export",
    label: "Export items",
    order: 20,
    slide: "down",
    run: flow.show,
  });
  return flow.element;
}
