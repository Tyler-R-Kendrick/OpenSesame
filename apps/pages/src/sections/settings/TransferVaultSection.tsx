import { listDeviceVaults } from "@opensesame/app-core/lib/vaults.js";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconShare } from "../../components/Icons.js";
import { TransferVaultSheet } from "./TransferVaultSheet.js";
import { useVaultOwnership } from "./use-vault-ownership.js";

/**
 * "Transfer ownership" in the Danger zone, above "Delete this vault". Drawn
 * only when the person acting owns the vault and another registered user could
 * receive it (ADR 0158: a row acts, or it is absent).
 */
export function TransferVaultSection() {
  const recipients = useVaultOwnership();
  const [open, setOpen] = useState(false);
  if (recipients.length === 0) return null;
  const label =
    listDeviceVaults().find((vault) => vault.state === "open")?.label ??
    "this vault";
  return (
    <section className="panel set__danger" id="settings-transfer-vault">
      <div className="panel__head">
        <div>
          <h2>Transfer ownership</h2>
        </div>
      </div>
      <div className="panel__body">
        <div className="keyed-row">
          <p className="set__danger-target">
            <strong>{label}</strong>
            {` · ${recipients.length} ${
              recipients.length === 1 ? "user" : "users"
            } can receive it`}
          </p>
          <IconKey label="Transfer ownership" onClick={() => setOpen(true)}>
            <IconShare size={16} />
          </IconKey>
        </div>
      </div>
      {open ? (
        <TransferVaultSheet
          label={label}
          recipients={recipients}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}
