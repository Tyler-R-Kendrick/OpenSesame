import { KIND_LABEL, type VaultItem } from "@opensesame/vault-core";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { FieldRow } from "../../components/FieldRow.js";
import { IconKey } from "../../components/IconKey.js";
import { IconShare } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

/**
 * Pick one item to seal into a one-time drop. The vault row's Share submenu
 * names the way; the item's own Share key still opens the same ceremony once
 * the item is open. Choosing an item takes the item route with `?share=drop`,
 * so the ceremony is drawn exactly as the list's `s` key draws it.
 */
export function VaultDropPicker({
  items,
  onPick,
  onClose,
}: {
  items: readonly VaultItem[];
  onPick: (item: VaultItem) => void;
  onClose: () => void;
}) {
  const live = items
    .filter((item) => item.deletedAt === null && item.kind !== "drop")
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <CeremonySheet
      title="Temporary drop"
      mark={<IconShare size={20} />}
      onClose={onClose}
    >
      {live.length === 0 ? (
        <StatusMark tone="idle" label="This vault has no item to drop." />
      ) : (
        <div className="vault-drop__list">
          {live.map((item) => (
            <FieldRow
              key={item.id}
              label={item.name || "Untitled"}
              actions={
                <IconKey
                  label={`Drop ${item.name || "this item"}`}
                  small
                  onClick={() => onPick(item)}
                >
                  <IconShare size={16} />
                </IconKey>
              }
            >
              <span className="frow__value">{KIND_LABEL[item.kind]}</span>
            </FieldRow>
          ))}
        </div>
      )}
    </CeremonySheet>
  );
}
