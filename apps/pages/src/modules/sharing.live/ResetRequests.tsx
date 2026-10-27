import { allowDeviceReset } from "@opensesame/app-core/lib/live/device-reset-allow.js";
import type {
  PendingReset,
  ResetGrant,
} from "@opensesame/app-core/lib/live/device-reset-types.js";
import type { LiveHost } from "@opensesame/app-core/lib/live/host.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconCheck, IconTerminal, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

function Review({
  host,
  pending,
  close,
}: {
  host: LiveHost;
  pending: PendingReset;
  close: () => void;
}) {
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const approve = async () => {
    try {
      const result = await allowDeviceReset(
        host.resets,
        vaultStore.activeTomb?.() ?? "",
        pending.id,
      );
      if (result === "approved") close();
      else
        setFailure({
          message: `Reset capability was not approved (${result}).`,
        });
    } catch {
      setFailure({
        message: "Reset capability approval failed before a grant was made.",
      });
    }
  };
  return (
    <CeremonySheet
      title="Review reset capability"
      mark={<IconTerminal size={20} />}
      onClose={close}
    >
      <CeremonyShell
        name={pending.itemName}
        facts={[
          { key: "Origin", value: pending.origin },
          { key: "Capability", value: pending.actions[0] ?? "" },
          { key: "Runtime", value: pending.runtime },
          { key: "Model", value: pending.model },
          { key: "Expires", value: new Date(pending.expiresAt).toISOString() },
        ]}
        primary={{
          label: "Approve reset capability",
          icon: <IconCheck size={18} />,
          onClick: () => void approve(),
        }}
      >
        <FailureNotice
          id={`reset-approval-${pending.id}`}
          title="Reset capability was not approved"
          message={failure?.message}
          occurrence={failure}
        />
      </CeremonyShell>
    </CeremonySheet>
  );
}

function PendingRow({
  host,
  pending,
}: { host: LiveHost; pending: PendingReset }) {
  const [reviewing, setReviewing] = useState(false);
  return (
    <div className="vault-row">
      <div className="vault-row__body">
        <span className="vault-row__text">
          <span className="vault-row__name">{pending.itemName}</span>
          <span className="vault-row__meta">{pending.actions[0]}</span>
        </span>
        <StatusMark tone="warn" label="Reset approval requested" />
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Review ${pending.actions[0]}`}
        title={`Review ${pending.actions[0]}`}
        onClick={() => setReviewing(true)}
      >
        <IconCheck size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Deny ${pending.actions[0]}`}
        title={`Deny ${pending.actions[0]}`}
        onClick={() => host.resets?.deny(pending.id)}
      >
        <IconX size={16} />
      </button>
      {reviewing ? (
        <Review
          host={host}
          pending={pending}
          close={() => setReviewing(false)}
        />
      ) : null}
    </div>
  );
}

function GrantRow({ host, grant }: { host: LiveHost; grant: ResetGrant }) {
  return (
    <div className="vault-row">
      <div className="vault-row__body">
        <span className="vault-row__text">
          <span className="vault-row__name">{grant.itemName}</span>
          <span className="vault-row__meta">{grant.actions[0]}</span>
        </span>
        <StatusMark
          tone={grant.humanStatus ? "warn" : "ok"}
          label={
            grant.humanStatus === "takeover_requested"
              ? "Human takeover requested"
              : "Reset capability approved"
          }
        />
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Revoke ${grant.actions[0]}`}
        title={`Revoke ${grant.actions[0]}`}
        onClick={() => host.resets?.revoke(grant.id)}
      >
        <IconX size={16} />
      </button>
    </div>
  );
}

export function ResetRequests({ host }: { host: LiveHost }) {
  const { pending, grants } = host.state.resets ?? { pending: [], grants: [] };
  if (!host.resets || (pending.length === 0 && grants.length === 0))
    return null;
  return (
    <div className="setup__stack" aria-label="Password reset approvals">
      {pending.map((one) => (
        <PendingRow key={one.id} host={host} pending={one} />
      ))}
      {grants.map((grant) => (
        <GrantRow key={grant.id} host={host} grant={grant} />
      ))}
    </div>
  );
}
