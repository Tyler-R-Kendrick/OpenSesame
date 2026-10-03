import { activeCapabilityVaultId } from "@opensesame/app-core/lib/capability-connector-scope.js";
import {
  listResetEmails,
  resetEmailEpoch,
  subscribeResetEmails,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { subscribeProjects } from "@opensesame/app-core/lib/projects.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useSyncExternalStore } from "react";
import { useComposition } from "../../bindings/capabilities.js";

function subscribe(listener: () => void): () => void {
  const stopMail = subscribeResetEmails(listener);
  const stopVault = vaultStore.subscribe(listener);
  const stopProjects = subscribeProjects(listener);
  return () => {
    stopMail();
    stopVault();
    stopProjects();
  };
}

function snapshot(): string {
  return `${activeCapabilityVaultId()}\n${resetEmailEpoch()}`;
}

/** The login's mailbox, when password reset is on and a mailbox exists. */
export function ResetEmailField({
  emailId,
  onChange,
}: {
  emailId: string | undefined;
  onChange: (emailId: string | undefined) => void;
}) {
  const { plan } = useComposition();
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const approved =
    plan?.approvedCapabilities.includes("ai.password-reset") === true;
  const emails = listResetEmails();
  if (!approved || (emails.length === 0 && !emailId)) return null;
  const selected = emails.some((email) => email.id === emailId) ? emailId : "";
  return (
    <div className="field">
      <label htmlFor="reset-email">Reset email</label>
      <select
        id="reset-email"
        value={selected}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">None</option>
        {emails.map((email) => (
          <option key={email.id} value={email.id}>
            {email.address}
          </option>
        ))}
      </select>
    </div>
  );
}
