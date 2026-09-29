import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { exportNativeManifestJson } from "@opensesame/app-core/lib/vault/protection/sops-browser.js";
import { type ReactNode, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconDownload,
  IconNote,
  IconSecret,
  IconVault,
} from "../../components/Icons.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import "./vault-key-protection.css";
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

type FormatRow = {
  id: string;
  name: string;
  sub: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Needs an open, persisted vault — absent from the list, not disabled. */
  needsVault: boolean;
};

export function FormatsInteroperabilityPanel() {
  const panelRef = useGuideTarget<HTMLElement>(
    "settings.formats-interoperability",
  );
  const store = useVaultStore();
  const { status, guest } = useVault();
  const hasVault = status === "unlocked" && !guest;
  const [ageSheet, setAgeSheet] = useState(false);
  const [sopsSheet, setSopsSheet] = useState(false);
  const [vaultSheet, setVaultSheet] = useState(false);

  const rows: readonly FormatRow[] = [
    {
      id: "native",
      name: "Protection manifest",
      sub: "The keys that open this vault, as opensesame-protection.json.",
      label: "Export native protection manifest",
      icon: <IconDownload size={16} />,
      onClick: () => exportNativeManifest(store),
      needsVault: true,
    },
    {
      id: "sops",
      name: "SOPS document",
      sub: "Open, verify and edit a SOPS file.",
      label: "SOPS document",
      icon: <IconNote size={16} />,
      onClick: () => setSopsSheet(true),
      needsVault: false,
    },
    {
      id: "vault-sops",
      name: "Vault SOPS",
      sub: "Vault secrets saved as an encrypted SOPS file.",
      label: "Vault SOPS",
      icon: <IconVault size={16} />,
      onClick: () => setVaultSheet(true),
      needsVault: true,
    },
    {
      id: "age",
      name: "age armor",
      sub: "Encrypt to an age recipient, or decrypt with an identity.",
      label: "age armor",
      icon: <IconSecret size={16} />,
      onClick: () => setAgeSheet(true),
      needsVault: false,
    },
  ];

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
        </div>
        <div className="panel__body">
          {rows
            .filter((row) => hasVault || !row.needsVault)
            .map((row) => (
              <div key={row.id} className="sw sw--method" data-format={row.id}>
                <div>
                  <div className="sw__name">{row.name}</div>
                  <p className="sw__sub">{row.sub}</p>
                </div>
                <IconKey label={row.label} small onClick={row.onClick}>
                  {row.icon}
                </IconKey>
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
