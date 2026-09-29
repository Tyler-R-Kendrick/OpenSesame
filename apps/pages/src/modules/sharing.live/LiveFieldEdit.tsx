/**
 * The joiner's save for one shared field (ADR 0150 §2). The owner already
 * chose `edit` for the session; this asks them to write the new text back.
 */

import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { FieldRow } from "../../components/FieldRow.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconCheck, IconEdit } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function EditableRow({
  fieldLabel,
  editLabel,
  canEdit,
  save,
  onSaved,
  actions,
  children,
}: {
  fieldLabel: string;
  editLabel: string;
  canEdit: boolean;
  save?: (value: string) => Promise<string | null>;
  onSaved?: (value: string) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [denied, setDenied] = useState(false);
  const id = useId();
  const editing = canEdit && save !== undefined && open;

  useEffect(() => {
    if (!editing) return;
    document.getElementById(id)?.focus();
  }, [editing, id]);

  async function commit(): Promise<void> {
    if (!save) return;
    const value = await save(draft);
    if (value === null) {
      setDenied(true);
      return;
    }
    setDenied(false);
    setOpen(false);
    setDraft("");
    onSaved?.(value);
  }

  return (
    <FieldRow
      label={fieldLabel}
      actions={
        <>
          {actions}
          {canEdit && save && !open ? (
            <button
              type="button"
              className="icon-btn"
              aria-label={`Edit ${editLabel}`}
              title={`Edit ${editLabel}`}
              onClick={() => {
                setDenied(false);
                setOpen(true);
              }}
            >
              <IconEdit size={17} />
            </button>
          ) : null}
          {editing ? (
            <button
              type="button"
              className="icon-btn"
              aria-label={`Save ${editLabel}`}
              title={`Save ${editLabel}`}
              onClick={() => void commit()}
            >
              <IconCheck size={17} />
            </button>
          ) : null}
        </>
      }
    >
      {children}
      {editing ? (
        <div className="live-edit">
          <FieldShell
            id={id}
            label={`New ${editLabel}`}
            value={draft}
            onValueChange={setDraft}
            onEnter={() => void commit()}
          />
          {denied ? <StatusMark tone="err" label="The owner refused" /> : null}
        </div>
      ) : null}
    </FieldRow>
  );
}
