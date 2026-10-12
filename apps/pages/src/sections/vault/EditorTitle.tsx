import {
  FIELD_LIMITS,
  clampTypedPath,
} from "@opensesame/app-core/lib/vault/field-limits.js";
import type { Folder } from "@opensesame/vault-core";
import { type KeyboardEvent, useRef } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconStar } from "../../components/Icons.js";
import { isTouchPointer } from "../../lib/gestures.js";
import { EditorFolder } from "./EditorFolder.js";
import { EditorType } from "./EditorType.js";

/**
 * The item's whole identity as one path control: `folder/` `name` `.type`.
 *
 * The folder leads and the type ends, each drawn in the accent so it reads as
 * structure and not as part of the name, and each chosen from a typeahead
 * list. The name between them is free text with one rule: a `/` finishes a
 * folder, so `Work/Taxes/` typed at its start becomes the folder segment as
 * the slash is typed. The three fields are one row with one rule under it,
 * and ArrowLeft / ArrowRight at an edge of one cross into the next.
 */
export function EditorTitle({
  value,
  folders,
  onName,
  onFolder,
  onBlur,
  typeId,
  onTypeChange,
  placeholder = "Untitled",
  focusName = false,
  onPin,
}: {
  value: { name: string; folderId: string | null; favorite?: boolean };
  folders: Folder[];
  onName: (name: string) => void;
  onFolder: (folder: Folder | null) => void;
  onBlur: () => void;
  typeId: string;
  onTypeChange?: (typeId: string) => void;
  placeholder?: string;
  focusName?: boolean;
  /** Pin to the top of the list: a pressed star on the title, not a form row. */
  onPin?: (pinned: boolean) => void;
}) {
  const nameField = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLDivElement>(null);

  const toName = () => {
    const field = nameField.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };

  function cross(event: KeyboardEvent<HTMLDivElement>) {
    const { key, target } = event;
    if (event.defaultPrevented || event.shiftKey) return;
    if (key !== "ArrowLeft" && key !== "ArrowRight") return;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.selectionStart !== target.selectionEnd) return;
    const fields = [...(row.current?.querySelectorAll("input") ?? [])];
    const from = fields.indexOf(target);
    const edge = key === "ArrowLeft" ? 0 : target.value.length;
    const next = fields[from + (key === "ArrowLeft" ? -1 : 1)];
    if (!next || target.selectionStart !== edge) return;
    event.preventDefault();
    next.focus();
  }

  return (
    <div className="editor__titlerow">
      {/* The wrapper only forwards arrow keys that the inputs inside it leave unhandled. */}
      <div className="pathfield" ref={row} onKeyDown={cross}>
        <EditorFolder
          value={value.folderId}
          folders={folders}
          onChange={onFolder}
          onPicked={toName}
        />
        <input
          ref={nameField}
          className="editor__name pathfield__name"
          aria-label="Name"
          autoComplete="off"
          maxLength={FIELD_LIMITS.folder + FIELD_LIMITS.name}
          value={value.name}
          placeholder={placeholder}
          // The cap stops text growing past it; an edit that shortens a name
          // already over it (stored before the cap) is taken exactly as made.
          onChange={(event) => {
            const next = event.target.value;
            onName(
              next.length < value.name.length ? next : clampTypedPath(next),
            );
          }}
          onBlur={onBlur}
          // biome-ignore lint/a11y/noAutofocus: explicit new/edit action focuses the name on desktop, never opening a mobile keyboard
          autoFocus={focusName && !isTouchPointer()}
        />
        <EditorType typeId={typeId} onChange={onTypeChange} />
      </div>
      {onPin ? (
        <IconKey
          label={value.favorite ? "Unpin item" : "Pin item"}
          small
          aria-pressed={Boolean(value.favorite)}
          onClick={() => onPin(!value.favorite)}
        >
          <IconStar size={16} filled={Boolean(value.favorite)} />
        </IconKey>
      ) : null}
    </div>
  );
}
