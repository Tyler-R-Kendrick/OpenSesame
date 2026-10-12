/**
 * Access › Connectors — who may use which connector (ADR 0115).
 *
 * The panel lists access, not connectors: each connector someone holds a
 * grant on, with those grants beneath it. Add opens the connectors this
 * device knows — configured on the Connections page, or imported there from a
 * directory — to choose the one a new grant is made on; a connector nobody has
 * configured yet is made on Connections, where the last choice leads. Revoke
 * asks nothing twice — a grant is time-boxed already, and the ledger records
 * the revocation. No Host is needed for any of it: the grants are local share
 * grants of kind `connection`.
 */

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconPlus, IconX } from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import { keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { byId, useFocusAfter } from "../../lib/use-focus-after.js";
import {
  AccessDetail,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";
import { ConnectorPicker, choiceId } from "./ConnectorPicker.js";
import { ConnectorRows, bindButtonId } from "./ConnectorRows.js";
import {
  type BindInput,
  type ConnectorRow,
  useConnectorAccess,
} from "./useConnectorAccess.js";

/** The one key in the head: Add, or Close while the choices are open. */
function AddKey({
  adding,
  busy,
  onToggle,
}: {
  adding: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const label = adding ? "Close" : "Add connector access";
  return (
    <button
      id="connector-access-add"
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label={label}
      title={label}
      aria-expanded={adding}
      disabled={busy}
      onClick={onToggle}
    >
      {adding ? <IconX size={16} /> : <IconPlus size={16} />}
    </button>
  );
}

type Access = ReturnType<typeof useConnectorAccess>;

/** Which form is open — the choices, a row's Bind, or a row's Configure —
    and where the keyboard goes when one closes. */
function useAccessForms(state: Access) {
  const selection = useAccessRecord("local-connectors", "connectors");
  const location = useLocation();
  const navigate = useNavigate();
  const mode = new URLSearchParams(location.search).get("edit");
  const bindingRow = mode === "bind" ? selection.id : null;
  const settingsRow = mode === "settings" ? selection.id : null;
  const [chosen, setChosen] = useState<string | null>(null);
  const focusAfter = useFocusAfter(state.busy);
  const routeFocus = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route key waits for navigation to remove the initiating form before restoring its control
  useEffect(() => {
    if (state.busy || selection.creating || mode || !routeFocus.current) return;
    const target = document.getElementById(routeFocus.current);
    if (!target) return;
    routeFocus.current = null;
    if (keyboardIsIdle()) landFocus(target);
  }, [state.busy, selection.creating, mode, location.key]);
  const edit = (row: ConnectorRow, mode: string) =>
    navigate(
      `/access?view=connectors&edit=${mode}#local-connectors/${encodeURIComponent(row.id)}`,
    );
  return {
    chosen,
    bindingRow,
    settingsRow,
    setChosen,
    closePicker() {
      setChosen(null);
      routeFocus.current = "connector-access-add";
      selection.close();
    },
    grantFromPicker(row: ConnectorRow, input: BindInput) {
      void state.bind(row, input).then((done) => {
        if (!done) return;
        setChosen(null);
        routeFocus.current = bindButtonId(row.id);
        selection.select(row.id);
      });
    },
    cancelChoice() {
      const rowId = chosen;
      setChosen(null);
      if (rowId) focusAfter(byId(choiceId(rowId)));
    },
    openBind(row: ConnectorRow) {
      setChosen(null);
      edit(row, "bind");
    },
    closeBind() {
      if (selection.id) {
        routeFocus.current = bindButtonId(selection.id);
        selection.select(selection.id);
      }
    },
    openSettings(row: ConnectorRow) {
      setChosen(null);
      edit(row, "settings");
    },
    closeSettings() {
      if (selection.id) selection.select(selection.id);
    },
  };
}

/** The connectors someone holds access to, each with its grants. */
function GrantedRows({
  state,
  forms,
  selectedId,
}: {
  state: Access;
  forms: ReturnType<typeof useAccessForms>;
  selectedId?: string | null;
}) {
  const mixedSources =
    state.granted.some((row) => row.source === "connections") &&
    state.granted.some((row) => row.source === "directory");
  return (
    <ConnectorRows
      state={state}
      rows={state.granted.filter((row) => row.id === selectedId)}
      mixedSources={mixedSources}
      bindingRow={forms.bindingRow}
      settingsRow={forms.settingsRow}
      onOpenBind={forms.openBind}
      onCloseBind={forms.closeBind}
      onBind={(row, input) =>
        void state.bind(row, input).then((done) => {
          if (done) forms.closeBind();
        })
      }
      onOpenSettings={forms.openSettings}
      onCloseSettings={forms.closeSettings}
      onSaveSetting={(row, setting) =>
        void state.saveSetting(row, setting).then((done) => {
          if (done) forms.closeSettings();
        })
      }
      onRevoke={(share) => void state.revoke(share)}
    />
  );
}

export function ConnectorsPanel({ tomb }: { tomb: string }) {
  const state = useConnectorAccess(tomb);
  const forms = useAccessForms(state);
  const selection = useAccessRecord("local-connectors", "connectors");
  return (
    <AccessRecords
      title="Connectors"
      emptyMessage={
        state.error
          ? "Unavailable"
          : !state.loaded
            ? "Loading…"
            : "No connector access"
      }
      selection={selection}
      rows={state.granted.map((row) => ({
        id: row.id,
        label: row.label,
        extension: "access",
        to: selection.path(row.id),
      }))}
      commands={
        <AddKey
          adding={selection.creating}
          busy={state.busy}
          onToggle={() => selection.setCreating(!selection.creating)}
        />
      }
      status={
        <>
          <FailureNotice
            id="access:connectors"
            title="Connectors"
            message={state.error}
          />
          <StatusNote
            message={state.message ? { tone: "ok", text: state.message } : null}
          />
        </>
      }
    >
      {selection.creating ? (
        <AccessDetail title="New connector access" kind="Access">
          <ConnectorPicker
            rows={state.rows}
            settingsFor={state.settingsFor}
            identities={state.identities}
            busy={state.busy}
            chosen={forms.chosen}
            onChoose={(row) => forms.setChosen(row?.id ?? null)}
            onCancel={forms.cancelChoice}
            onBind={forms.grantFromPicker}
            onClose={forms.closePicker}
          />
        </AccessDetail>
      ) : null}
      {!selection.creating && selection.id ? (
        <GrantedRows state={state} forms={forms} selectedId={selection.id} />
      ) : null}
    </AccessRecords>
  );
}
