import type {
  getObservationReceiverStatus,
  parseObservationReceiverProvision,
} from "@opensesame/app-core/lib/credential-observation/index.js";
import { useEffect, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { assertSecurityOwner, pinSecurityOwner } from "./security-owner.js";
export const receiverUiPorts = {
  load: () =>
    import("@opensesame/app-core/lib/credential-observation/index.js"),
  requireOwner: assertSecurityOwner,
};
type Status = Awaited<ReturnType<typeof getObservationReceiverStatus>>;
type Provision = ReturnType<typeof parseObservationReceiverProvision>;
function useReceiverCeremony({
  tomb,
  supported,
}: { tomb: string; supported: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [provision, setProvision] = useState<Provision | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  useEffect(() => {
    let alive = true;
    let check: () => void;
    try {
      check = pinSecurityOwner(tomb, receiverUiPorts.requireOwner);
    } catch {
      return;
    }
    void receiverUiPorts
      .load()
      .then((api) => {
        check();
        return api.getObservationReceiverStatus(tomb);
      })
      .then((value) => {
        if (alive) {
          check();
          setStatus(value);
        }
      })
      .catch(() => {
        if (alive) setSaid("Receiver records are unavailable.");
      });
    return () => {
      alive = false;
    };
  }, [tomb]);
  const run = async (
    action: (
      api: Awaited<ReturnType<typeof receiverUiPorts.load>>,
    ) => Promise<void>,
  ) => {
    setBusy(true);
    setSaid("");
    try {
      const check = pinSecurityOwner(tomb, receiverUiPorts.requireOwner);
      const api = await receiverUiPorts.load();
      check();
      await action(api);
      check();
      const next = await api.getObservationReceiverStatus(tomb);
      check();
      setStatus(next);
    } catch (error) {
      setSaid(
        error instanceof Error
          ? error.message
          : "The receiver change could not be saved.",
      );
    } finally {
      setPassword("");
      setBusy(false);
    }
  };
  const proof = { tomb, currentPassword: password };
  const blocked = busy || !supported || !password || !status?.durable;
  const importPairing = async (file: File | undefined) => {
    setProvision(null);
    setSaid("");
    if (!file) return;
    try {
      if (file.size > 8192) throw new Error("Pairing file exceeds 8 KiB.");
      const check = pinSecurityOwner(tomb, receiverUiPorts.requireOwner);
      const api = await receiverUiPorts.load();
      check();
      const text = await file.text();
      check();
      const parsed = api.parseObservationReceiverProvision(text);
      check();
      setProvision(parsed);
    } catch {
      setSaid("The pairing file is invalid or the owner session changed.");
    }
  };
  return {
    tomb,
    supported,
    status,
    password,
    setPassword,
    provision,
    setProvision,
    busy,
    said,
    blocked,
    run,
    proof,
    importPairing,
    setSaid,
  };
}
type Model = ReturnType<typeof useReceiverCeremony>;
function ReceiverEnrollment({ model }: { model: Model }) {
  const {
    supported,
    blocked,
    busy,
    run,
    proof,
    provision,
    setProvision,
    password,
    setPassword,
    importPairing,
  } = model;
  return (
    <CeremonyShell
      name="Observation receiver"
      facts={receiverEnrollmentFacts(model)}
      primary={{
        label: "Confirm receiver destination",
        disabled: blocked || !provision,
        busy,
        onClick: () =>
          void run(async (api) => {
            if (!provision) return;
            await api.configureObservationReceiver({
              ...proof,
              provision,
              enabled: false,
            });
            setProvision(null);
          }),
      }}
    >
      <FieldShell
        label="Current vault password"
        type="password"
        autoComplete="off"
        value={password}
        onValueChange={setPassword}
        disabled={busy || !supported}
      />
      <label>
        Receiver pairing file
        <input
          aria-label="Receiver pairing file"
          type="file"
          accept="application/json"
          disabled={busy || !supported}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void importPairing(file);
          }}
        />
      </label>
    </CeremonyShell>
  );
}
function ReceiverEvidence({ model }: { model: Model }) {
  const { status, blocked, busy, run, proof, setSaid } = model;
  return (
    <>
      <CeremonyShell
        name="Test sealed delivery"
        facts={DELIVERY_FACTS}
        primary={{
          label: "Test observation receiver",
          disabled: blocked || !status?.configured,
          busy,
          onClick: () =>
            void run(async (api) => {
              const result = await api.testObservationReceiver(proof);
              setSaid(
                result.delivered
                  ? "Receiver acknowledged sealed delivery."
                  : "No authenticated delivery acknowledgement.",
              );
            }),
        }}
      />
      <CeremonyShell
        name={status?.enabled ? "Disable receiver" : "Enable receiver"}
        facts={[
          {
            key: "Withdrawal",
            value: "disabling or removal does not discard local observations",
          },
        ]}
        primary={{
          label: status?.enabled
            ? "Disable observation receiver"
            : "Enable observation receiver",
          disabled:
            blocked ||
            !status?.configured ||
            (!status?.enabled && !status?.verified),
          busy,
          onClick: () =>
            void run((api) =>
              api.setObservationReceiverEnabled({
                ...proof,
                enabled: !status?.enabled,
              }),
            ),
        }}
      />
      <CeremonyShell
        name="Remove receiver"
        facts={[
          {
            key: "Removal",
            value: "revokes unsent packages; local observations remain",
          },
        ]}
        primary={{
          label: "Remove observation receiver",
          tone: "danger",
          disabled: blocked || !status?.configured,
          busy,
          onClick: () =>
            void run((api) => api.removeObservationReceiver(proof)),
        }}
      />
    </>
  );
}
export default function ReceiverCeremony(props: {
  tomb: string;
  supported: boolean;
}) {
  const model = useReceiverCeremony(props);
  return (
    <>
      <output aria-live="polite">{model.said}</output>
      <ReceiverEnrollment model={model} />
      <ReceiverEvidence model={model} />
    </>
  );
}

const DELIVERY_FACTS = [
  {
    key: "Test",
    value:
      "sends only a sealed test package to the confirmed fixed receiver route",
  },
  {
    key: "Offline",
    value:
      "queued is not delivered; authentication acknowledgement is required",
  },
];

function receiverEnrollmentFacts(model: Model) {
  const { provision, status, supported } = model;
  return [
    {
      key: "Default",
      value: "local evidence only; no receiver is provisioned",
    },
    {
      key: "Destination",
      value: provision?.origin ?? status?.origin ?? "None",
    },
    { key: "Delivery", value: status?.enabled ? "Enabled" : "Disabled" },
    {
      key: "Verified",
      value: status?.verified
        ? "Authenticated acknowledgement received"
        : "Not tested",
    },
    {
      key: "Queue",
      value: `${status?.queued ?? 0} queued · ${status?.failed ?? 0} failed`,
    },
    {
      key: "Protection",
      value: "independent pairing key stored under device at-rest protection",
    },
    ...(!supported
      ? [
          {
            key: "Management",
            value:
              "requires one verified password protector and no additional factors",
          },
        ]
      : []),
  ];
}
