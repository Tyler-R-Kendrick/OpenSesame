import type { PendingShare } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import { policyLabel } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import type { LocalShare } from "@opensesame/app-core/lib/local-share-grants.js";
import { useEffect, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconTrash, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { AccessDetail, AccessFact } from "./AccessRecords.js";

export function PendingRow({
  pending,
  name,
  role,
  busy,
  canDecide,
  onApprove,
  onDeny,
}: {
  pending: PendingShare;
  name: string;
  role: string | undefined;
  busy: boolean;
  canDecide: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <AccessDetail
      title={`${name} → ${pending.resourceLabel}`}
      kind="Pending share"
      actions={
        <>
          <StatusMark tone="warn" label="Awaiting approval" />
          <IconKey
            label={`Approve ${name}`}
            small
            disabled={busy || !canDecide}
            onClick={onApprove}
          >
            <IconCheck size={16} />
          </IconKey>
          <IconKey
            label={`Deny ${name}`}
            small
            disabled={busy || !canDecide}
            onClick={onDeny}
          >
            <IconX size={16} />
          </IconKey>
        </>
      }
    >
      <AccessFact label="Resource" value={pending.resourceKind} />
      <AccessFact
        label="Policy"
        value={policyLabel(pending.resourceKind, pending.policy)}
      />
      <AccessFact label="Role" value={role ?? "—"} />
      <AccessFact label="Reference" value={pending.id} />
    </AccessDetail>
  );
}

export function ShareRow({
  share,
  name,
  role,
  busy,
  canRevoke,
  onRevoke,
}: {
  share: LocalShare;
  name: string;
  role: string | undefined;
  busy: boolean;
  canRevoke: boolean;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!busy) setConfirming(false);
  }, [busy]);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const revokeLabel = confirming ? "Confirm revoke" : "Revoke";
  return (
    <AccessDetail
      title={`${name} → ${share.resourceLabel}`}
      kind="Share"
      actions={
        <>
          <StatusMark
            tone="idle"
            label={`Until ${new Date(share.expiresAt).toLocaleString()}`}
          />
          <IconKey
            label={revokeLabel}
            small
            armed={confirming}
            disabled={busy || !canRevoke}
            onBlur={() => setConfirming(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setConfirming(false);
            }}
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              setConfirming(false);
              onRevoke();
            }}
          >
            <IconTrash size={16} />
          </IconKey>
        </>
      }
    >
      <AccessFact label="Resource" value={share.resourceKind} />
      <AccessFact
        label="Policy"
        value={policyLabel(share.resourceKind, share.policy)}
      />
      <AccessFact label="Role" value={role ?? "—"} />
      <AccessFact
        label="Expires"
        value={new Date(share.expiresAt).toLocaleString()}
      />
      <AccessFact label="Reference" value={share.id} />
    </AccessDetail>
  );
}
