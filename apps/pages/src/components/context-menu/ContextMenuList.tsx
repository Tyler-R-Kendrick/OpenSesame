import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { IconCheck } from "../Icons.js";
import "./context-menu.css";
import {
  type MenuGroup,
  type MenuItem,
  stepIndex,
  typeaheadIndex,
} from "./menu-model.js";

type Live = {
  items: readonly MenuItem[];
  active: number;
  setActive: (index: number) => void;
  activate: (item: MenuItem | undefined) => void;
  onClose: (restore: boolean) => void;
};

/**
 * While the menu is open it owns the keyboard — every key but Tab stops here,
 * so a `j` meant for the menu never moves the tree beneath it — and any
 * pointer-down outside it, a scroll, a blur or a new width closes it (a
 * scrolled page would leave it pointing at a row that moved away).
 */
function useMenuDismissal(
  own: RefObject<HTMLDivElement | null>,
  live: RefObject<Live>,
  ignoreOutside: string | undefined,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const {
        items: list,
        active: at,
        setActive,
        activate,
        onClose,
      } = live.current;
      const move = (to: number) => {
        if (to >= 0) setActive(to);
      };
      if (event.key === "Tab") {
        onClose(true);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      // The key that opened the menu, held: it may not also choose for you.
      if (event.repeat && (event.key === "Enter" || event.key === " ")) return;
      if (event.key === "Escape") onClose(true);
      else if (event.key === "ArrowDown") move(stepIndex(list, at, 1));
      else if (event.key === "ArrowUp") move(stepIndex(list, at, -1));
      else if (event.key === "Home") move(stepIndex(list, -1, 1));
      else if (event.key === "End") move(stepIndex(list, list.length, -1));
      else if (event.key === "Enter" || event.key === " ") activate(list[at]);
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey)
        move(typeaheadIndex(list, at, event.key));
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && own.current?.contains(target)) return;
      if (target && ignoreOutside && target.closest(ignoreOutside)) return;
      live.current.onClose(false);
    };
    const away = () => live.current.onClose(false);
    // A phone's keyboard or URL bar changing the height is not the person
    // leaving; a new width (rotation, a resized window) re-lays the page.
    const width = window.innerWidth;
    const resized = () => {
      if (window.innerWidth !== width) away();
    };
    // Opening can nudge its own row into view (the cursor follows the row
    // that was asked about); only a scroll after that is the person's.
    const openedAt = performance.now();
    const scrolled = (event: Event) => {
      // A long sheet scrolls itself; that is reading the menu, not leaving.
      if (event.target instanceof Node && own.current?.contains(event.target))
        return;
      if (performance.now() - openedAt > 250) away();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", away);
    window.addEventListener("resize", resized);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", resized);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [own, live, ignoreOutside]);
}

function MenuEntry({
  item,
  text,
  current,
  armed,
  entryRef,
  onHover,
  onRun,
}: {
  item: MenuItem;
  text: string;
  current: boolean;
  armed: boolean;
  entryRef: (node: HTMLButtonElement | null) => void;
  onHover: () => void;
  onRun: () => void;
}) {
  return (
    <button
      ref={entryRef}
      type="button"
      role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={item.checked}
      aria-label={text}
      aria-keyshortcuts={
        item.hint && /^[\x21-\x7e]+$/.test(item.hint) ? item.hint : undefined
      }
      aria-disabled={item.disabled || undefined}
      tabIndex={current ? 0 : -1}
      className={`ctxmenu__item${item.danger ? " is-danger" : ""}${armed ? " is-armed" : ""}`}
      onPointerMove={() => {
        if (!item.disabled && !current) onHover();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onRun();
      }}
    >
      <span className="ctxmenu__check">
        {item.checked ? <IconCheck size={12} /> : null}
      </span>
      <span className="ctxmenu__label">{text}</span>
      {item.hint ? <kbd className="ctxmenu__hint">{item.hint}</kbd> : null}
    </button>
  );
}

/**
 * One menu, drawn from groups of entries: the right-click menu and a row's
 * `⋯` menu are this same list, so a verb reads the same wherever it is found.
 *
 * It is a WAI-ARIA menu. Focus lands on the first entry; arrows, Home and End
 * move, a letter jumps to the next entry that starts with it, Enter or Space
 * runs, Escape and Tab close.
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
}) {
  const items = groups.flat();
  const [active, setActive] = useState(() => stepIndex(items, -1, 1));
  const [armed, setArmed] = useState<string | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const own = useRef<HTMLDivElement>(null);
  const activate = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return;
    if (item.confirm && armed !== item.id) {
      setArmed(item.id);
      return;
    }
    onClose(true);
    item.run();
  };
  // The listeners register once; this hands them the live values.
  const live = useRef<Live>({ items, active, setActive, activate, onClose });
  live.current = { items, active, setActive, activate, onClose };
  useMenuDismissal(own, live, ignoreOutside);

  useEffect(() => {
    buttons.current[active]?.focus({ preventScroll: true });
  }, [active]);

  let index = -1;
  return (
    <div
      ref={(node) => {
        own.current = node;
        listRef?.(node);
      }}
      className={className}
      style={style}
      role="menu"
      aria-label={label}
      onContextMenu={(event) => event.preventDefault()}
    >
      {title ? (
        <p className="ctxmenu__title" aria-hidden="true">
          {title}
        </p>
      ) : null}
      {groups.map((group, groupIndex) => [
        groupIndex > 0 ? (
          <hr key={`sep-${group[0]?.id}`} className="ctxmenu__sep" />
        ) : null,
        ...group.map((item) => {
          index += 1;
          const at = index;
          return (
            <MenuEntry
              key={item.id}
              item={item}
              text={
                armed === item.id && item.confirm ? item.confirm : item.label
              }
              current={at === active}
              armed={armed === item.id}
              entryRef={(node) => {
                buttons.current[at] = node;
              }}
              onHover={() => setActive(at)}
              onRun={() => activate(item)}
            />
          );
        }),
      ])}
    </div>
  );
}
