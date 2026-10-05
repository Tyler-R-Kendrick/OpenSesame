import { useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconNote } from "../../../components/Icons.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import "../vault-key-protection.css";
import { SopsDocumentSheet } from "./SopsDocumentSheet.js";

/**
 * Settings › Security › SOPS document (ADR 0130 §1): one row, one key. The
 * key opens the sheet where a person chooses a SOPS YAML or JSON file,
 * unlocks it with an identity they hold, edits it and saves ciphertext. It
 * needs no vault, no account and no network, so a guest sees it too.
 */
export function SopsDocumentPanel() {
  const panelRef = useGuideTarget<HTMLElement>("settings.sops-document");
  const [open, setOpen] = useState(false);
  return (
    <>
      <section
        className="panel set__security"
        id="sops-document"
        ref={panelRef}
        aria-labelledby="sops-document-title"
      >
        <div className="panel__head">
          <div>
            <h2 id="sops-document-title">SOPS</h2>
          </div>
        </div>
        <div className="panel__body">
          <div className="sw sw--method">
            <div>
              <div className="sw__name">SOPS document</div>
            </div>
            <IconKey label="SOPS document" small onClick={() => setOpen(true)}>
              <IconNote size={16} />
            </IconKey>
          </div>
        </div>
      </section>
      {open ? <SopsDocumentSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}
