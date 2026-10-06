import type {
  ArtifactKind,
  listControlledCanaries,
} from "@opensesame/app-core/lib/credential-canaries/index.js";
import { useEffect, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconTrash } from "../../../components/Icons.js";
import { CeremonyRow } from "../CeremonyRow.js";
import { downloadOnce } from "../download-once.js";
import { RetiredIssuerRows } from "./RetiredIssuerRows.js";
import { assertSecurityOwner, pinSecurityOwner } from "./security-owner.js";

export const canaryUiPorts = {
  load: () => import("@opensesame/app-core/lib/credential-canaries/index.js"),
  download: downloadOnce,
  requireOwner: assertSecurityOwner,
};
type CanaryStatus = Awaited<ReturnType<typeof listControlledCanaries>>;
const kindLabels = {
  connection_ref: "Connection reference",
  mcp_configuration: "MCP configuration",
  token_generation: "Token canary",
  agent_lease: "Agent lease canary",
} satisfies Record<ArtifactKind, string>;
const phaseLabels = {
  connected: "Validator connected",
  invoked: "Synthetic tool invoked",
  retired_generation_observed: "Retired generation observed",
  artifact_dispatched: "Artifact exported",
};
function useCanaryCeremony({
  tomb,
  supported,
}: { tomb: string; supported: boolean }) {
  const [status, setStatus] = useState<CanaryStatus | null>(null);
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState<ArtifactKind>("mcp_configuration");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  useEffect(() => {
    let alive = true;
    let check: () => void;
    try {
      check = pinSecurityOwner(tomb, canaryUiPorts.requireOwner);
    } catch {
      return;
    }
    void canaryUiPorts
      .load()
      .then((api) => {
        check();
        return api.listControlledCanaries(tomb);
      })
      .then((value) => {
        if (alive) {
          check();
          setStatus(value);
        }
      })
      .catch(() => {
        if (alive) setSaid("Canary records are unavailable.");
      });
    return () => {
      alive = false;
    };
  }, [tomb]);
  const run = async (
    action: (
      api: Awaited<ReturnType<typeof canaryUiPorts.load>>,
    ) => Promise<void>,
  ) => {
    setBusy(true);
    setSaid("");
    try {
      const check = pinSecurityOwner(tomb, canaryUiPorts.requireOwner);
      const api = await canaryUiPorts.load();
      check();
      await action(api);
      check();
      const next = await api.listControlledCanaries(tomb);
      check();
      setStatus(next);
    } catch (error) {
      setSaid(
        error instanceof Error
          ? error.message
          : "The canary change could not be saved.",
      );
    } finally {
      setPassword("");
      setBusy(false);
    }
  };
  const blocked = busy || !supported || !password || !status?.durable;
  const create = () =>
    void run(async (api) => {
      await exportCanary(api, tomb, password, kind);
      setSaid(
        "Exported once. Keep the file private and owner-only (chmod 600 FILE on Unix). Install with opensesame-id canary install --config FILE --trust-configuration; detector evidence is local to that CLI environment. Remove that detector separately with opensesame-id canary uninstall --config FILE.",
      );
    });
  return {
    tomb,
    supported,
    status,
    password,
    setPassword,
    kind,
    setKind,
    busy,
    said,
    blocked,
    create,
    run,
  };
}
type Model = ReturnType<typeof useCanaryCeremony>;
function CanaryEnrollment({ model }: { model: Model }) {
  const {
    status,
    supported,
    blocked,
    busy,
    create,
    password,
    setPassword,
    kind,
    setKind,
  } = model;
  return (
    <CeremonyShell
      name="Controlled canaries"
      facts={[
        {
          key: "Authority",
          value:
            "synthetic validator only; no real vault or production connection",
        },
        {
          key: "Evidence",
          value:
            "local observations; reading an exported file is not observable",
        },
        { key: "Retained", value: `${status?.artifacts.length ?? 0} of 16` },
        ...(!supported
          ? [
              {
                key: "Management",
                value:
                  "requires one verified password protector and no additional factors",
              },
            ]
          : []),
      ]}
      primary={{
        label: "Create and export canary",
        disabled: blocked || (status?.artifacts.length ?? 16) >= 16,
        busy,
        onClick: create,
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
        Canary type
        <select
          aria-label="Canary type"
          value={kind}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            if (
              next === "connection_ref" ||
              next === "mcp_configuration" ||
              next === "token_generation" ||
              next === "agent_lease"
            )
              setKind(next);
          }}
        >
          {Object.entries(kindLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </CeremonyShell>
  );
}
function CanaryEvidence({ model }: { model: Model }) {
  const { status, blocked, busy, run, tomb, password } = model;
  return (
    <>
      {status?.artifacts.map((artifact, index) => (
        <CeremonyRow
          icon={<IconTrash size={16} />}
          key={artifact.id}
          label={`${kindLabels[artifact.context.kind]} ${index + 1}`}
          sub={`Generation ${artifact.context.generation} · ${artifact.state === "bait" ? "Controlled bait" : "Retired"}`}
          action={
            <IconKey
              label={`Revoke canary ${index + 1}`}
              small
              disabled={blocked}
              onClick={() =>
                void run((api) =>
                  api.removeControlledCanary({
                    tomb,
                    currentPassword: password,
                    artifactId: artifact.id,
                  }),
                )
              }
            >
              <IconTrash size={16} />
            </IconKey>
          }
        />
      ))}
      <CeremonyShell
        name="Canary observations"
        facts={[
          { key: "Observed", value: String(status?.events.length ?? 0) },
          { key: "Meaning", value: "use was observed; intent remains unknown" },
        ]}
        primary={{
          label: "Clear canary observations",
          disabled: blocked || !status?.events.length,
          busy,
          onClick: () =>
            void run((api) =>
              api.clearControlledCanaryEvents({
                tomb,
                currentPassword: password,
              }),
            ),
        }}
      >
        <ul>
          {status?.events.map((event) => (
            <li key={event.eventId}>
              {new Date(event.at).toLocaleString()} · {phaseLabels[event.phase]}
            </li>
          ))}
        </ul>
      </CeremonyShell>
    </>
  );
}
export default function CanaryCeremony(props: {
  tomb: string;
  supported: boolean;
}) {
  const model = useCanaryCeremony(props);
  return (
    <>
      <output aria-live="polite">{model.said}</output>
      <CanaryEnrollment model={model} />
      <CanaryEvidence model={model} />
      <RetiredIssuerRows
        tomb={model.tomb}
        disabled={model.blocked}
        retire={(issuerRecordRef) =>
          model.run((api) =>
            api
              .retireIssuedIdentifier({
                tomb: model.tomb,
                currentPassword: model.password,
                issuerRecordRef,
              })
              .then(() => {}),
          )
        }
      />
    </>
  );
}

async function exportCanary(
  api: Awaited<ReturnType<typeof canaryUiPorts.load>>,
  tomb: string,
  password: string,
  kind: ArtifactKind,
): Promise<void> {
  const check = pinSecurityOwner(tomb, canaryUiPorts.requireOwner);
  const proof = { tomb, currentPassword: password };
  const artifact = await api.createControlledCanary({ ...proof, kind });
  check();
  const body =
    kind === "mcp_configuration"
      ? await api.exportControlledMcpConfiguration({
          ...proof,
          artifact,
          suppliedValidatorRef: "human_cli_stdio",
        })
      : {
          v: 1,
          tomb,
          artifact,
          reference: api.controlledCanaryReference(artifact.presentedId),
        };
  if ("mcpServers" in body)
    body.mcpServers.OpenSesameCanary.args = [
      "canary",
      "serve",
      "--config",
      "opensesame-canary.json",
    ];
  check();
  canaryUiPorts.download(
    "opensesame-canary.json",
    JSON.stringify(body, null, 2),
  );
}
