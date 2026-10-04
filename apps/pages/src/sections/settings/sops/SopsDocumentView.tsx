import type { WorkflowState } from "@opensesame/app-core/lib/sops/workflow.js";
import { inspectionFacts } from "@opensesame/app-core/sections/settings/sops/sops-document-view-model.js";
import type { RefObject } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconPlus, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";

export type DocumentViewProps = {
  state: WorkflowState;
  sheetRef: RefObject<HTMLDivElement | null>;
  closeRef: RefObject<HTMLButtonElement | null>;
  identity: string;
  recipients: string;
  vaultIdentities: number;
  vaultRecipients: readonly string[];
  threshold: string;
  canOpen: boolean;
  onClose: () => void;
  onFile: (file: File) => void;
  setIdentity: (value: string) => void;
  setRecipients: (value: string) => void;
  setThreshold: (value: string) => void;
  setEdited: (value: string) => void;
  onOpen: () => void;
  onSave: () => void;
  onEncryptNew: () => void;
  onRotate: () => void;
};

function KeyGroups({ state }: { state: WorkflowState }) {
  const inspection = state.inspection;
  if (!inspection || inspection.keyGroups.length === 0) return null;
  return (
    <ul className="sops__groups">
      {inspection.keyGroups.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a key group is identified by its position in the file
        <li key={index}>
          <span className="sops__group-name">
            {inspection.keyGroups.length > 1
              ? `Group ${index + 1}`
              : "Any one of"}
          </span>
          {group.entries.map((entry) => (
            <span
              className="sops__recipient"
              key={`${entry.kind}:${entry.locator}`}
            >
              <StatusMark
                tone={entry.browserOpenable ? "ok" : "idle"}
                label={
                  entry.browserOpenable
                    ? `${entry.kind}, this browser`
                    : `${entry.kind}, elsewhere`
                }
              />
              <code>{entry.locator}</code>
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

function DocumentControls(props: DocumentViewProps) {
  return (
    <>
      <KeyGroups state={props.state} />
      <label
        className="icon-btn icon-btn--sm sops__file"
        title="Choose a SOPS YAML or JSON file"
      >
        <IconPlus size={16} />
        <span className="visually-hidden">Choose a SOPS YAML or JSON file</span>
        <input
          type="file"
          accept=".yaml,.yml,.json,application/json,text/yaml"
          aria-label="Choose a SOPS YAML or JSON file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) props.onFile(file);
            event.currentTarget.value = "";
          }}
        />
      </label>
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
      <FieldShell
        label="Recipients"
        value={props.recipients}
        onValueChange={props.setRecipients}
        mono
        fills={props.vaultRecipients.map((recipient) => ({
          label: `${recipient.slice(0, 12)}…`,
          onPick: () => props.setRecipients(recipient),
        }))}
      />
      <FieldShell
        label="Groups needed"
        value={props.threshold}
        onValueChange={props.setThreshold}
        inputMode="numeric"
      />
      {props.state.phase === "open" ? (
        <textarea
          className="sops__editor"
          aria-label="Decrypted document"
          spellCheck={false}
          autoComplete="off"
          value={props.state.edited}
          onChange={(event) => props.setEdited(event.currentTarget.value)}
        />
      ) : null}
    </>
  );
}

/** The primary and secondary actions differ before and after a verified open. */
function documentActions(props: DocumentViewProps) {
  const { state } = props;
  if (state.phase === "open") {
    return {
      primary: {
        label: "Save encrypted copy",
        busy: state.busy,
        disabled: state.busy,
        onClick: props.onSave,
      },
      secondary: {
        label: "Re-key",
        busy: state.busy,
        disabled: state.busy || props.recipients.trim() === "",
        onClick: props.onRotate,
      },
    };
  }
  return {
    primary: {
      label: "Open",
      busy: state.busy,
      disabled: state.busy || !props.canOpen,
      onClick: props.onOpen,
    },
    secondary: {
      label: "Encrypt",
      busy: state.busy,
      // An already-encrypted file is opened, never wrapped again.
      disabled:
        state.busy ||
        props.recipients.trim() === "" ||
        state.phase === "empty" ||
        state.inspection?.encrypted === true,
      onClick: props.onEncryptNew,
    },
  };
}

export function SopsDocumentView(props: DocumentViewProps) {
  const { state } = props;
  const actions = documentActions(props);
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
        aria-label="SOPS document"
        aria-modal="true"
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>SOPS document</h2>
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
            ok={state.failure === null}
            name={state.fileName === "" ? "SOPS YAML or JSON" : state.fileName}
            facts={inspectionFacts(state)}
            primary={actions.primary}
            secondary={actions.secondary}
          >
            <DocumentControls {...props} />
          </CeremonyShell>
        </div>
      </div>
    </div>
  );
}
