import type { ItemRow } from "@opensesame/vault-core";
import { IconDots } from "../../components/Icons.js";
import { ContextMenuList } from "../../components/context-menu/ContextMenuList.js";
import { type VaultTreeActions, vaultItemMenu } from "./vault-menu.js";

/**
 * A vault item's `⋯` button and the menu it opens. The menu
 * seats above its row when the scrollport would clip it
 * below (`menuAbove`, from `useMenuFlip`), and hands the
 * keyboard back to the tree when it closes.
 */
export function VaultRowMenu({
  actions,
  listRef,
  menuAbove,
  menuFor,
  onClose,
  row,
  setCursor,
  setMenuFor,
}: {
  actions: VaultTreeActions;
  listRef: (node: HTMLDivElement | null) => void;
  menuAbove: boolean;
  menuFor: string | null;
  onClose: (restore: boolean) => void;
  row: ItemRow;
  setCursor: (key: string) => void;
  setMenuFor: (key: string | null) => void;
}) {
  return (
    <>
      <button
        type="button"
        className="vtree__more"
        data-vtree-more=""
        aria-label={`Actions for ${row.name}`}
        aria-haspopup="menu"
        aria-expanded={menuFor === row.key}
        onClick={(event) => {
          event.stopPropagation();
          setCursor(row.key);
          setMenuFor(menuFor === row.key ? null : row.key);
        }}
      >
        <IconDots size={14} />
      </button>
      {menuFor === row.key ? (
        <ContextMenuList
          className={`ctxmenu vtree__menu${
            menuAbove ? " vtree__menu--above" : ""
          }`}
          label={`Actions for ${row.name}`}
          groups={vaultItemMenu(row.item, actions)}
          ignoreOutside="[data-vtree-more]"
          listRef={listRef}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}
