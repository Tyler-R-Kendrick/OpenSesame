/**
 * Settings › Connections › AWS KMS — local SigV4 credential configuration.
 *
 * Seals the key ARN and access keys in the vault so encryption can bind to
 * AWS KMS without a Host (ADR 0090).
 */

import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { IconCheck, IconLock, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { AwsKmsConnectFields } from "./AwsKmsConnectFields.js";
import { useAwsKmsConnect } from "./useAwsKmsConnect.js";

export { awsKmsConnectDependencies } from "./useAwsKmsConnect.js";

function AwsKmsStatusRow({
  configured,
  active,
  label,
}: {
  configured: boolean;
  active: boolean;
  label: string | null;
}) {
  return (
    <div className="conn-aws-kms__status">
      <StatusMark
        tone={configured ? "ok" : "idle"}
        label={
          configured
            ? label || "AWS KMS sealed"
            : "No AWS KMS credentials sealed yet"
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
        <StatusMark tone="ok" label="Secret access key sealed" />
      ) : null}
    </div>
  );
}

export function AwsKmsConnectPanel({
  onFlash,
}: {
  onFlash: (flash: Flash) => void;
}) {
  const panel = useAwsKmsConnect(onFlash);

  if (!panel.unlocked) {
    return (
      <div className="panel__body">
        <StatusMark
          tone="warn"
          label="Unlock a vault to configure AWS KMS on this device."
        />
      </div>
    );
  }

  return (
    <div className="panel__body">
      <AwsKmsStatusRow
        configured={panel.configured}
        active={panel.active}
        label={panel.statusLabel}
      />
      <form
        className="conn-tile__body"
        onSubmit={(event) => void panel.save(event)}
      >
        <AwsKmsConnectFields
          form={panel.form}
          configured={panel.configured}
          onChange={panel.setField}
        />
        <div className="actions">
          <button
            type="submit"
            className="icon-btn icon-btn--sm"
            disabled={panel.busy}
            aria-label={panel.busy ? "Saving AWS KMS" : "Save AWS KMS"}
            title={panel.busy ? "Saving AWS KMS" : "Save AWS KMS"}
          >
            <IconCheck size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={panel.busy || !panel.configured}
            aria-label="Prefer AWS KMS for vault key protection"
            title="Prefer AWS KMS for vault key protection"
            onClick={panel.preferAwsKms}
          >
            <IconLock size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={panel.busy || !panel.configured}
            aria-label="Remove AWS KMS configuration"
            title="Remove AWS KMS configuration"
            onClick={() => void panel.forget()}
          >
            <IconTrash size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
