/**
 * Transferring the open vault to another registered user, as a ceremony in a
 * sheet. The recipient is chosen from the vault's own people, and their name is
 * typed back before the key works — the way GitHub asks for the repository's
 * name. The vault key does not move with the owner role, and the sheet says so.
 */

import { LocalDirectoryError } from "@opensesame/app-core/lib/local-directory.js";
import type { LocalIdentity } from "@opensesame/app-core/lib/local-directory.js";
import { transferVaultOwnership } from "@opensesame/app-core/lib/vault-ownership.js";
import { useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconShare } from "../../components/Icons.js";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import { useVault } from "../../lib/vault/hooks.js";

export function TransferVaultSheet({
  label,
  recipients,
  onClose,
}: {
  label: string;
  recipients: readonly LocalIdentity[];
  onClose: () => void;
}) {
  const { tomb } = useVault();
  const [toId, setToId] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useFailureNotice("vault-transfer", "Ownership not transferred", failure);
  const target = recipients.find((person) => person.id === toId);
  const ready = target !== undefined && typed === target.name;

  const transfer = () => {
    if (!target || !tomb) return;
    setBusy(true);
    setFailure(null);
    transferVaultOwnership(tomb, target.id)
      .then(onClose)
      .catch((error) => {
        setFailure(
          error instanceof LocalDirectoryError
            ? error.message
            : "The vault's ownership could not be transferred.",
        );
        setBusy(false);
      });
  };

  return (
    <CeremonySheet
      title="Transfer ownership"
      mark={<IconShare size={20} />}
      onClose={onClose}
    >
      <CeremonyShell
        name={label}
        facts={[
          { key: "New owner", value: target?.name ?? "—" },
          { key: "You become", value: "admin" },
          { key: "Vault key", value: "not moved" },
        ]}
        primary={{
          label: "Transfer ownership",
          icon: <IconShare size={16} />,
          tone: "danger",
          busy,
          disabled: !ready,
          onClick: transfer,
        }}
      >
        <div
          className="transfer-choices"
          role="radiogroup"
          aria-label="New owner"
        >
          {recipients.map((person) => (
            <button
              key={person.id}
              type="button"
              className="transfer-choice"
              aria-pressed={person.id === toId}
              onClick={() => {
                setToId(person.id);
                setTyped("");
              }}
            >
              {person.name}
            </button>
          ))}
        </div>
        {target ? (
          <FieldShell
            id="transfer-vault-confirm"
            label={`Type ${target.name} to confirm`}
            autoComplete="off"
            value={typed}
            onValueChange={setTyped}
            onEnter={() => {
              if (ready) transfer();
            }}
          />
        ) : null}
      </CeremonyShell>
    </CeremonySheet>
  );
}
