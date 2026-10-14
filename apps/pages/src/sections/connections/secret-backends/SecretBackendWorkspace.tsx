import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useId, useLayoutEffect, useRef } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import {
  IconDownload,
  IconEdit,
  IconEye,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { firstControl, keyboardIsIdle, landFocus } from "../../../lib/focus.js";
import { SecretBackendItemForm } from "./SecretBackendItemForm.js";
import {
  type SecretBackendHandle,
  type SecretBackendWorkspaceState,
  useSecretBackendWorkspace,
} from "./useSecretBackendWorkspace.js";

function ItemRows({
  state,
  handle,
}: { state: SecretBackendWorkspaceState; handle: SecretBackendHandle }) {
  const { capabilities } = handle.backend;
  const notes =
    !capabilities.itemFields || capabilities.itemFields.includes("notes");
  return (
    <ul className="conn-list" aria-label="Backend items">
      {state.items.map((item) => (
        <li key={item.id} className="conn-card">
          <span className="conn-card__name">{item.name}</span>
          <span className="conn-card__ref">{item.kind}</span>
          {capabilities.get ? (
            <>
              <IconKey
                label={`Open backend item ${item.name}`}
                disabled={state.busy}
                onClick={() => state.read(item.id)}
              >
                <IconEye size={17} />
              </IconKey>
              {notes ? (
                <IconKey
                  label={`Read notes for ${item.name}`}
                  disabled={state.busy}
                  onClick={() => state.readNotes(item.id)}
                >
                  <IconSearch size={17} />
                </IconKey>
              ) : null}
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
function SelectedItemKeys({
  state,
  handle,
}: { state: SecretBackendWorkspaceState; handle: SecretBackendHandle }) {
  if (!state.selected && !state.creating && state.notes === null) return null;
  const { capabilities, updateItem, deleteItem } = handle.backend;
  return (
    <>
      {state.selected && capabilities.update && updateItem && !state.editing ? (
        <IconKey
          label="Edit backend item"
          disabled={state.busy}
          onClick={state.edit}
        >
          <IconEdit size={17} />
        </IconKey>
      ) : null}
      {state.selected && capabilities.delete && deleteItem ? (
        <IconKey
          label={
            state.confirming
              ? "Confirm delete backend item"
              : "Delete backend item"
          }
          armed={state.confirming}
          disabled={state.busy}
          onClick={state.remove}
        >
          <IconTrash size={17} />
        </IconKey>
      ) : null}
      {state.confirming ? (
        <IconKey
          label="Keep backend item"
          disabled={state.busy}
          onClick={() => state.setConfirming(false)}
        >
          <IconX size={17} />
        </IconKey>
      ) : null}
      <IconKey
        label="Close backend item"
        disabled={state.busy}
        onClick={state.close}
      >
        <IconX size={17} />
      </IconKey>
    </>
  );
}
function WorkspaceBody({
  state,
  handle,
}: { state: SecretBackendWorkspaceState; handle: SecretBackendHandle }) {
  const id = useId();
  const { capabilities, importToLocal } = handle.backend;
  const notes =
    !capabilities.itemFields || capabilities.itemFields.includes("notes");
  return (
    <div className="panel__body">
      {capabilities.get ? (
        <FieldShell
          label="Item name or ID"
          value={state.lookup}
          disabled={state.busy}
          onValueChange={state.setLookup}
          onEnter={() => state.read(state.lookup)}
          tail={
            <>
              <IconKey
                label="Get backend item"
                disabled={state.busy || !state.lookup}
                onClick={() => state.read(state.lookup)}
              >
                <IconEye size={17} />
              </IconKey>
              {notes ? (
                <IconKey
                  label="Get backend notes"
                  disabled={state.busy || !state.lookup}
                  onClick={() => state.readNotes(state.lookup)}
                >
                  <IconSearch size={17} />
                </IconKey>
              ) : null}
            </>
          }
        />
      ) : null}
      {capabilities.list ? <ItemRows state={state} handle={handle} /> : null}
      {state.notes !== null ? (
        <div className="field">
          <label htmlFor={id}>Backend notes</label>
          <textarea id={id} readOnly value={state.notes} rows={5} />
        </div>
      ) : null}
      {capabilities.import && importToLocal ? (
        <FormCommit
          label="Import backend items into local vault"
          disabled={state.busy}
          busy={state.busy}
          icon={<IconDownload size={18} />}
          onClick={state.importItems}
        />
      ) : null}
    </div>
  );
}
export function SecretBackendWorkspace({
  handle,
  onFlash,
}: { handle: SecretBackendHandle; onFlash: (flash: Flash) => void }) {
  const state = useSecretBackendWorkspace(handle, onFlash);
  const root = useRef<HTMLElement>(null);
  const { selected, creating, busy } = state;
  useLayoutEffect(() => {
    if (busy) return;
    const target =
      selected || creating
        ? root.current?.querySelector('[aria-label="Backend item"]')
        : root.current;
    if (keyboardIsIdle()) landFocus(firstControl(target));
  }, [selected, creating, busy]);
  const { capabilities, createItem } = handle.backend;
  return (
    <section className="panel" aria-label="Secret backend items" ref={root}>
      <div className="panel__head">
        <h2>
          <span className="cx-step">4</span> Items
        </h2>
        {capabilities.list ? (
          <IconKey
            label="List backend items"
            disabled={state.busy}
            onClick={state.list}
          >
            <IconRefresh size={17} />
          </IconKey>
        ) : null}
        {capabilities.create && createItem ? (
          <IconKey
            label="New backend item"
            disabled={state.busy}
            onClick={state.create}
          >
            <IconPlus size={17} />
          </IconKey>
        ) : null}
        <SelectedItemKeys state={state} handle={handle} />
        {state.failure ? <StatusMark tone="err" label={state.failure} /> : null}
        {state.result ? <StatusMark tone="ok" label={state.result} /> : null}
      </div>
      <WorkspaceBody state={state} handle={handle} />
      {state.selected || state.creating ? (
        <SecretBackendItemForm
          key={`${state.selected?.id ?? "new"}/${state.editing}`}
          item={state.selected}
          editing={state.editing}
          busy={state.busy}
          onSave={state.save}
          onClose={state.close}
          itemKinds={handle.backend.capabilities.itemKinds}
          itemFields={handle.backend.capabilities.itemFields}
        />
      ) : null}
      <FailureNotice
        id={`secret-backend-items-${handle.session.id}`}
        title="Secret backend"
        message={state.failure}
      />
    </section>
  );
}
