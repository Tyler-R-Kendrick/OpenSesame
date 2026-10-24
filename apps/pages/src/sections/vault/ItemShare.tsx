import { accessIdentitySharePath } from "@opensesame/app-core/lib/access-routes.js";
import { isCommandSection } from "@opensesame/app-core/lib/command-bar/types.js";
import { shareText } from "@opensesame/app-core/sections/vault-share-text.js";
import type { VaultItem } from "@opensesame/vault-core";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
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
  const navigate = useNavigate();
  const location = useLocation();
  const canGrant = isCommandSection("/access");
  const sharing = useCanShare();
  const itemId = item?.id;

  // The item and its search are the trigger: the row menu navigates the open
  // item to `?share=drop`, which does not remount it. A ceremony left open
  // must not follow a move to another item.
  // biome-ignore lint/correctness/useExhaustiveDependencies: search carries the one-shot request
  useEffect(() => {
    if (opensShare()) setOpen(true);
  }, [itemId, search]);

  const canShare =
    item !== undefined &&
    sharing &&
    item.deletedAt === null &&
    item.kind !== "drop" &&
    shareText(item) !== null;
  if (!canShare) return { tool: undefined, ceremony: null };
  return {
    tool: {
      open,
      onOpen: () => setOpen(true),
      onGrant: canGrant
        ? () => navigate(accessIdentitySharePath(item.id))
        : undefined,
      onShare:
        typeof navigator.share === "function"
          ? () => {
              void navigator
                .share({ title: item.name, text: item.name })
                .catch(() => undefined);
            }
          : undefined,
      keyRef: key,
    },
    ceremony: (
      <SecretShares
        item={item}
        open={open}
        onClose={() => {
          setOpen(false);
          key.current?.focus();
          const params = new URLSearchParams(location.search);
          if (params.get("share") === "drop") {
            params.delete("share");
            const search = params.toString();
            navigate(
              {
                pathname: location.pathname,
                search: search ? `?${search}` : "",
              },
              { replace: true },
            );
          }
        }}
      />
    ),
  };
}
