import { useState } from "react";
import { IconTrash, IconX } from "../components/Icons.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";

export function SettingsDangerPanel() {
  const { items } = useVault();
  const store = useVaultStore();
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  return (
    <section className="panel set__danger">
      <div className="panel__head">
        <div>
          <h2>Delete this vault</h2>
        </div>
        {confirmDestroy ? (
          <div className="actions">
            <button
              type="button"
              className="icon-btn icon-btn--danger is-armed"
              aria-label="Delete permanently"
              title="Delete permanently"
              onClick={() => void store.destroy()}
            >
              <IconTrash size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Cancel"
              title="Cancel"
              onClick={() => setConfirmDestroy(false)}
            >
              <IconX size={16} />
            </button>
          </div>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="icon-btn icon-btn--danger"
              aria-label="Delete this vault"
              title="Delete this vault"
              onClick={() => setConfirmDestroy(true)}
            >
              <IconTrash size={16} />
            </button>
          </div>
        )}
      </div>
      {confirmDestroy ? (
        <div className="panel__body">
          <p className="note note--err">
            <span>
              {items.length} {items.length === 1 ? "item" : "items"} will be
              unrecoverable. Export first if you are not certain.
            </span>
          </p>
        </div>
      ) : null}
    </section>
  );
}
