import type { ResetMailbox } from "@opensesame/app-core/lib/password-reset-mail.js";
import type { MailboxDraft } from "@opensesame/app-core/lib/password-reset/mailbox-store.js";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconEdit, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { MailboxForm, type SaveOutcome } from "./MailboxForm.js";

/**
 * One mailbox: its name and address, whether the app can read its mail, an
 * edit key and — only while no login is bound to it — a remove key. A control
 * whose precondition is unmet is absent, not disabled (ADR 0158).
 */
export function MailboxRow({
  mailbox,
  draft,
  bound,
  onSave,
  onRemove,
}: {
  mailbox: ResetMailbox;
  draft: MailboxDraft;
  /** How many logins name this mailbox. */
  bound: number;
  onSave: (draft: MailboxDraft) => Promise<SaveOutcome>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <MailboxForm
        adding={false}
        initial={draft}
        savedPassword={mailbox.readable}
        startAdvanced={mailbox.readable || draft.server.host !== ""}
        onSave={async (next) => {
          const outcome = await onSave(next);
          if (outcome.ok) setEditing(false);
          return outcome;
        }}
        onClose={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="field-inline" data-mailbox={mailbox.id}>
      <StatusMark
        tone={mailbox.readable ? "ok" : "idle"}
        label={
          mailbox.readable
            ? "Its mail can be read"
            : "Address only: its mail is not read"
        }
      />
      <span>
        {mailbox.name === mailbox.address
          ? mailbox.address
          : `${mailbox.name} (${mailbox.address})`}
      </span>
      <IconKey
        small
        label={`Edit ${mailbox.address}`}
        onClick={() => setEditing(true)}
      >
        <IconEdit size={16} />
      </IconKey>
      {bound === 0 ? (
        <IconKey small label={`Remove ${mailbox.address}`} onClick={onRemove}>
          <IconTrash size={16} />
        </IconKey>
      ) : null}
    </div>
  );
}
