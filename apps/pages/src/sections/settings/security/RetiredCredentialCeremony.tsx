import {
  MAX_RETIRED_CREDENTIAL_TRAPS,
  type RetiredCredentialResponse,
  type retiredCredentialStatus,
} from "@opensesame/app-core/lib/retired-credentials/index.js";
import { useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconCheck, IconTrash } from "../../../components/Icons.js";
import { CeremonyRow } from "../CeremonyRow.js";
import { RetiredCredentialEnrollment } from "./RetiredCredentialEnrollment.js";
import { retiredCredentialUiPorts } from "./retired-credential-ports.js";
import type { Run } from "./run.js";
import "./duress-sheet.css";

type Status = ReturnType<typeof retiredCredentialStatus>;

function RetiredTrapRows({
  traps,
  blocked,
  onRemove,
}: {
  traps: Status["traps"];
  blocked: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <>
      {traps.map((trap, index) => (
        <CeremonyRow
          key={trap.id}
          icon={<IconCheck size={16} />}
          label={`Retired password ${index + 1}`}
          sub={`${new Date(trap.createdAt).toLocaleString()} · ${trap.response === "reject" ? "Record and reject" : "Synthetic decoy"}`}
          action={
            <IconKey
              label={`Remove retired password ${index + 1}`}
              small
              disabled={blocked}
              onClick={() => onRemove(trap.id)}
            >
              <IconTrash size={16} />
            </IconKey>
          }
        />
      ))}
    </>
  );
}

function observationLabel(event: Status["events"][number]): string {
  if (event.type === "synthetic_decoy_interaction")
    return event.action === "vault_write"
      ? "Synthetic decoy changed"
      : "External authority denied";
  return `Retired password observed · ${event.response === "reject" ? "Rejected" : "Synthetic decoy"}`;
}

function RetiredObservations({
  events,
  busy,
  blocked,
  onClear,
}: {
  events: Status["events"];
  busy: boolean;
  blocked: boolean;
  onClear: () => void;
}) {
  return (
    <CeremonyShell
      name="Observed use"
      facts={[
        { key: "Observations", value: String(events.length) },
        {
          key: "Meaning",
          value: "a formerly valid password was entered; intent is unknown",
        },
        {
          key: "Owner access",
          value:
            "lock the decoy, then authenticate with current real credentials",
        },
        {
          key: "Response",
          value: "never freezes, wipes, or resets the real vault",
        },
      ]}
      primary={{
        label: "Clear local observations",
        disabled: blocked || events.length === 0,
        busy,
        onClick: onClear,
      }}
    >
      {events.length > 0 ? (
        <ul>
          {events.map((event, index) => (
            <li key={`${event.at}-${index}`}>
              {new Date(event.at).toLocaleString()} · {observationLabel(event)}
            </li>
          ))}
        </ul>
      ) : null}
    </CeremonyShell>
  );
}

function useRetiredEnrollment(
  blocked: boolean,
  full: boolean,
  durable: boolean,
) {
  const [current, setCurrent] = useState("");
  const [retired, setRetired] = useState("");
  const [response, setResponse] = useState<RetiredCredentialResponse>("reject");
  const [acknowledged, setAcknowledged] = useState(false);
  const ready =
    !!current && !!retired && acknowledged && !full && durable && !blocked;
  return {
    current,
    retired,
    response,
    acknowledged,
    full,
    blocked,
    ready,
    setCurrent,
    setRetired,
    setResponse,
    setAcknowledged,
  };
}

/** Fresh authentication belongs to every write, including evidence dismissal. */
export function RetiredCredentialCeremony({
  tomb,
  supported,
  status,
  busy,
  run,
  refresh,
}: {
  tomb: string;
  supported: boolean;
  status: Status;
  busy: boolean;
  run: Run;
  refresh: () => Promise<boolean>;
}) {
  const blocked = busy || !supported;
  const full = status.traps.length >= MAX_RETIRED_CREDENTIAL_TRAPS;
  const form = useRetiredEnrollment(blocked, full, status.durable);
  const { current, retired, response } = form;
  const write = (action: () => Promise<void>, message: string) =>
    void run(async () => {
      try {
        await action();
        await refresh();
      } finally {
        form.setCurrent("");
        form.setRetired("");
      }
    }, message);
  return (
    <>
      <RetiredCredentialEnrollment
        form={form}
        count={status.traps.length}
        supported={supported}
        busy={busy}
        onEnroll={() =>
          write(
            () =>
              retiredCredentialUiPorts.enrollRetiredCredential({
                tomb,
                currentPassword: current,
                retiredPassword: retired,
                response,
                acknowledgePasswordVerifierRisk: true,
              }),
            "Retired password enrolled.",
          )
        }
      />
      <RetiredTrapRows
        traps={status.traps}
        blocked={blocked || !current}
        onRemove={(id) =>
          write(
            () =>
              retiredCredentialUiPorts.removeRetiredCredential({
                tomb,
                currentPassword: current,
                id,
              }),
            "Retired password removed.",
          )
        }
      />
      <RetiredObservations
        events={status.events}
        busy={busy}
        blocked={blocked || !current}
        onClear={() =>
          write(
            () =>
              retiredCredentialUiPorts.clearRetiredCredentialEvents({
                tomb,
                currentPassword: current,
              }),
            "Local observations cleared.",
          )
        }
      />
    </>
  );
}
