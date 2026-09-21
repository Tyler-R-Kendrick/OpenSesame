import { type RefObject, useEffect, useRef, useState } from "react";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconDownload, IconX } from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { setStatusNotice } from "../../lib/notices.js";
import { inspectSopsDocument } from "../../lib/sops/engine.js";
import {
  exportVaultSecrets,
  importVaultSecrets,
} from "../../lib/sops/vault-secrets.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";

function notice(tone: "info" | "err", body: string): void {
  setStatusNotice({
    id: "formats-interoperability",
    tone,
    title: "SOPS",
    body,
  });
}

function download(body: string): void {
  const blob = new Blob([body], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "vault-secrets.sops.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

type ViewProps = {
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
  sheetRef: RefObject<HTMLDivElement | null>;
  itemCount: number;
  fileName: string;
  recipient: string;
  identity: string;
  busy: boolean;
  needsConsent: boolean;
  consent: boolean;
  ready: boolean;
  setRecipient: (value: string) => void;
  setIdentity: (value: string) => void;
  setConsent: (value: boolean) => void;
  onFile: (file: File) => void;
  onExport: () => void;
  onImport: () => void;
};

function SopsVaultView(props: ViewProps) {
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={props.onClose}
      />
      <div
        ref={props.sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: dialog sheet pattern
        role="dialog"
        aria-label="SOPS"
        aria-modal="true"
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>SOPS</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            ref={props.closeRef}
            onClick={props.onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">
          <CeremonyShell
            ok={props.ready}
            name="Vault secrets"
            facts={[
              { key: "Items", value: String(props.itemCount) },
              { key: "Runtime", value: "This browser" },
            ]}
            primary={{
              label: "Encrypt",
              busy: props.busy,
              disabled: props.busy || !props.ready || !props.recipient,
              onClick: props.onExport,
            }}
            secondary={{
              label: "Decrypt",
              busy: props.busy,
              disabled:
                props.busy ||
                !props.ready ||
                !props.identity ||
                !props.fileName ||
                (props.needsConsent && !props.consent),
              onClick: props.onImport,
            }}
          >
            <FieldShell
              label="Recipient"
              value={props.recipient}
              onValueChange={props.setRecipient}
              mono
            />
            <FieldShell
              label="Identity"
              type="password"
              value={props.identity}
              onValueChange={props.setIdentity}
              mono
            />
            <label className="icon-btn icon-btn--sm">
              <input
                type="file"
                accept=".json,application/json"
                aria-label="Vault SOPS file"
                title="Vault SOPS file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) props.onFile(file);
                }}
              />
            </label>
            {props.needsConsent ? (
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-pressed={props.consent}
                aria-label="This vault"
                title="This vault"
                onClick={() => props.setConsent(!props.consent)}
              >
                This vault
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Download vault secrets"
              title="Download vault secrets"
              disabled={!props.ready}
              onClick={props.onExport}
            >
              <IconDownload size={16} />
            </button>
          </CeremonyShell>
        </div>
      </div>
    </div>
  );
}

export function SopsDocumentSheet({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  const vault = useVault();
  const store = useVaultStore();
  const ready =
    vault.status === "unlocked" && !vault.guest && !vault.awaitingSecondStep;
  const items = ready ? store.getSnapshot().items : [];
  const [recipient, setRecipient] = useState("");
  const [identity, setIdentity] = useState("");
  const [fileText, setFileText] = useState("");
  const [fileName, setFileName] = useState("");
  const [needsConsent, setNeedsConsent] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready) onClose();
  }, [ready, onClose]);

  const onExport = () => {
    setBusy(true);
    void exportVaultSecrets({ items, recipients: [recipient] })
      .then((body) => {
        download(body);
        notice("info", "Vault secrets encrypted.");
      })
      .catch((caught) => {
        notice(
          "err",
          caught instanceof Error ? caught.message : "SOPS failed.",
        );
      })
      .finally(() => setBusy(false));
  };

  const onImport = () => {
    setBusy(true);
    void importVaultSecrets({
      ciphertext: fileText,
      identity,
      consentToVaultCopy: consent,
    })
      .then(async (imported) => {
        for (const item of imported) await store.saveItem(item);
        notice("info", "Vault secrets imported.");
      })
      .catch((caught) => {
        notice(
          "err",
          caught instanceof Error ? caught.message : "SOPS failed.",
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <SopsVaultView
      onClose={onClose}
      closeRef={closeRef}
      sheetRef={sheetRef}
      itemCount={items.length}
      fileName={fileName}
      recipient={recipient}
      identity={identity}
      busy={busy}
      needsConsent={needsConsent}
      consent={consent}
      ready={ready}
      setRecipient={setRecipient}
      setIdentity={setIdentity}
      setConsent={setConsent}
      onExport={onExport}
      onImport={onImport}
      onFile={(file) => {
        void file.text().then((text) => {
          setFileText(text);
          setFileName(file.name);
          setConsent(false);
          try {
            setNeedsConsent(inspectSopsDocument(text, "json").groups > 1);
          } catch {
            setNeedsConsent(false);
          }
        });
      }}
    />
  );
}
