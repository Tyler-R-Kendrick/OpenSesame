import type { InboxStatusFilter } from "@opensesame/app-core/lib/configuration/inbox-triage.js";
import type { LocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import {
  type PendingShare,
  approvePendingShare,
  denyPendingShare,
  policyLabel,
} from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconArrowRight,
  IconCheck,
  IconChevronLeft,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function PendingGrantRows({
  grants,
  directory,
  filter,
  disabled,
  select,
}: {
  grants: PendingShare[];
  directory: LocalDirectory;
  filter: InboxStatusFilter;
  disabled: boolean;
  select: (row: PendingShare, button: HTMLButtonElement) => void;
}) {
  if (filter !== "all" && filter !== "pending") return null;
  const name = (principalId: string) =>
    directory.entries.find((entry) => entry.id === principalId)?.name ??
    principalId;
  if (!grants.length) return null;
  return (
    <ul className="access-local-records">
      {grants.map((row) => (
        <li key={row.id}>
          <strong>
            {name(row.principalId)} → {row.resourceLabel}
          </strong>
          <p className="hint">
            Identity share · {policyLabel(row.resourceKind, row.policy)}
          </p>
          <StatusMark tone="warn" label="Awaiting approval" />
          <p>
            <code className="access-ref">{row.id}</code>
          </p>
          <IconKey
            label="Review grant request"
            small
            disabled={disabled}
            onClick={(event) => select(row, event.currentTarget)}
          >
            <IconArrowRight size={16} />
          </IconKey>
        </li>
      ))}
    </ul>
  );
}

export function PendingGrantDecision({
  tomb,
  pending,
  directory,
  busy,
  run,
  close,
}: {
  tomb: string;
  pending: PendingShare;
  directory: LocalDirectory;
  busy: boolean;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  close: () => void;
}) {
  const name =
    directory.entries.find((entry) => entry.id === pending.principalId)?.name ??
    pending.principalId;
  return (
    <fieldset className="access-local-confirmation" disabled={busy}>
      <legend>Review identity share grant</legend>
      <p>
        {name} → {pending.resourceLabel}
      </p>
      <p className="hint">
        {pending.resourceKind} ·{" "}
        {policyLabel(pending.resourceKind, pending.policy)}
      </p>
      <p>
        <code className="access-ref">{pending.id}</code>
      </p>
      <div className="actions">
        <IconKey
          label={`Approve ${name}`}
          onClick={() =>
            void run(async () => {
              await approvePendingShare(tomb, pending.id);
            }, "Grant approved.").then((done) => {
              if (done) close();
            })
          }
        >
          <IconCheck size={16} />
        </IconKey>
        <IconKey
          label={`Deny ${name}`}
          onClick={() =>
            void run(async () => {
              await denyPendingShare(tomb, pending.id);
            }, "Grant denied.").then((done) => {
              if (done) close();
            })
          }
        >
          <IconX size={16} />
        </IconKey>
        <IconKey label="Close grant request" onClick={close}>
          <IconChevronLeft size={16} />
        </IconKey>
      </div>
    </fieldset>
  );
}
