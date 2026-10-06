import { shareText } from "@opensesame/app-core/sections/vault-section-model.js";
import type { VaultItem } from "@opensesame/vault-core";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ItemTools } from "./ItemTools.js";
import { SecretShares, useCanShare } from "./item-contributions.js";

/**
 * Sharing an open item once: the toolbar's Share key and the ceremony it opens
 * under the fields. Both are absent where nothing can share the item (sharing
 * off, a drop record, the trash, no value to send). The list's `s` key arrives
 * with `?share=drop` and finds the ceremony open; closing it hands the focus
 * back to the key.
 */
export type ItemShare = {
  /** The toolbar's Share key: its state and its press, absent where it is not drawn. */
  tool: ComponentProps<typeof ItemTools>["share"];
  /** The ceremony the key opens, drawn under the item's fields. */
  ceremony: ReactNode;
};

export function useItemShare(
  item: VaultItem | undefined,
  search: string,
): ItemShare {
  const opensShare = () => new URLSearchParams(search).get("share") === "drop";
  const [open, setOpen] = useState(opensShare);
  const key = useRef<HTMLButtonElement | null>(null);
  const sharing = useCanShare();
  const itemId = item?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the item is the trigger — a ceremony left open must not follow a move to another item
  useEffect(() => {
    setOpen(opensShare());
  }, [itemId]);

  const canShare =
    item !== undefined &&
    sharing &&
    item.deletedAt === null &&
    item.kind !== "drop" &&
    shareText(item) !== null;
  if (!canShare) return { tool: undefined, ceremony: null };
  return {
    tool: { open, onToggle: () => setOpen((on) => !on), keyRef: key },
    ceremony: (
      <SecretShares
        item={item}
        open={open}
        onClose={() => {
          setOpen(false);
          key.current?.focus();
        }}
      />
    ),
  };
}
