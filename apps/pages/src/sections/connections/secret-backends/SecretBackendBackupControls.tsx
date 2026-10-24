import type { SecretBackendItemSummary } from "@opensesame/app-core/lib/secret-backends/types.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconDownload, IconUpload } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import {
  useSecretBackendAction,
  useSecretBackendOwnerSignal,
} from "./useSecretBackendAction.js";
import type { SecretBackendHandle } from "./useSecretBackendWorkspace.js";

export const secretBackendBackupDependencies = {
  async backup(
    handle: SecretBackendHandle,
    name: string,
    assertCurrent: () => void,
  ): Promise<SecretBackendItemSummary> {
    assertCurrent();
    const { backUpVaultToSecretBackend } = await import(
      "@opensesame/app-core/lib/secret-backends/backup-transfer.js"
    );
    assertCurrent();
    return backUpVaultToSecretBackend(handle, name, undefined, assertCurrent);
  },
  async restore(
    handle: SecretBackendHandle,
    reference: string,
    secret: string,
    assertCurrent: () => void,
  ): Promise<number> {
    assertCurrent();
    const { restoreVaultFromSecretBackend } = await import(
      "@opensesame/app-core/lib/secret-backends/backup-transfer.js"
    );
    assertCurrent();
    return restoreVaultFromSecretBackend(
      handle,
      reference,
      secret,
      undefined,
      assertCurrent,
    );
  },
};

type Props = {
  handle: SecretBackendHandle;
  onFlash: (flash: Flash) => void;
  fixedReference?: string;
};
function useBackupAction({ handle, onFlash }: Props) {
  const signal = useSecretBackendOwnerSignal(
    handle.backend.signal,
    handle.session.signal,
  );
  return useSecretBackendAction(onFlash, signal);
}
function RestoreForm({ handle, onFlash, fixedReference }: Props) {
  const status = useBackupAction({ handle, onFlash });
  const [reference, setReference] = useState(fixedReference ?? "");
  const [secret, setSecret] = useState("");
  function restore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const credential = secret;
    setSecret("");
    void status.run(async (owner) => {
      const count = await secretBackendBackupDependencies.restore(
        handle,
        reference,
        credential,
        owner.check,
      );
      owner.check();
      return `${count} items restored from encrypted backup`;
    });
  }
  return (
    <form
      className="cx-form panel__body"
      aria-label="Restore vault backup"
      onSubmit={restore}
    >
      <FieldShell
        label="Backup name or ID"
        value={reference}
        disabled={status.busy}
        readOnly={fixedReference !== undefined}
        onValueChange={setReference}
      />
      <FieldShell
        label="Backup password or PIN"
        value={secret}
        type="password"
        autoComplete="off"
        disabled={status.busy}
        onValueChange={setSecret}
      />
      <FormCommit
        label="Restore encrypted vault backup"
        disabled={status.busy || !reference || !secret}
        busy={status.busy}
        icon={<IconDownload size={18} />}
      >
        {status.failure ? (
          <StatusMark tone="err" label={status.failure} />
        ) : null}
        {status.result ? <StatusMark tone="ok" label={status.result} /> : null}
      </FormCommit>
      <FailureNotice
        id={`backend-restore-${handle.session.id}`}
        title="Restore vault backup"
        message={status.failure}
      />
    </form>
  );
}
function BackupForm({ handle, onFlash }: Props) {
  const status = useBackupAction({ handle, onFlash });
  const [name, setName] = useState("opensesame-vault-backup");
  const [reference, setReference] = useState("");
  function backup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void status.run(async (owner) => {
      const item = await secretBackendBackupDependencies.backup(
        handle,
        name,
        owner.check,
      );
      owner.check();
      setReference(item.id);
      return "Encrypted vault backup saved and verified";
    });
  }
  return (
    <form
      className="cx-form panel__body"
      aria-label="Back up vault"
      onSubmit={backup}
    >
      <FieldShell
        label="Backup name"
        value={name}
        disabled={status.busy}
        onValueChange={setName}
      />
      {reference ? (
        <FieldShell label="Saved backup ID" value={reference} readOnly mono />
      ) : null}
      <FormCommit
        label="Back up encrypted vault"
        disabled={status.busy || !name}
        busy={status.busy}
        icon={<IconUpload size={18} />}
      >
        {status.failure ? (
          <StatusMark tone="err" label={status.failure} />
        ) : null}
        {status.result ? <StatusMark tone="ok" label={status.result} /> : null}
      </FormCommit>
      <FailureNotice
        id={`backend-backup-${handle.session.id}`}
        title="Back up vault"
        message={status.failure}
      />
    </form>
  );
}
export function SecretBackendBackupControls(props: Props) {
  const { capabilities, createItem } = props.handle.backend;
  const canWrite =
    capabilities.create &&
    capabilities.get &&
    !!createItem &&
    !!capabilities.vaultBackup;
  if (!canWrite && !capabilities.get) return null;
  return (
    <section className="panel" aria-label="Encrypted vault backups">
      <div className="panel__head">
        <h2>
          <span className="cx-step">5</span> Vault backups
        </h2>
      </div>
      {canWrite ? <BackupForm {...props} /> : null}
      {capabilities.get ? <RestoreForm {...props} /> : null}
    </section>
  );
}
