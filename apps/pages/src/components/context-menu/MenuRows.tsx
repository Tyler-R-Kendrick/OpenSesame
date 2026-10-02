import { Fragment, type ReactNode, type RefObject } from "react";
import { IconCheck } from "../Icons.js";
import type { MenuGroup, MenuItem } from "./menu-model.js";

function entryText(item: MenuItem, armed: string | null): string {
  if (armed === item.id && item.confirm) return item.confirm;
  return item.label;
}

function MenuEntry({
  item,
  text,
  current,
  armed,
  entryRef,
  onHover,
  onRun,
  expanded = false,
}: {
  item: MenuItem;
  text: string;
  current: boolean;
  armed: boolean;
  entryRef: (node: HTMLButtonElement | null) => void;
  onHover: () => void;
  onRun: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      ref={entryRef}
      type="button"
      role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={item.checked}
      aria-label={text}
      aria-haspopup={item.submenu ? "menu" : undefined}
      aria-expanded={item.submenu ? expanded : undefined}
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
      {item.submenu ? (
        <span className="ctxmenu__more" aria-hidden="true">
          ›
        </span>
      ) : null}
    </button>
  );
}

type RowShared = {
  armed: string | null;
  active: number;
  setActive: (index: number) => void;
  activate: (item: MenuItem | undefined) => void;
};

type ParentRowsProps = RowShared & {
  groups: readonly MenuGroup[];
  inSub: boolean;
  subOwnerId: string | undefined;
  buttons: RefObject<(HTMLButtonElement | null)[]>;
};

function parentEntry(item: MenuItem, at: number, view: ParentRowsProps) {
  return (
    <MenuEntry
      key={item.id}
      item={item}
      text={entryText(item, view.armed)}
      current={!view.inSub && at === view.active}
      armed={view.armed === item.id}
      expanded={view.subOwnerId === item.id}
      entryRef={(node) => {
        view.buttons.current[at] = node;
      }}
      onHover={() => {
        if (!view.inSub) view.setActive(at);
      }}
      onRun={() => view.activate(item)}
    />
  );
}

/** The groups, with a rule between them. Indexes run through the whole list. */
export function ParentRows(props: ParentRowsProps): ReactNode {
  let index = -1;
  return props.groups.map((group, groupIndex) => (
    <Fragment key={group[0]?.id ?? groupIndex}>
      {groupIndex > 0 ? <hr className="ctxmenu__sep" /> : null}
      {group.map((item) => {
        index += 1;
        return parentEntry(item, index, props);
      })}
    </Fragment>
  ));
}

type SubmenuProps = RowShared & {
  owner: MenuItem | undefined;
  items: readonly MenuItem[];
  top: number;
  buttons: RefObject<(HTMLButtonElement | null)[]>;
};

/** The open submenu, lined up with the row that owns it. */
export function SubmenuPane({
  owner,
  items,
  top,
  armed,
  active,
  buttons,
  setActive,
  activate,
}: SubmenuProps): ReactNode {
  if (!owner) return null;
  return (
    <div
      className="ctxmenu ctxmenu__sub"
      role="menu"
      aria-label={owner.label}
      style={{ top }}
    >
      {items.map((item, at) => (
        <MenuEntry
          key={item.id}
          item={item}
          text={entryText(item, armed)}
          current={at === active}
          armed={armed === item.id}
          entryRef={(node) => {
            buttons.current[at] = node;
          }}
          onHover={() => setActive(at)}
          onRun={() => activate(item)}
        />
      ))}
    </div>
  );
}
