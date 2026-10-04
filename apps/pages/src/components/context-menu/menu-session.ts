import { type RefObject, useEffect, useRef, useState } from "react";
import { useMenuDismissal, useMenuLive } from "./menu-dismissal.js";
import { type MenuGroup, type MenuItem, stepIndex } from "./menu-model.js";

type MenuWriters = {
  subTop: (top: number) => void;
  subId: (id: string | null) => void;
  armed: (id: string | null) => void;
  active: (index: number) => void;
};

function nestedItems(item: MenuItem | undefined): readonly MenuItem[] {
  if (!item?.submenu) return [];
  return item.submenu.flat();
}

function submenuOwner(
  items: readonly MenuItem[],
  subId: string | null,
): MenuItem | undefined {
  if (!subId) return undefined;
  return items.find(
    (item) => item.id === subId && nestedItems(item).length > 0,
  );
}

function openSubmenu(
  item: MenuItem,
  parentItems: readonly MenuItem[],
  buttons: readonly (HTMLButtonElement | null)[],
  writers: MenuWriters,
): boolean {
  const nested = nestedItems(item);
  if (nested.length === 0) return false;
  const at = parentItems.findIndex((candidate) => candidate.id === item.id);
  writers.subTop(buttons[at]?.offsetTop ?? 0);
  writers.subId(item.id);
  writers.armed(null);
  writers.active(stepIndex(nested, -1, 1));
  return true;
}

function closeSubmenu(
  owner: MenuItem | undefined,
  parentItems: readonly MenuItem[],
  writers: MenuWriters,
): boolean {
  if (!owner) return false;
  const at = parentItems.findIndex((item) => item.id === owner.id);
  writers.subId(null);
  writers.active(at >= 0 ? at : stepIndex(parentItems, -1, 1));
  return true;
}

function runEntry(
  item: MenuItem | undefined,
  armed: string | null,
  parentItems: readonly MenuItem[],
  buttons: readonly (HTMLButtonElement | null)[],
  writers: MenuWriters,
  onClose: (restore: boolean) => void,
): void {
  if (!item || item.disabled) return;
  if (openSubmenu(item, parentItems, buttons, writers)) return;
  if (item.confirm && armed !== item.id) {
    writers.armed(item.id);
    return;
  }
  onClose(true);
  item.run();
}

export type MenuSession = {
  active: number;
  setActive: (index: number) => void;
  armed: string | null;
  inSub: boolean;
  subOwner: MenuItem | undefined;
  subTop: number;
  subItems: readonly MenuItem[];
  buttons: RefObject<(HTMLButtonElement | null)[]>;
  subButtons: RefObject<(HTMLButtonElement | null)[]>;
  own: RefObject<HTMLDivElement | null>;
  activate: (item: MenuItem | undefined) => void;
  /** Leave the open submenu for its parent list. */
  leave: () => void;
};

/** Parent rows, and one open submenu beside the row that owns it. */
export function useMenuSession(
  groups: readonly MenuGroup[],
  onClose: (restore: boolean) => void,
  ignoreOutside: string | undefined,
): MenuSession {
  const parentItems = groups.flat();
  const [subId, setSubId] = useState<string | null>(null);
  const [subTop, setSubTop] = useState(0);
  const [active, setActive] = useState(() => stepIndex(parentItems, -1, 1));
  const [armed, setArmed] = useState<string | null>(null);
  const subOwner = submenuOwner(parentItems, subId);
  const subItems = nestedItems(subOwner);
  const inSub = subOwner !== undefined;
  const items = inSub ? subItems : parentItems;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const subButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const own = useRef<HTMLDivElement>(null);
  const writers: MenuWriters = {
    subTop: setSubTop,
    subId: setSubId,
    armed: setArmed,
    active: setActive,
  };
  const activate = (item: MenuItem | undefined) => {
    runEntry(item, armed, parentItems, buttons.current, writers, onClose);
  };
  const onRight = () => {
    const item = items[active];
    if (item) openSubmenu(item, parentItems, buttons.current, writers);
  };
  const onLeft = () => closeSubmenu(subOwner, parentItems, writers);
  const live = useMenuLive({
    items,
    active,
    setActive,
    activate,
    onClose,
    onRight,
    onLeft,
  });
  useMenuDismissal(own, live, ignoreOutside);
  useEffect(() => {
    const row = inSub ? subButtons.current : buttons.current;
    row[active]?.focus({ preventScroll: true });
  }, [active, inSub]);
  return {
    active,
    setActive,
    armed,
    inSub,
    subOwner,
    subTop,
    subItems,
    buttons,
    subButtons,
    own,
    activate,
    leave: () => void onLeft(),
  };
}
