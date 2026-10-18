import type {
  SecretBackend,
  SecretBackendItem,
  SecretBackendItemInput,
  SecretBackendItemSummary,
  SecretBackendSession,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import {
  type SecretBackendActionOwner,
  useSecretBackendAction,
  useSecretBackendOwnerSignal,
} from "./useSecretBackendAction.js";

export type SecretBackendHandle = {
  backend: SecretBackend;
  session: SecretBackendSession;
};
function useWorkspaceDraft() {
  const [items, setItems] = useState<SecretBackendItemSummary[]>([]);
  const [selected, setSelected] = useState<SecretBackendItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lookup, setLookup] = useState("");
  const [notes, setNotes] = useState<string | null>(null);
  function close() {
    setSelected(null);
    setEditing(false);
    setCreating(false);
    setConfirming(false);
    setNotes(null);
  }
  return {
    items,
    setItems,
    selected,
    setSelected,
    editing,
    creating,
    confirming,
    setConfirming,
    lookup,
    setLookup,
    notes,
    setNotes,
    close,
    create: () => {
      close();
      setCreating(true);
      setEditing(true);
    },
    edit: () => {
      setEditing(true);
      setConfirming(false);
    },
  };
}
type WorkspaceDraft = ReturnType<typeof useWorkspaceDraft>;
type WorkspaceStatus = ReturnType<typeof useSecretBackendAction>;
async function refreshItems(
  { backend, session }: SecretBackendHandle,
  state: WorkspaceDraft,
  owner: SecretBackendActionOwner,
) {
  owner.check();
  if (!backend.capabilities.list) return;
  const items = await backend.listItems(session);
  owner.check();
  state.setItems(items);
}
function workspaceMutations(
  handle: SecretBackendHandle,
  state: WorkspaceDraft,
  status: WorkspaceStatus,
) {
  const { backend, session } = handle;
  const { selected, confirming, setConfirming, close } = state;
  function save(input: SecretBackendItemInput) {
    void status.run(async (owner) => {
      owner.check();
      if (selected) {
        if (!backend.capabilities.update || !backend.updateItem)
          throw new Error("This backend does not update items.");
        await backend.updateItem(selected.id, input, session);
      } else {
        if (!backend.capabilities.create || !backend.createItem)
          throw new Error("This backend does not create items.");
        await backend.createItem(input, session);
      }
      owner.check();
      await refreshItems(handle, state, owner);
      owner.check();
      close();
      return "Backend item saved";
    });
  }
  function remove() {
    if (!selected) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    void status.run(async (owner) => {
      owner.check();
      if (!backend.capabilities.delete || !backend.deleteItem)
        throw new Error("This backend does not delete items.");
      await backend.deleteItem(selected.id, session);
      owner.check();
      await refreshItems(handle, state, owner);
      owner.check();
      close();
      return "Backend item deleted";
    });
  }
  return { save, remove };
}
export function useSecretBackendWorkspace(
  handle: SecretBackendHandle,
  onFlash: (flash: Flash) => void,
) {
  const signal = useSecretBackendOwnerSignal(
    handle.backend.signal,
    handle.session.signal,
  );
  const status = useSecretBackendAction(onFlash, signal);
  const state = useWorkspaceDraft();
  const { setSelected, setNotes, close } = state;
  const { backend, session } = handle;
  function list() {
    void status.run(async (owner) => {
      await refreshItems(handle, state, owner);
      owner.check();
      return "Backend items loaded";
    });
  }
  function read(reference: string) {
    if (!reference.trim()) return;
    void status.run(async (owner) => {
      owner.check();
      const item = await backend.getItem(reference, session);
      owner.check();
      close();
      setSelected(item);
      return "Backend item loaded";
    });
  }
  function readNotes(reference: string) {
    if (!reference.trim()) return;
    void status.run(async (owner) => {
      owner.check();
      const value = await backend.getNotes(reference, session);
      owner.check();
      close();
      setNotes(value);
      return "Backend notes loaded";
    });
  }
  function importItems() {
    void status.run(async (owner) => {
      owner.check();
      if (!backend.capabilities.import || !backend.importToLocal)
        throw new Error("This backend does not import items.");
      const report = await backend.importToLocal(session);
      owner.check();
      return `${report.imported} items imported; ${report.skipped} skipped${report.warnings.length ? `; ${report.warnings.join("; ")}` : ""}`;
    });
  }
  return {
    ...status,
    ...state,
    ...workspaceMutations(handle, state, status),
    list,
    read,
    readNotes,
    importItems,
  };
}
export type SecretBackendWorkspaceState = ReturnType<
  typeof useSecretBackendWorkspace
>;
