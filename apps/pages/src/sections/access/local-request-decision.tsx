import {
  type LocalAccessRequest,
  removeSettledLocalAccessRequest,
  revokeLocalAccessRequest,
} from "@opensesame/app-core/lib/local-access-requests.js";
import type { LocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconTrash, IconX } from "../../components/Icons.js";
import { AccessDetail, AccessFact } from "./AccessRecords.js";
import { RequestApproval } from "./RequestApproval.js";

export function LocalRequestDecision({
  tomb,
  row,
  directory,
  busy,
  run,
  close,
}: {
  tomb: string;
  row: LocalAccessRequest;
  directory: LocalDirectory;
  busy: boolean;
  run: (
    action: () => Promise<LocalAccessRequest> | Promise<void>,
    success: string,
  ) => Promise<boolean>;
  close: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const name = (value: string) =>
    directory.entries.find((entry) => entry.id === value)?.name ?? value;
  const active = row.status === "pending" || row.status === "approved";
  const removeLabel = removing
    ? active
      ? "Confirm withdrawal"
      : "Confirm history removal"
    : active
      ? "Withdraw request"
      : "Remove request history";
  async function remove() {
    if (!removing) {
      setRemoving(true);
      return;
    }
    if (
      await run(
        () =>
          active
            ? revokeLocalAccessRequest(tomb, row)
            : removeSettledLocalAccessRequest(tomb, row),
        active ? "Request withdrawn." : "Request history removed.",
      )
    )
      close();
  }
  return (
    <AccessDetail
      title={name(row.applicationId)}
      kind="Request"
      actions={
        <>
          <IconKey
            label={removeLabel}
            disabled={busy}
            onClick={() => void remove()}
          >
            <IconTrash size={16} />
          </IconKey>
          <IconKey label="Close request" onClick={close}>
            <IconX size={16} />
          </IconKey>
        </>
      }
    >
      <fieldset className="access-record-review" disabled={busy}>
        <legend className="visually-hidden">Review local request</legend>
        <AccessFact label="Requester" value={name(row.requesterId)} />
        <AccessFact label="Organization" value={name(row.organizationId)} />
        <AccessFact label="Reason" value={row.reason} />
        <AccessFact label="Reference" value={row.id} />
        <AccessFact label="Status" value={row.status} />
        <AccessFact label="Scopes" value={row.scopes.join(", ")} />
        <AccessFact label="Callback" value={row.redirectUri} />
        {row.status === "pending" ? (
          <RequestApproval
            tomb={tomb}
            row={row}
            directory={directory}
            run={run}
            close={close}
          />
        ) : null}
      </fieldset>
    </AccessDetail>
  );
}
