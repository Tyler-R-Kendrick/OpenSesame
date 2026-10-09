import type { LocalAccessRequest } from "@opensesame/app-core/lib/local-access-requests.js";
import type { PendingShare } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import type { RefObject } from "react";
import { AccessDetail } from "./AccessRecords.js";
import { LocalRequestForm } from "./LocalRequestForm.js";
import { PendingGrantDecision } from "./local-pending-grant-inbox.js";
import { LocalRequestDecision } from "./local-request-decision.js";
import type { useLocalRequests } from "./useLocalRequests.js";

export function LocalRequestsPanelBody({
  root,
  tomb,
  model,
  disabled,
  creating,
  selected,
  selectedGrant,
  close,
}: {
  root: RefObject<HTMLDivElement | null>;
  tomb: string;
  model: ReturnType<typeof useLocalRequests>;
  disabled: boolean;
  creating: boolean;
  selected: LocalAccessRequest | null;
  selectedGrant: PendingShare | null;
  close: () => void;
}) {
  return (
    <div ref={root}>
      {creating && model.data ? (
        <AccessDetail title="New local request" kind="Request">
          <LocalRequestForm
            tomb={tomb}
            directory={model.data.directory}
            applications={model.data.applications}
            busy={disabled}
            run={model.run}
            close={close}
          />
        </AccessDetail>
      ) : null}
      {!creating && selectedGrant && model.data ? (
        <PendingGrantDecision
          key={selectedGrant.id}
          tomb={tomb}
          pending={selectedGrant}
          directory={model.data.directory}
          busy={disabled}
          run={model.run}
          close={close}
        />
      ) : null}
      {!creating && selected && model.data ? (
        <LocalRequestDecision
          key={selected.id}
          tomb={tomb}
          row={selected}
          directory={model.data.directory}
          busy={disabled}
          run={model.run}
          close={close}
        />
      ) : null}
      {!model.data && !model.error ? (
        <output>Loading local requests…</output>
      ) : null}
    </div>
  );
}
