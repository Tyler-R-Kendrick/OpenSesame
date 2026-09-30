import { activeCapabilityVaultId } from "@opensesame/app-core/lib/capability-connector-scope.js";
import {
  addResetEmail,
  listResetEmails,
  removeResetEmail,
  resetEmailEpoch,
  subscribeResetEmails,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { subscribeProjects } from "@opensesame/app-core/lib/projects.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useState, useSyncExternalStore } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus, IconTrash } from "../../components/Icons.js";

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

/** Addresses this vault may attach to a login. Empty is a valid list. */
export function PasswordResetMailPanel() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const emails = listResetEmails();
  const [draft, setDraft] = useState("");
  const [rejected, setRejected] = useState(false);
  return (
    <div className="editor__grid">
      {emails.map((email) => (
        <div className="field-inline" key={email.id}>
          <span>{email.address}</span>
          <IconKey
            small
            label={`Remove ${email.address}`}
            onClick={() => removeResetEmail(email.id)}
          >
            <IconTrash size={16} />
          </IconKey>
        </div>
      ))}
      <div className="field-inline">
        <input
          type="email"
          autoComplete="off"
          aria-label="Reset email"
          aria-invalid={rejected}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setRejected(false);
          }}
        />
        <IconKey
          label="Add reset email"
          onClick={() => {
            const added = addResetEmail(draft);
            if (!added) {
              setRejected(true);
              return;
            }
            setDraft("");
            setRejected(false);
          }}
        >
          <IconPlus size={16} />
        </IconKey>
      </div>
    </div>
  );
}
