import {
  type PendingShare,
  policyLabel,
} from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import type { LocalShare } from "@opensesame/app-core/lib/local-share-grants.js";
import { useEffect, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconTrash, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function PendingShareRow({
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
    <li className="identity-row" id={`pending-${pending.id}`}>
      <div className="identity-row__main">
        <div className="identity-row__id">
          <h3>
            {name} → {pending.resourceLabel}
          </h3>
          <code className="identity-ref">
            {pending.resourceKind} ·{" "}
            {policyLabel(pending.resourceKind, pending.policy)}
            {role ? ` · ${role}` : ""}
          </code>
        </div>
        <StatusMark tone="warn" label="Awaiting approval" />
        <div className="actions">
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
        </div>
      </div>
    </li>
  );
}

export function ActiveShareRow({
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
  }, [busy, share.id]);
  const revokeLabel = confirming ? "Confirm revoke" : "Revoke";
  return (
    <li className="identity-row" id={`share-${share.id}`}>
      <div className="identity-row__main">
        <div className="identity-row__id">
          <h3>
            {name} → {share.resourceLabel}
          </h3>
          <code className="identity-ref">
            {share.resourceKind} · {policyLabel(share.resourceKind, share.policy)}
            {role ? ` · ${role}` : ""}
          </code>
        </div>
        <StatusMark
          tone="idle"
          label={`Until ${new Date(share.expiresAt).toLocaleString()}`}
        />
        <div className="actions">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={busy || !canRevoke}
            aria-label={revokeLabel}
            title={revokeLabel}
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              onRevoke();
            }}
          >
            <IconTrash size={16} />
          </button>
        </div>
      </div>
    </li>
  );
}
