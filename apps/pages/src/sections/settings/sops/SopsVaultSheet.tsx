import { type RefObject, useEffect, useRef, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconDownload, IconPlus, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useModalFocus } from "../../../lib/modal-focus.js";
import { releaseDownloads } from "../../../lib/sops/download.js";
import { sopsSession } from "../../../lib/sops/session.js";
import { useVault, useVaultStore } from "../../../lib/vault/hooks.js";
import { loadVaultIdentities } from "./identities.js";
import { useVaultSecretActions } from "./useVaultSecrets.js";

type ViewProps = {
  sheetRef: RefObject<HTMLDivElement | null>;
  closeRef: RefObject<HTMLButtonElement | null>;
  itemCount: number;
  fileName: string;
  groups: number;
  recipient: string;
  identity: string;
  vaultIdentities: number;
  busy: boolean;
  needsConsent: boolean;
  consent: boolean;
  ready: boolean;
  onClose: () => void;
  setRecipient: (value: string) => void;
  setIdentity: (value: string) => void;
  setConsent: (value: boolean) => void;
  onFile: (file: File) => void;
  onExport: () => void;
  onImport: () => void;
};

function VaultControls(props: ViewProps) {
  return (
    <>
      <FieldShell
        label="Recipients"
        value={props.recipient}
        onValueChange={props.setRecipient}
        mono
      />
      <FieldShell
        label="age identity"
        type="password"
        value={props.identity}
        onValueChange={props.setIdentity}
        mono
        status={
          props.vaultIdentities > 0 ? (
            <StatusMark
              tone="ok"
              label={`${props.vaultIdentities} sealed in this vault`}
            />
          ) : null
        }
      />
      <label className="icon-btn icon-btn--sm" title="Choose a vault SOPS file">
        <IconPlus size={16} />
        <span className="visually-hidden">Choose a vault SOPS file</span>
        <input
          type="file"
          accept=".json,application/json"
          aria-label="Choose a vault SOPS file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) props.onFile(file);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {props.needsConsent ? (
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-pressed={props.consent}
          aria-label="Accept that this copy opens with any enrolled vault key"
          title="Accept that this copy opens with any enrolled vault key"
          onClick={() => props.setConsent(!props.consent)}
        >
          <StatusMark
            tone={props.consent ? "ok" : "warn"}
            label="Any enrolled vault key"
          />
        </button>
      ) : null}
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Save encrypted vault secrets"
        title="Save encrypted vault secrets"
        disabled={!props.ready || props.recipient.trim() === ""}
        onClick={props.onExport}
      >
        <IconDownload size={16} />
      </button>
    </>
  );
}

function vaultFacts(props: ViewProps) {
  return [
    { key: "Items", value: String(props.itemCount) },
    { key: "File", value: props.fileName === "" ? "none" : props.fileName },
    ...(props.groups > 1
      ? [{ key: "Source needs", value: `${props.groups} key groups` }]
      : []),
    { key: "This copy", value: "Any enrolled vault key" },
    { key: "Runs in", value: "This browser" },
  ];
}

function VaultView(props: ViewProps) {
  const importDisabled =
    props.busy ||
    !props.ready ||
    props.fileName === "" ||
    (props.identity.trim() === "" && props.vaultIdentities === 0) ||
    (props.needsConsent && !props.consent);
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
        aria-label="Vault SOPS"
        aria-modal="true"
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>Vault SOPS</h2>
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
            facts={vaultFacts(props)}
            primary={{
              label: "Encrypt",
              busy: props.busy,
              disabled:
                props.busy || !props.ready || props.recipient.trim() === "",
              onClick: props.onExport,
            }}
            secondary={{
              label: "Import",
              busy: props.busy,
              disabled: importDisabled,
              onClick: props.onImport,
            }}
          >
            <VaultControls {...props} />
          </CeremonyShell>
        </div>
      </div>
    </div>
  );
}

export function SopsVaultSheet({ onClose }: { onClose: () => void }) {
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
  const [groups, setGroups] = useState(0);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [vaultIdentities, setVaultIdentities] = useState<readonly string[]>([]);

  const { status, guest, awaitingSecondStep, tomb } = vault;

  useEffect(() => {
    let live = true;
    void loadVaultIdentities({ status, guest, awaitingSecondStep, tomb }).then(
      (found) => {
        if (live) setVaultIdentities(found);
      },
    );
    return () => {
      live = false;
    };
  }, [status, guest, awaitingSecondStep, tomb]);

  useEffect(() => {
    if (!ready) onClose();
  }, [ready, onClose]);

  useEffect(() => () => releaseDownloads(), []);

  const scope = status === "unlocked" ? tomb : null;

  const { onExport, onImport } = useVaultSecretActions({
    items,
    recipient,
    identity,
    fileText,
    consent,
    vaultIdentities,
    scope,
    setBusy,
    saveItems: (items) => store.saveItems(items),
  });

  return (
    <VaultView
      sheetRef={sheetRef}
      closeRef={closeRef}
      itemCount={items.length}
      fileName={fileName}
      groups={groups}
      recipient={recipient}
      identity={identity}
      vaultIdentities={vaultIdentities.length}
      busy={busy}
      needsConsent={groups > 1}
      consent={consent}
      ready={ready}
      onClose={onClose}
      setRecipient={setRecipient}
      setIdentity={setIdentity}
      setConsent={setConsent}
      onFile={(file) => {
        void file.text().then((text) => {
          setFileText(text);
          setFileName(file.name);
          setConsent(false);
          void sopsSession.runner
            .inspect(text, "json")
            .then((inspection) => setGroups(inspection.keyGroups.length))
            .catch(() => setGroups(0));
        });
      }}
      onExport={onExport}
      onImport={onImport}
    />
  );
}
