import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { exportNativeManifestJson } from "@opensesame/app-core/lib/vault/protection/sops-browser.js";
import { useState } from "react";
import {
  IconDownload,
  IconNote,
  IconPlus,
  IconVault,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import "./vault-key-protection.css";
import { buildFormats } from "@opensesame/app-core/sections/settings/formats-interoperability-panel-model.js";
import { AgeInteropSheet } from "./AgeInteropSheet.js";
import { SopsDocumentSheet } from "./sops/SopsDocumentSheet.js";
import { SopsVaultSheet } from "./sops/SopsVaultSheet.js";

function exportNativeManifest(store: ReturnType<typeof useVaultStore>): void {
  try {
    const header = store.getSnapshot().header;
    const protection = header?.protection;
    if (!protection) {
      setStatusNotice({
        id: "formats-interoperability",
        tone: "err",
        title: "Formats",
        body: "No protection manifest to export yet.",
      });
      return;
    }
    const body = exportNativeManifestJson(protection);
    const blob = new Blob([body], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "opensesame-protection.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatusNotice({
      id: "formats-interoperability",
      tone: "info",
      title: "Formats",
      body: "Native protection manifest exported.",
    });
  } catch (caught) {
    setStatusNotice({
      id: "formats-interoperability",
      tone: "err",
      title: "Formats",
      body: caught instanceof Error ? caught.message : "Export failed.",
    });
  }
}

function FormatsActions({
  canExport,
  onExportNative,
  onSops,
  onVault,
  onAge,
}: {
  canExport: boolean;
  onExportNative: () => void;
  onSops: () => void;
  onVault: () => void;
  onAge: () => void;
}) {
  return (
    <div className="actions">
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Export native protection manifest"
        title={
          canExport ? "Export native protection manifest" : "Unlock to export"
        }
        disabled={!canExport}
        onClick={onExportNative}
      >
        <IconDownload size={16} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="SOPS document"
        title="SOPS document"
        onClick={onSops}
      >
        <IconNote size={16} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Vault SOPS"
        title="Vault SOPS"
        disabled={!canExport}
        onClick={onVault}
      >
        <IconVault size={16} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="age armor"
        title="age armor"
        onClick={onAge}
      >
        <IconPlus size={16} />
      </button>
    </div>
  );
}

export function FormatsInteroperabilityPanel() {
  const panelRef = useGuideTarget<HTMLElement>(
    "settings.formats-interoperability",
  );
  const store = useVaultStore();
  const { status, guest } = useVault();
  const formats = buildFormats();
  const canExport = status === "unlocked" && !guest;
  const [ageSheet, setAgeSheet] = useState(false);
  const [sopsSheet, setSopsSheet] = useState(false);
  const [vaultSheet, setVaultSheet] = useState(false);

  const onExportNative = () => exportNativeManifest(store);

  return (
    <>
      <section
        className="panel set__security"
        id="formats-interoperability"
        ref={panelRef}
        aria-labelledby="formats-interoperability-title"
      >
        <div className="panel__head">
          <div>
            <h2 id="formats-interoperability-title">Formats</h2>
          </div>
          <FormatsActions
            canExport={canExport}
            onExportNative={onExportNative}
            onSops={() => setSopsSheet(true)}
            onVault={() => setVaultSheet(true)}
            onAge={() => setAgeSheet(true)}
          />
        </div>
        {/* A table with its column heads said once, not "R", "W",
            "RUNTIME" repeated in every row beside marks that read as
            checkboxes. */}
        <div className="panel__body">
          <table className="fmt__table">
            <thead>
              <tr>
                <th scope="col">Format</th>
                <th scope="col">Read</th>
                <th scope="col">Write</th>
                <th scope="col">Runtime</th>
              </tr>
            </thead>
            <tbody>
              {formats.map((format) => (
                <tr key={format.id} data-format={format.id}>
                  <th scope="row" className="fmt__name">
                    {format.name}
                  </th>
                  <td>
                    <StatusMark
                      tone={format.read.tone}
                      label={format.read.label}
                    />
                  </td>
                  <td>
                    <StatusMark
                      tone={format.write.tone}
                      label={format.write.label}
                    />
                  </td>
                  <td>
                    <StatusMark
                      tone={format.runtime.tone}
                      label={format.runtime.label}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {ageSheet ? <AgeInteropSheet onClose={() => setAgeSheet(false)} /> : null}
      {sopsSheet ? (
        <SopsDocumentSheet onClose={() => setSopsSheet(false)} />
      ) : null}
      {vaultSheet ? (
        <SopsVaultSheet onClose={() => setVaultSheet(false)} />
      ) : null}
    </>
  );
}
