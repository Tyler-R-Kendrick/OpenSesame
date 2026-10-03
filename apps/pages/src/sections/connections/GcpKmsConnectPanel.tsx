/**
 * Settings › Connections › Google Cloud KMS — local service-account config.
 *
 * Seals the crypto key name and service-account JSON in the vault so the key
 * can be enrolled as a vault key protector, and proved, without a Host
 * (ADR 0090).
 */

import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { GcpKmsConnectFields } from "./GcpKmsConnectFields.js";
import { useGcpKmsConnect } from "./useGcpKmsConnect.js";

export { gcpKmsConnectDependencies } from "./useGcpKmsConnect.js";

function GcpKmsStatusRow({
  configured,
  enrolled,
  label,
}: {
  configured: boolean;
  enrolled: boolean;
  label: string | null;
}) {
  return (
    <div className="conn-gcp-kms__status">
      <StatusMark
        tone={configured ? "ok" : "idle"}
        label={
          configured
            ? label || "Google Cloud KMS sealed"
            : "No Google Cloud KMS credentials sealed yet"
        }
      />
      {enrolled ? (
        <StatusMark tone="ok" label="Protects this vault's key" />
      ) : null}
      {configured ? (
        <StatusMark tone="ok" label="Service account sealed" />
      ) : null}
    </div>
  );
}

export function GcpKmsConnectPanel({
  onFlash,
}: {
  onFlash: (flash: Flash) => void;
}) {
  const panel = useGcpKmsConnect(onFlash);

  if (!panel.unlocked) {
    return (
      <div className="panel__body">
        <StatusMark
          tone="warn"
          label="Unlock a vault to configure Google Cloud KMS on this device."
        />
      </div>
    );
  }

  return (
    <div className="panel__body">
      <GcpKmsStatusRow
        configured={panel.configured}
        enrolled={panel.enrolled}
        label={panel.statusLabel}
      />
      <form
        className="conn-tile__body"
        onSubmit={(event) => void panel.save(event)}
      >
        <GcpKmsConnectFields
          form={panel.form}
          configured={panel.configured}
          identityLocked={panel.enrolled}
          onChange={panel.setField}
        />
        <FormCommit
          label={
            panel.busy ? "Saving Google Cloud KMS" : "Save Google Cloud KMS"
          }
          disabled={panel.busy}
        >
          {panel.enrolled || !panel.configured ? null : (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              disabled={panel.busy}
              aria-label="Remove Google Cloud KMS configuration"
              title="Remove Google Cloud KMS configuration"
              onClick={() => void panel.forget()}
            >
              <IconTrash size={16} />
            </button>
          )}
        </FormCommit>
      </form>
    </div>
  );
}
