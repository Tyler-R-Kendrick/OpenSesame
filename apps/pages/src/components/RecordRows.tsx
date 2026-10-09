import { type MouseEvent, useEffect, useState } from "react";
import { IconDots } from "./Icons.js";
import type { RecordWorkspaceProps, WorkspaceRow } from "./RecordWorkspace.js";
import { type MenuItem, openContextMenu } from "./context-menu/menu-model.js";
import type { useRecordWorkspace } from "./record-workspace-state.js";

type Props = RecordWorkspaceProps & {
  model: ReturnType<typeof useRecordWorkspace>;
};
type PendingMenu = { id: string; x: number; y: number };

function rowCommands(detail: HTMLElement | null): MenuItem[] {
  return [
    ...(detail?.querySelectorAll<HTMLElement>(
      ".detail__tools button, .detail__tools a, .detail__head .actions button, .detail__head .actions a",
    ) ?? []),
  ].map((control, index) => ({
    id: `record-action-${index}`,
    label:
      control.getAttribute("aria-label") ??
      control.getAttribute("title") ??
      "Action",
    disabled: control.matches(":disabled"),
    run: () => control.click(),
  }));
}

/** Resolve a row's commands after its selected detail has committed. */
function useRowMenu(model: Props["model"], selectedId: string | null) {
  const [pending, setPending] = useState<PendingMenu | null>(null);
  useEffect(() => {
    if (!pending || pending.id !== selectedId) return;
    const anchor = model.tree.current?.querySelector<HTMLElement>(
      `[data-record-id="${CSS.escape(pending.id)}"]`,
    );
    const commands = rowCommands(model.detail.current);
    openContextMenu(
      { clientX: pending.x, clientY: pending.y, preventDefault: () => {} },
      anchor ?? null,
      "Record actions",
      [
        commands.length
          ? commands
          : [
              {
                id: "record-open",
                label: "Open",
                run: () => model.detail.current?.focus(),
              },
            ],
      ],
    );
    setPending(null);
  }, [pending, selectedId, model.tree, model.detail]);
  return (event: MouseEvent, row: WorkspaceRow) => {
    event.preventDefault();
    event.stopPropagation();
    setPending({ id: row.id, x: event.clientX, y: event.clientY });
    if (row.to) model.navigate(row.to);
    else row.onOpen?.();
  };
}

export function RecordRows({
  section,
  selectedId,
  emptyMessage = "Nothing here",
  model,
}: Props) {
  const { shown, cursor, navigate } = model;
  const menu = useRowMenu(model, selectedId);
  const open = (row: WorkspaceRow) =>
    row.to ? navigate(row.to) : row.onOpen?.();
  return (
    <>
      {shown.length === 0 ? (
        <div className="empty">
          <h2>{emptyMessage}</h2>
        </div>
      ) : null}
      {shown.map((row) => (
        <div
          key={row.id}
          id={`record-${section}-${row.id}`}
          data-record-id={row.id}
          role="treeitem"
          tabIndex={-1}
          aria-label={`${row.label}${row.extension ? `.${row.extension}` : ""}`}
          aria-selected={row.id === selectedId}
          aria-level={1}
          className={`vtree__row${row.id === cursor ? " is-cursor" : ""}`}
          onClick={() => open(row)}
          onContextMenu={(event) => menu(event, row)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open(row);
            }
          }}
        >
          <span className="vtree__name">
            {row.label}
            <span className="vtree__dim">
              {row.extension ? `.${row.extension}` : ""}
            </span>
          </span>
          <span className="vtree__side">
            {row.actions}
            <button
              type="button"
              className="vtree__more"
              aria-label={`Actions for ${row.label}`}
              title={`Actions for ${row.label}`}
              onClick={(event) => menu(event, row)}
            >
              <IconDots size={14} />
            </button>
          </span>
        </div>
      ))}
    </>
  );
}
