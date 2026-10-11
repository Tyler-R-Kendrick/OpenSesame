import {
  accountsBoundTo,
  resetMailboxes,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import {
  type MailboxDraft,
  type MailboxSave,
  addMailbox,
  mailboxDraft,
  removeMailbox,
  updateMailbox,
} from "@opensesame/app-core/lib/password-reset/mailbox-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import { MailboxForm, type SaveOutcome } from "./MailboxForm.js";
import { MailboxRow } from "./MailboxRow.js";
import { refusalField, refusalText } from "./mailbox-copy.js";

const snapshot = () => vaultStore.getSnapshot();

type Failure = { readonly message: string };

/**
 * The vault's reset mailboxes, drawn in the Password reset section of Settings
 * › Capabilities: zero, one or many `email-account` items, each an address and,
 * if wanted, the server and login that let the app read its mail. A login picks
 * one in its own editor.
 */
export function PasswordResetMailPanel() {
  const state = useSyncExternalStore(vaultStore.subscribe, snapshot, snapshot);
  const [failure, setFailure] = useState<Failure | null>(null);
  useFailureNotice(
    "password-reset-mailbox",
    "Reset email not saved",
    failure?.message ?? null,
    "err",
    { occurrence: failure },
  );
  const rows = useMemo(
    () =>
      resetMailboxes(state.items).flatMap((mailbox) => {
        const item = state.items.find((entry) => entry.id === mailbox.id);
        const draft = item ? mailboxDraft(item) : null;
        return draft ? [{ mailbox, draft }] : [];
      }),
    [state.items],
  );
  if (state.status !== "unlocked") return null;

  const finish = (saved: MailboxSave): SaveOutcome => {
    if (saved.ok) {
      setFailure(null);
      return { ok: true };
    }
    setFailure({ message: refusalText(saved.refusal) });
    return { ok: false, field: refusalField(saved.refusal) };
  };
  const guarded = async (run: () => Promise<MailboxSave>) => {
    try {
      return finish(await run());
    } catch {
      setFailure({ message: "The reset email could not be saved." });
      return { ok: false, field: null } satisfies SaveOutcome;
    }
  };

  return (
    <div className="editor__grid">
      {rows.map(({ mailbox, draft }) => (
        <MailboxRow
          key={mailbox.id}
          mailbox={mailbox}
          draft={draft}
          bound={accountsBoundTo(state.items, mailbox.id).length}
          onSave={(next: MailboxDraft) =>
            guarded(() => updateMailbox(vaultStore, mailbox.id, next))
          }
          onRemove={() => void removeMailbox(vaultStore, mailbox.id)}
        />
      ))}
      <MailboxForm
        adding
        onSave={(draft) => guarded(() => addMailbox(vaultStore, draft))}
      />
    </div>
  );
}
