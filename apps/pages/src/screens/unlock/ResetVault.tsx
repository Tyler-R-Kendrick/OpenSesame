import { IconKey } from "../../components/IconKey.js";
import { IconTrash, IconX } from "../../components/Icons.js";

/**
 * "Forgotten how to unlock?", answered: the consequence in prose, then the
 * two keys — delete this vault, or keep it. The verbs are the keys' names,
 * never words painted on them (DESIGN.md § Actions are symbols).
 */
export function ResetVault({
  onDelete,
  onKeep,
}: {
  onDelete: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="unlock__danger">
      <p>
        Deleting removes the encrypted vault from this browser. Without an
        enrolled unlock method its contents are already unrecoverable — this
        only clears the file so you can start again.
      </p>
      <div className="actions">
        <IconKey label="Delete this vault" danger onClick={onDelete}>
          <IconTrash size={16} />
        </IconKey>
        <IconKey label="Keep it" small onClick={onKeep}>
          <IconX size={16} />
        </IconKey>
      </div>
    </div>
  );
}
