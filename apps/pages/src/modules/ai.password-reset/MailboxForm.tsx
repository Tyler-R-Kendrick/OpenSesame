import {
  EMPTY_DRAFT,
  type MailboxDraft,
} from "@opensesame/app-core/lib/password-reset/mailbox-store.js";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconPlus,
  IconX,
} from "../../components/Icons.js";
import { MailboxFields } from "./MailboxFields.js";

/** What a save answered: done, or the field to mark (none when it was not a field's fault). */
export type SaveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly field: "address" | "port" | null };

/**
 * One mailbox being added or changed. Enter in a field saves; the chevron
 * shows or hides the server and the login. A refusal marks the field in the
 * form and is raised to the tray by the caller, never written in the page.
 */
export function MailboxForm({
  initial = EMPTY_DRAFT,
  savedPassword = false,
  startAdvanced = false,
  adding,
  onSave,
  onClose,
}: {
  initial?: MailboxDraft;
  savedPassword?: boolean;
  startAdvanced?: boolean;
  /** A new mailbox: the save key is a plus, and there is nothing to close. */
  adding: boolean;
  onSave: (draft: MailboxDraft) => Promise<SaveOutcome>;
  onClose?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [advanced, setAdvanced] = useState(startAdvanced);
  const [invalid, setInvalid] = useState<"address" | "port" | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await onSave(draft);
      if (outcome.ok) {
        setInvalid(null);
        if (adding) {
          setDraft(EMPTY_DRAFT);
          setAdvanced(false);
        }
      } else {
        setInvalid(outcome.field);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="editor__grid"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <MailboxFields
        draft={draft}
        advanced={advanced}
        invalid={invalid}
        savedPassword={savedPassword}
        onChange={(next) => {
          setDraft(next);
          setInvalid(null);
        }}
      />
      <div className="field-inline">
        <IconKey
          type="submit"
          label={adding ? "Add reset email" : "Save reset email"}
          disabled={busy}
        >
          {adding ? <IconPlus size={16} /> : <IconCheck size={16} />}
        </IconKey>
        <IconKey
          small
          label={advanced ? "Hide mail server" : "Show mail server"}
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? (
            <IconChevronUp size={16} />
          ) : (
            <IconChevronDown size={16} />
          )}
        </IconKey>
        {onClose ? (
          <IconKey small label="Close editor" onClick={onClose}>
            <IconX size={16} />
          </IconKey>
        ) : null}
      </div>
    </form>
  );
}
