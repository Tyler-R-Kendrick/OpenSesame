import { listDeviceVaults } from "@opensesame/app-core/lib/vaults.js";
import { useState } from "react";
import { IconKey } from "../components/IconKey.js";
import { IconTrash, IconX } from "../components/Icons.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";

/** The open vault's name, as the vault list names it — never a raw tomb id. */
function openVaultLabel(): string {
  return (
    listDeviceVaults().find((vault) => vault.state === "open")?.label ??
    "this vault"
  );
}

/**
 * Deleting the open vault. The row names which vault and what goes with it
 * before the key is pressed, and the keys end that row (DESIGN.md § Keys
 * have a home); arming the key spells out the consequence in the same row.
 */
export function SettingsDangerPanel() {
  const { items } = useVault();
  const store = useVaultStore();
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const count = `${items.length} ${items.length === 1 ? "item" : "items"}`;

  return (
    <section className="panel set__danger">
      <div className="panel__head">
        <div>
          <h2>Delete this vault</h2>
        </div>
      </div>
      <div className="panel__body">
        <div className="keyed-row">
          <p className="set__danger-target">
            <strong>{openVaultLabel()}</strong>
            {confirmDestroy
              ? ` · ${count} will be unrecoverable. Export first if you are not certain.`
              : ` · ${count}`}
          </p>
          {confirmDestroy ? (
            <>
              <IconKey
                label="Delete permanently"
                danger
                armed
                onClick={() => void store.destroy()}
              >
                <IconTrash size={16} />
              </IconKey>
              <IconKey label="Cancel" onClick={() => setConfirmDestroy(false)}>
                <IconX size={16} />
              </IconKey>
            </>
          ) : (
            <IconKey
              label="Delete this vault"
              danger
              onClick={() => setConfirmDestroy(true)}
            >
              <IconTrash size={16} />
            </IconKey>
          )}
        </div>
      </div>
    </section>
  );
}
