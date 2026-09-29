/**
 * Deleting a vault from this device (ADR 0089), as a ceremony in a sheet. The
 * vault is locked, so nothing in it is read first, and only its files on this
 * browser are cleared. The personal vault and the open one never get here.
 */

import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { IconTrash } from "../../components/Icons.js";

export function DeleteVaultSheet({
  label,
  busy,
  onDelete,
  onClose,
}: {
  label: string;
  busy: boolean;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <CeremonySheet
      title="Delete a vault"
      mark={<IconTrash size={20} />}
      foot="Copies outside this browser — a backup, another device — are not touched."
      onClose={onClose}
    >
      <CeremonyShell
        ok={false}
        top="Delete this vault?"
        name={label}
        facts={[
          { key: "Cleared", value: "its files in this browser" },
          { key: "Read first", value: "nothing; it is locked" },
        ]}
        primary={{
          label: "Delete vault",
          tone: "danger",
          busy,
          onClick: onDelete,
        }}
        secondary={{ label: "Keep it", onClick: onClose }}
      />
    </CeremonySheet>
  );
}
