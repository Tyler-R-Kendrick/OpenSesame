import type {
  SecretBackend,
  SecretBackendItem,
  SecretBackendItemInput,
  SecretBackendItemSummary,
  SecretBackendSession,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { useSecretBackendAction } from "./useSecretBackendAction.js";

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
export function useSecretBackendWorkspace(
  handle: SecretBackendHandle,
  onFlash: (flash: Flash) => void,
) {
  const status = useSecretBackendAction(onFlash);
  const state = useWorkspaceDraft();
  const { selected, confirming, setSelected, setConfirming, setNotes, close } =
    state;
  const { backend, session } = handle;
  const refresh = async () => {
    if (backend.capabilities.list)
      state.setItems(await backend.listItems(session));
  };
  function list() {
    void status.run(async () => {
      await refresh();
      return "Backend items loaded";
    });
  }
  function read(reference: string) {
    if (!reference.trim()) return;
    void status.run(async () => {
      const item = await backend.getItem(reference, session);
      close();
      setSelected(item);
      return "Backend item loaded";
    });
  }
  function readNotes(reference: string) {
    if (!reference.trim()) return;
    void status.run(async () => {
      const value = await backend.getNotes(reference, session);
      close();
      setNotes(value);
      return "Backend notes loaded";
    });
  }
  function save(input: SecretBackendItemInput) {
    void status.run(async () => {
      if (selected) {
        if (!backend.capabilities.update || !backend.updateItem)
          throw new Error("This backend does not update items.");
        await backend.updateItem(selected.id, input, session);
      } else {
        if (!backend.capabilities.create || !backend.createItem)
          throw new Error("This backend does not create items.");
        await backend.createItem(input, session);
      }
      await refresh();
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
    void status.run(async () => {
      if (!backend.capabilities.delete || !backend.deleteItem)
        throw new Error("This backend does not delete items.");
      await backend.deleteItem(selected.id, session);
      await refresh();
      close();
      return "Backend item deleted";
    });
  }
  function importItems() {
    void status.run(async () => {
      if (!backend.capabilities.import || !backend.importToLocal)
        throw new Error("This backend does not import items.");
      const report = await backend.importToLocal(session);
      return `${report.imported} items imported; ${report.skipped} skipped${report.warnings.length ? `; ${report.warnings.join("; ")}` : ""}`;
    });
  }
  return {
    ...status,
    ...state,
    list,
    read,
    readNotes,
    save,
    remove,
    importItems,
  };
}
export type SecretBackendWorkspaceState = ReturnType<
  typeof useSecretBackendWorkspace
>;
