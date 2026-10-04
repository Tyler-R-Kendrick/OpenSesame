import type { CSSProperties } from "react";
import { IconChevronLeft } from "../Icons.js";
import "./context-menu.css";
import { ParentRows, SubmenuPane } from "./MenuRows.js";
import type { MenuGroup } from "./menu-model.js";
import { useMenuSession } from "./menu-session.js";

/**
 * One menu, drawn from groups of entries: the right-click menu and a row's
 * `⋯` menu are this same list, so a verb reads the same wherever it is found.
 *
 * It is a WAI-ARIA menu. Focus lands on the first entry; arrows, Home and End
 * move, a letter jumps to the next entry that starts with it, Enter or Space
 * runs, Escape and Tab close. ArrowRight opens a row's submenu; ArrowLeft
 * and the first Escape leave it.
 */
export function ContextMenuList({
  groups,
  label,
  onClose,
  className = "ctxmenu",
  style,
  listRef,
  ignoreOutside,
  title,
  sheet = false,
}: {
  groups: readonly MenuGroup[];
  label: string;
  /** `restore`: hand focus back to where it was (Escape, Tab, an entry). */
  onClose: (restore: boolean) => void;
  className?: string;
  style?: CSSProperties;
  /** Hands the drawn list to a caller that measures it. */
  listRef?: (node: HTMLDivElement | null) => void;
  /** Pointer-downs inside this selector do not count as "outside". */
  ignoreOutside?: string;
  /** Drawn above the entries where the menu is not beside what it is for. */
  title?: string;
  /** The phone arrangement: a submenu replaces the list rather than hang off it. */
  sheet?: boolean;
}) {
  const session = useMenuSession(groups, onClose, ignoreOutside);
  return (
    <div
      ref={(node) => {
        session.own.current = node;
        listRef?.(node);
      }}
      className={`${className}${sheet && session.inSub ? " is-drilled" : ""}`}
      style={style}
      role="menu"
      aria-label={label}
      onContextMenu={(event) => event.preventDefault()}
    >
      {sheet && session.subOwner ? (
        <button
          type="button"
          className="ctxmenu__back"
          aria-label={`Back from ${session.subOwner.label}`}
          onClick={session.leave}
        >
          <IconChevronLeft size={16} />
          <span>{session.subOwner.label}</span>
        </button>
      ) : title ? (
        <p className="ctxmenu__title" aria-hidden="true">
          {title}
        </p>
      ) : null}
      <ParentRows
        groups={groups}
        armed={session.armed}
        inSub={session.inSub}
        active={session.active}
        subOwnerId={session.subOwner?.id}
        buttons={session.buttons}
        setActive={session.setActive}
        activate={session.activate}
      />
      <SubmenuPane
        owner={session.subOwner}
        items={session.subItems}
        top={session.subTop}
        armed={session.armed}
        active={session.active}
        buttons={session.subButtons}
        setActive={session.setActive}
        activate={session.activate}
      />
    </div>
  );
}
