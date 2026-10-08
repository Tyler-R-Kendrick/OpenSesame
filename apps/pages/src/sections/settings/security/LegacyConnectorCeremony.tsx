import type { legacyDeviceConnectorStatus } from "@opensesame/app-core/lib/device-connector-legacy.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { useEffect, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { retiredCredentialUiPorts } from "./retired-credential-ports.js";
import { assertSecurityOwner, pinSecurityOwner } from "./security-owner.js";
export const legacyConnectorUiPorts = {
  load: () => import("@opensesame/app-core/lib/device-connector-legacy.js"),
  requireOwner: assertSecurityOwner,
};
type Status = ReturnType<typeof legacyDeviceConnectorStatus>;
function legacyFailure(body: string) {
  setStatusNotice({
    id: "legacy-connectors",
    tone: "err",
    title: "Legacy connector records",
    body,
  });
}

function legacyResolutionMessage(
  corrupt: boolean,
  decision: "import" | "discard",
) {
  if (corrupt) return "Unreadable legacy secret records discarded.";
  return decision === "import"
    ? "Selected records sealed into this vault."
    : "Selected legacy records discarded.";
}
function useLegacyConnectorCeremony({
  tomb,
  onResolved,
}: { tomb: string; onResolved: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [decision, setDecision] = useState<"import" | "discard">("import");
  const [acknowledged, setAcknowledged] = useState(false);
  const [corruptAcknowledged, setCorruptAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  useEffect(() => {
    let alive = true;
    let check: () => void;
    try {
      check = pinSecurityOwner(tomb, legacyConnectorUiPorts.requireOwner);
    } catch {
      return;
    }
    void legacyConnectorUiPorts
      .load()
      .then(async (api) => {
        check();
        const next = await api.refreshLegacyDeviceConnectorStatus(tomb);
        check();
        if (alive) setStatus(next);
      })
      .catch(() => {
        if (alive)
          legacyFailure(
            "Legacy records are unavailable. Restore trusted browser data to recover.",
          );
      });
    return () => {
      alive = false;
    };
  }, [tomb]);
  async function resolve(corrupt = false) {
    dismissNotice("legacy-connectors");
    setBusy(true);
    setSaid("");
    try {
      const check = pinSecurityOwner(tomb, legacyConnectorUiPorts.requireOwner);
      const api = await legacyConnectorUiPorts.load();
      check();
      if (corrupt)
        await api.discardIrrecoverableLegacyConnectorSecrets({
          tomb,
          currentPassword: password,
          acknowledgeIrrecoverableLegacyDiscard: true,
        });
      else
        await api.resolveLegacyDeviceConnectors({
          tomb,
          currentPassword: password,
          connectionIds: selected,
          decision,
          acknowledgeOwnershipAmbiguity: true,
        });
      check();
      const next = await api.refreshLegacyDeviceConnectorStatus(tomb);
      check();
      setStatus(next);
      setSelected([]);
      setAcknowledged(false);
      setCorruptAcknowledged(false);
      setSaid(legacyResolutionMessage(corrupt, decision));
      if (!next.pending) onResolved();
    } catch (error) {
      legacyFailure(
        error instanceof Error
          ? error.message
          : "Legacy records could not be resolved.",
      );
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return {
    supported:
      retiredCredentialUiPorts.retiredCredentialEnrollmentSupported(tomb),
    status,
    selected,
    password,
    decision,
    acknowledged,
    busy,
    said,
    setSelected,
    setPassword,
    setDecision,
    setAcknowledged,
    corruptAcknowledged,
    setCorruptAcknowledged,
    resolve,
  };
}
type Model = ReturnType<typeof useLegacyConnectorCeremony>;
function LegacySelections({ model }: { model: Model }) {
  const {
    status,
    selected,
    password,
    decision,
    acknowledged,
    busy,
    setSelected,
    setPassword,
    setDecision,
    setAcknowledged,
  } = model;
  return (
    <>
      {status?.records.map((record) => (
        <label key={record.connectionId} className="check-line">
          <input
            type="checkbox"
            disabled={
              busy ||
              (selected.length >= 16 && !selected.includes(record.connectionId))
            }
            checked={selected.includes(record.connectionId)}
            onChange={(event) =>
              setSelected((ids) =>
                event.target.checked
                  ? [...ids, record.connectionId]
                  : ids.filter((id) => id !== record.connectionId),
              )
            }
          />
          {record.displayName} · {record.providerId} · {record.connectionId}
        </label>
      ))}
      <div className="field">
        <label htmlFor="legacy-connector-decision">
          Selected record action
        </label>
        <select
          id="legacy-connector-decision"
          disabled={busy}
          value={decision}
          onChange={(event) =>
            setDecision(event.target.value === "discard" ? "discard" : "import")
          }
        >
          <option value="import">Import into this vault</option>
          <option value="discard">Discard selected records</option>
        </select>
      </div>
      <FieldShell
        label="Current vault password"
        id="legacy-connector-password"
        type="password"
        autoComplete="off"
        value={password}
        disabled={busy}
        onValueChange={setPassword}
      />
      <label className="check-line">
        <input
          type="checkbox"
          disabled={busy}
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I understand original ownership cannot be proven and confirm the
        selected import or permanent discard.
      </label>
    </>
  );
}
function IrrecoverableLegacy({ model }: { model: Model }) {
  const {
    status,
    password,
    corruptAcknowledged,
    setCorruptAcknowledged,
    busy,
    resolve,
  } = model;
  if (!model.supported || !status?.pending || status.available) return null;
  return (
    <CeremonyShell
      name="Unreadable legacy secret records"
      facts={[
        {
          key: "Loss",
          value: "permanently discard the entire unreadable legacy secret map",
        },
        {
          key: "Preserved",
          value: "all current vault-owned records and public legacy metadata",
        },
      ]}
      primary={{
        label: "Discard unreadable legacy secret records",
        tone: "danger",
        disabled: busy || !password || !corruptAcknowledged,
        busy,
        onClick: () => void resolve(true),
      }}
    >
      <label className="check-line">
        <input
          type="checkbox"
          disabled={busy}
          checked={corruptAcknowledged}
          onChange={(event) => setCorruptAcknowledged(event.target.checked)}
        />
        I explicitly confirm permanent loss of all unreadable legacy secret
        records.
      </label>
    </CeremonyShell>
  );
}
export default function LegacyConnectorCeremony(props: {
  tomb: string;
  onResolved: () => void;
}) {
  const model = useLegacyConnectorCeremony(props);
  const {
    status,
    selected,
    password,
    decision,
    acknowledged,
    busy,
    said,
    resolve,
  } = model;
  return (
    <>
      <output aria-live="polite">{said}</output>
      <CeremonyShell
        name="Resolve selected records"
        facts={[
          {
            key: "Old protection",
            value:
              "device-key protected; their original vault ownership cannot be proven",
          },
          {
            key: "Import",
            value: "seal only selected records under this current vault's root",
          },
          {
            key: "Discard",
            value: "permanently remove only selected legacy records",
          },
          {
            key: "Owner proof",
            value:
              "requires one verified current password protector and no additional factors",
          },
          ...(!status?.available && status?.pending
            ? [
                {
                  key: "Recovery",
                  value:
                    "legacy data cannot be read; restore trusted browser data before retrying",
                },
              ]
            : []),
        ]}
        primary={{
          label:
            decision === "import"
              ? "Import selected legacy records"
              : "Discard selected legacy records",
          tone: decision === "discard" ? "danger" : undefined,
          disabled:
            busy ||
            !status?.available ||
            !selected.length ||
            selected.length > 16 ||
            !password ||
            !acknowledged,
          busy,
          onClick: () => void resolve(),
        }}
      >
        <LegacySelections model={model} />
      </CeremonyShell>
      <IrrecoverableLegacy model={model} />
    </>
  );
}
