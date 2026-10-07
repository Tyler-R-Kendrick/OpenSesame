/**
 * The joiner's save for one shared field (ADR 0150 §2). The owner already
 * chose `edit` for the session; this asks them to write the new text back.
 */

import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { FieldRow } from "../../components/FieldRow.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconCheck, IconEdit } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function EditableRow({
  fieldLabel,
  editLabel,
  canEdit,
  pin,
  save,
  onSaved,
  actions,
  children,
}: {
  fieldLabel: string;
  editLabel: string;
  canEdit: boolean;
  pin: () => () => void;
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

  const commit = useLiveFieldCommit({
    pin,
    save,
    draft,
    onSaved,
    onRefused: () => setDenied(true),
    onAccepted: () => {
      setDenied(false);
      setOpen(false);
      setDraft("");
    },
  });

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

function useLiveFieldCommit({
  pin,
  save,
  draft,
  onSaved,
  onRefused,
  onAccepted,
}: {
  pin: () => () => void;
  save?: (value: string) => Promise<string | null>;
  draft: string;
  onSaved?: (value: string) => void;
  onRefused: () => void;
  onAccepted: () => void;
}) {
  const lifetime = useRef({ active: true, operation: 0 });
  useEffect(() => {
    lifetime.current.active = true;
    return () => {
      lifetime.current.active = false;
      lifetime.current.operation += 1;
    };
  }, []);
  return async (): Promise<void> => {
    if (!save) return;
    const operation = ++lifetime.current.operation;
    let value: string | null;
    try {
      const check = pin();
      check();
      value = await save(draft);
      if (!lifetime.current.active || operation !== lifetime.current.operation)
        return;
      check();
    } catch {
      if (lifetime.current.active && operation === lifetime.current.operation)
        onRefused();
      return;
    }
    if (value === null) {
      onRefused();
      return;
    }
    onAccepted();
    onSaved?.(value);
  };
}
