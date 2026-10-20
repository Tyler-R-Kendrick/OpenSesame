/**
 * The trusted-contact quorum after the primary key (and any second step).
 * Each member authenticates with their own passkey; the vault store opens only
 * after enough distinct members have done so.
 */

import type { TrustedUnlockView } from "@opensesame/app-core/lib/trusted-unlock.js";
import { useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPasskey, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVaultStore } from "../../lib/vault/hooks.js";

export function TrustedUnlockGate({
  challenge,
  onCancel,
}: {
  challenge: TrustedUnlockView;
  onCancel: () => void;
}) {
  const store = useVaultStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approved = new Set(challenge.approved);

  async function approve(principalId: string): Promise<void> {
    if (busy !== null || approved.has(principalId)) return;
    setBusy(principalId);
    setError(null);
    try {
      await store.confirmTrustedContact(principalId);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The contact could not approve this unlock.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="unlock__trusted">
      <div className="unlock__heading">
        <h1 className="unlock__title">Trusted contacts</h1>
      </div>
      <p className="unlock__trusted-line">
        {approved.size} of {challenge.threshold} approvals. The circle is{" "}
        {challenge.name}.
      </p>
      <ul className="unlock__trusted-list" aria-label="Trusted contacts">
        {challenge.members.map((member) => {
          const done = approved.has(member.id);
          return (
            <li key={member.id} className="unlock__trusted-person">
              <span>{member.name}</span>
              {done ? (
                <StatusMark tone="ok" label={`${member.name} approved`} />
              ) : (
                <IconKey
                  small
                  label={`Approve as ${member.name}`}
                  disabled={busy !== null}
                  onClick={() => void approve(member.id)}
                >
                  <IconPasskey size={16} />
                </IconKey>
              )}
              {busy === member.id ? (
                <StatusMark tone="idle" label="Waiting for the passkey" />
              ) : null}
            </li>
          );
        })}
      </ul>
      <FailureNotice
        id="unlock:trusted-contacts"
        title="Trusted contacts"
        message={error}
      />
      <div className="actions">
        <button type="button" className="go-row" onClick={onCancel}>
          <IconX size={16} />
          <span className="go-verb">Cancel</span>
        </button>
      </div>
    </div>
  );
}
