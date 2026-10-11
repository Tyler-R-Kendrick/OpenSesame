import {
  type ResetMailbox,
  resetMailboxes,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useMemo, useSyncExternalStore } from "react";
import { useComposition } from "../../bindings/capabilities.js";

function items() {
  return vaultStore.getSnapshot().items;
}

function optionLabel(mailbox: ResetMailbox): string {
  return mailbox.name === mailbox.address
    ? mailbox.address
    : `${mailbox.name} (${mailbox.address})`;
}

/**
 * The login's mailbox: one of the vault's email accounts, when password reset
 * is on and the vault has one. Zero, one or many; the choice is the item's id,
 * so renaming a mailbox or changing its server leaves the login bound.
 */
export function ResetEmailField({
  emailId,
  onChange,
}: {
  emailId: string | undefined;
  onChange: (emailId: string | undefined) => void;
}) {
  const { plan } = useComposition();
  const all = useSyncExternalStore(vaultStore.subscribe, items, items);
  const mailboxes = useMemo(() => resetMailboxes(all), [all]);
  const approved =
    plan?.approvedCapabilities.includes("ai.password-reset") === true;
  if (!approved || (mailboxes.length === 0 && !emailId)) return null;
  const selected = mailboxes.some((mailbox) => mailbox.id === emailId)
    ? emailId
    : "";
  return (
    <div className="field">
      <label htmlFor="reset-email">Reset email</label>
      <select
        id="reset-email"
        value={selected}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">None</option>
        {mailboxes.map((mailbox) => (
          <option key={mailbox.id} value={mailbox.id}>
            {optionLabel(mailbox)}
          </option>
        ))}
      </select>
    </div>
  );
}
