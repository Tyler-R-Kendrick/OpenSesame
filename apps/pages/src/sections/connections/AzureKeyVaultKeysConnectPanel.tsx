/**
 * Settings › Connections › Azure Key Vault Keys — local SP configuration.
 *
 * Seals the versioned key id and client credentials in the vault so encryption
 * can bind to Azure Key Vault without a Host (ADR 0090).
 */

import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { IconCheck, IconLock, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { AzureKeyVaultKeysConnectFields } from "./AzureKeyVaultKeysConnectFields.js";
import { useAzureKeyVaultKeysConnect } from "./useAzureKeyVaultKeysConnect.js";

export { azureKeyVaultKeysConnectDependencies } from "./useAzureKeyVaultKeysConnect.js";

function AzureStatusRow({
  configured,
  active,
  label,
}: {
  configured: boolean;
  active: boolean;
  label: string | null;
}) {
  return (
    <div className="conn-azure-key-vault-keys__status">
      <StatusMark
        tone={configured ? "ok" : "idle"}
        label={
          configured
            ? label || "Azure Key Vault Keys sealed"
            : "No Azure Key Vault Keys credentials sealed yet"
        }
      />
      <StatusMark
        tone={active ? "ok" : "idle"}
        label={
          active
            ? "Preferred for vault key protection"
            : "Not the encryption preference"
        }
      />
      {configured ? (
        <StatusMark tone="ok" label="Client secret sealed" />
      ) : null}
    </div>
  );
}

export function AzureKeyVaultKeysConnectPanel({
  onFlash,
}: {
  onFlash: (flash: Flash) => void;
}) {
  const panel = useAzureKeyVaultKeysConnect(onFlash);

  if (!panel.unlocked) {
    return (
      <div className="panel__body">
        <StatusMark
          tone="warn"
          label="Unlock a vault to configure Azure Key Vault Keys on this device."
        />
      </div>
    );
  }

  return (
    <div className="panel__body">
      <AzureStatusRow
        configured={panel.configured}
        active={panel.active}
        label={panel.statusLabel}
      />
      <form
        className="conn-tile__body"
        onSubmit={(event) => void panel.save(event)}
      >
        <AzureKeyVaultKeysConnectFields
          form={panel.form}
          configured={panel.configured}
          onChange={panel.setField}
        />
        <div className="actions">
          <button
            type="submit"
            className="icon-btn icon-btn--sm"
            disabled={panel.busy}
            aria-label={
              panel.busy
                ? "Saving Azure Key Vault Keys"
                : "Save Azure Key Vault Keys"
            }
            title={
              panel.busy
                ? "Saving Azure Key Vault Keys"
                : "Save Azure Key Vault Keys"
            }
          >
            <IconCheck size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={panel.busy || !panel.configured}
            aria-label="Prefer Azure Key Vault Keys for vault key protection"
            title="Prefer Azure Key Vault Keys for vault key protection"
            onClick={panel.preferAzure}
          >
            <IconLock size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={panel.busy || !panel.configured}
            aria-label="Remove Azure Key Vault Keys configuration"
            title="Remove Azure Key Vault Keys configuration"
            onClick={() => void panel.forget()}
          >
            <IconTrash size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
