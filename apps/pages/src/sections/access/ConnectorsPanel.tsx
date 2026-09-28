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

import { useState } from "react";
import { IconPlus, IconX } from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import { byId, useFocusAfter } from "../../lib/use-focus-after.js";
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
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [bindingRow, setBindingRow] = useState<string | null>(null);
  const [settingsRow, setSettingsRow] = useState<string | null>(null);
  const focusAfter = useFocusAfter(state.busy);

  function closePicker() {
    setAdding(false);
    setChosen(null);
    focusAfter(byId("connector-access-add"));
  }

  return {
    adding,
    chosen,
    bindingRow,
    settingsRow,
    setChosen,
    closePicker,
    togglePicker() {
      if (adding) return closePicker();
      setBindingRow(null);
      setSettingsRow(null);
      setAdding(true);
    },
    grantFromPicker(row: ConnectorRow, input: BindInput) {
      void state.bind(row, input).then((done) => {
        if (!done) return;
        setAdding(false);
        setChosen(null);
        // The connector is in the access list now; the keyboard follows it.
        focusAfter(byId(bindButtonId(row.id)));
      });
    },
    cancelChoice() {
      const rowId = chosen;
      setChosen(null);
      // The form under the choices closes; its choice keeps the keyboard.
      if (rowId) focusAfter(byId(choiceId(rowId)));
    },
    openBind(row: ConnectorRow) {
      // One bind form at a time: the choices close when a row's opens.
      setAdding(false);
      setChosen(null);
      setSettingsRow(null);
      setBindingRow(row.id);
    },
    closeBind() {
      const rowId = bindingRow;
      setBindingRow(null);
      // The row's Bind steps aside while the form is open, so the button that
      // opened it is gone by now; its replacement is where the keyboard lands.
      if (rowId) focusAfter(byId(bindButtonId(rowId)));
    },
    openSettings(row: ConnectorRow) {
      setAdding(false);
      setChosen(null);
      setBindingRow(null);
      setSettingsRow(row.id);
    },
    closeSettings: () => setSettingsRow(null),
  };
}

/** The connectors someone holds access to, each with its grants. */
function GrantedRows({
  state,
  forms,
}: {
  state: Access;
  forms: ReturnType<typeof useAccessForms>;
}) {
  const mixedSources =
    state.granted.some((row) => row.source === "connections") &&
    state.granted.some((row) => row.source === "directory");
  return (
    <ConnectorRows
      state={state}
      rows={state.granted}
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
  return (
    <section
      className="panel"
      id="local-connectors"
      aria-label="Connectors"
      aria-busy={state.busy}
    >
      <div className="panel__head">
        <h2>Connectors</h2>
        <fieldset className="vtree__keys" aria-label="Connector commands">
          <AddKey
            adding={forms.adding}
            busy={state.busy}
            onToggle={forms.togglePicker}
          />
        </fieldset>
      </div>
      <div className="panel__body">
        {state.error ? (
          <p className="note note--err" role="alert">
            {state.error}
          </p>
        ) : null}
        <StatusNote
          message={state.message ? { tone: "ok", text: state.message } : null}
        />
        {forms.adding ? (
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
        ) : null}
        {!forms.adding && state.loaded && state.granted.length === 0 ? (
          <div className="empty">
            <h3>No connector access</h3>
          </div>
        ) : null}
        <GrantedRows state={state} forms={forms} />
      </div>
    </section>
  );
}
