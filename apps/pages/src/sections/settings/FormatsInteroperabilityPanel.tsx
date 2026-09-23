import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { sopsCapability } from "@opensesame/app-core/lib/sops/capability.js";
import {
  ageCapability,
  exportNativeManifestJson,
  gpgCapability,
  nativeManifestCapability,
} from "@opensesame/app-core/lib/vault/protection/sops-browser.js";
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
import { AgeInteropSheet } from "./AgeInteropSheet.js";
import { SopsDocumentSheet } from "./sops/SopsDocumentSheet.js";
import { SopsVaultSheet } from "./sops/SopsVaultSheet.js";

type Capability = "ok" | "warn" | "idle";

type FormatRow = {
  id: string;
  name: string;
  read: { tone: Capability; label: string };
  write: { tone: Capability; label: string };
  runtime: { tone: Capability; label: string };
};

function buildFormats(): readonly FormatRow[] {
  const age = ageCapability();
  const sops = sopsCapability();
  const gpg = gpgCapability();
  const native = nativeManifestCapability();
  return [
    {
      id: "native",
      name: "Native",
      read: { tone: "ok", label: "Read" },
      write: { tone: "ok", label: "Write" },
      runtime: {
        tone: native.runtime === "browser" ? "ok" : "warn",
        label: "This browser",
      },
    },
    {
      id: "age",
      name: "age",
      read: { tone: "ok", label: "Read" },
      write: { tone: "ok", label: "Write" },
      runtime: {
        tone: age.runtime === "browser" ? "ok" : "warn",
        label: "This browser",
      },
    },
    {
      id: "sops",
      name: "SOPS",
      read: { tone: sops.available ? "ok" : "idle", label: "Read" },
      write: { tone: sops.available ? "ok" : "idle", label: "Write" },
      runtime: {
        tone: sops.runtime === "browser" ? "ok" : "idle",
        label: "This browser",
      },
    },
    {
      id: "gpg",
      name: "GPG",
      read: { tone: "ok", label: "Read" },
      write: { tone: "idle", label: "Write not in this browser" },
      runtime: {
        tone: "idle",
        label: gpg.available ? "This browser" : "Native or external tooling",
      },
    },
  ];
}

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
        <div className="panel__body fmt__grid">
          {formats.map((format) => (
            <div className="fmt__row" key={format.id} data-format={format.id}>
              <span className="fmt__name">{format.name}</span>
              <span className="fmt__cell">
                <span className="fmt__cell-label">R</span>
                <StatusMark tone={format.read.tone} label={format.read.label} />
              </span>
              <span className="fmt__cell">
                <span className="fmt__cell-label">W</span>
                <StatusMark
                  tone={format.write.tone}
                  label={format.write.label}
                />
              </span>
              <span className="fmt__cell">
                <span className="fmt__cell-label">Runtime</span>
                <StatusMark
                  tone={format.runtime.tone}
                  label={format.runtime.label}
                />
              </span>
            </div>
          ))}
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
