/**
 * Binding rows and pending approvals under one Access connector row.
 */

import type { ConnectorSetting } from "@opensesame/app-core/lib/connector-settings.js";
import {
  type PendingShare,
  policyLabel,
} from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import type { LocalShare } from "@opensesame/app-core/lib/local-share-grants.js";
import { useEffect, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconCheck, IconTrash, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { formatTime } from "./format.js";
import type { ConnectorIdentity } from "./useConnectorAccess.js";

function BindingRow({
  share,
  name,
  providerWide,
  busy,
  disabled,
  onRevoke,
}: {
  share: LocalShare;
  name: string;
  /** Granted on the provider, so it covers every connection of it. */
  providerWide: boolean;
  busy: boolean;
  disabled: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="access-binding">
      <strong>{name}</strong>
      <span className="access-binding__policy">
        {policyLabel("connection", share.policy)}
      </span>
      {providerWide ? (
        <span
          className="chip"
          title={`Every ${share.resourceLabel} connection`}
        >
          all {share.resourceLabel}
        </span>
      ) : null}
      <span className="access-binding__until">
        until {formatTime(new Date(share.expiresAt).toISOString())}
      </span>
      {disabled ? <StatusMark tone="warn" label="Connector off" /> : null}
      <BindingRevokeKey busy={busy} onRevoke={onRevoke} />
    </li>
  );
}

function BindingRevokeKey({
  busy,
  onRevoke,
}: {
  busy: boolean;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!busy) setConfirming(false);
  }, [busy]);
  const revokeLabel = confirming ? "Confirm revoke" : "Revoke";
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      disabled={busy}
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
  );
}

/** Agent grants on this connector that are not active yet. */
export function PendingBindings({
  displayName,
  pending,
  identities,
  busy,
  onApprove,
  onDeny,
}: {
  displayName: string;
  pending: readonly PendingShare[];
  identities: readonly ConnectorIdentity[];
  busy: boolean;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  if (pending.length === 0) return null;
  const names = new Map(identities.map((entry) => [entry.id, entry.name]));
  return (
    <ul
      className="access-bindings"
      aria-label={`Awaiting approval for ${displayName}`}
    >
      {pending.map((row) => {
        const name = names.get(row.principalId) ?? row.principalId;
        return (
          <li key={row.id} className="access-binding">
            <strong>{name}</strong>
            <span className="access-binding__policy">
              {policyLabel("connection", row.policy)}
            </span>
            <StatusMark tone="warn" label="Awaiting approval" />
            <IconKey
              label={`Approve ${name}`}
              small
              disabled={busy}
              onClick={() => onApprove(row.id)}
            >
              <IconCheck size={16} />
            </IconKey>
            <IconKey
              label={`Deny ${name}`}
              small
              disabled={busy}
              onClick={() => onDeny(row.id)}
            >
              <IconX size={16} />
            </IconKey>
          </li>
        );
      })}
    </ul>
  );
}

/** The row's bindings, flagged where their connector is off. */
export function RowBindings({
  rowId,
  displayName,
  setting,
  bindings,
  identities,
  busy,
  onRevoke,
}: {
  rowId: string;
  displayName: string;
  setting: ConnectorSetting;
  bindings: readonly LocalShare[];
  identities: readonly ConnectorIdentity[];
  busy: boolean;
  onRevoke: (share: LocalShare) => void;
}) {
  if (bindings.length === 0) return null;
  const names = new Map(identities.map((entry) => [entry.id, entry.name]));
  return (
    <ul className="access-bindings" aria-label={`Bound to ${displayName}`}>
      {bindings.map((share) => (
        <BindingRow
          key={share.id}
          share={share}
          name={names.get(share.principalId) ?? share.principalId}
          providerWide={share.resourceId !== rowId}
          busy={busy}
          disabled={!setting.enabled}
          onRevoke={() => onRevoke(share)}
        />
      ))}
    </ul>
  );
}
